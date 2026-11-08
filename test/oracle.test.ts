// The Claude hook's decisions, checked against what zsh actually runs.
//
// Every case is a denied command hidden by one obfuscation. The hook judges
// it, then zsh runs it with the options Claude Code's agent shell has, in a
// scratch directory whose PATH holds only recording stubs and whose builtins
// are wrapped by recording functions. An allow is sound only when every
// recorded program reaches an allow rule and no deny or ask rule matches it.
// A failure names the case, the run that broke the rule, and the rule.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARY = join(import.meta.dir, "../dist/hook/shell-unwrap");

const ALLOW = [
  "git *",
  "echo *",
  "print *",
  "printf *",
  "read *",
  "set *",
  "test *",
  "true",
  "ls *",
  "cat *",
  "rg *",
  "wc *",
  "touch *",
  "curl *",
  "awk *",
  "jq *",
  "xargs *",
];
const DENY = [
  "git worktree add *",
  "git -* worktree add *",
  "git push --force *",
  "git push * --force *",
  "git push * --force",
  "git -* push * --force *",
  "git*core.pager*",
  "git*-c alias.*",
  "rm *",
  "curl* -K*",
  "*SECRET_TOKEN*",
];
const ASK = ["git clean *", "git -* clean *"];
const SECRET = "s3cr3t-value";
// zsh options of Claude Code's agent shell on macOS that change parsing or
// expansion; everything else is zsh's default.
const AGENT_OPTIONS = "setopt promptsubst autocd interactivecomments nobareglobqual";
const STUBS = ["git", "ls", "cat", "rg", "wc", "touch", "curl", "awk", "jq", "rm", "timeout", "sh"];
const BUILTINS = ["echo", "print", "printf", "read", "test", "true", "cd"];
const WRAPPERS = { env: "/usr/bin/env", nice: "/usr/bin/nice", nohup: "/usr/bin/nohup", xargs: "/usr/bin/xargs" };

// A denied command, the word in it to hide, and how to finish the command.
const TARGETS: [string, string, string][] = [
  ["git worktree", "add", "wt"],
  ["git push", "--force", "origin main"],
  ["git -c", "core.pager=less", "log"],
  ["curl", "-K", "cfg https://example.com"],
  ["git", "clean", "-fd"],
];

const HIDE: Record<string, (word: string) => string | undefined> = {
  plain: (w) => w,
  "double-quoted": (w) => `"${w}"`,
  "single-quoted": (w) => `'${w}'`,
  "split-quotes": (w) => `${w[0]}""${w.slice(1)}`,
  backslashes: (w) => [...w].map((c) => `\\${c}`).join(""),
  "ansi-c": (w) => `$'${w}'`,
  "ansi-c-hex": (w) => `$'${[...w].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join("")}'`,
  default: (w) => `\${X:-${w}}`,
  alternate: (w) => `\${HOME:+${w}}`,
  "cmd-subst": (w) => `$(echo ${w})`,
  backticks: (w) => `\`echo ${w}\``,
  "quoted-subst": (w) => `"$(printf %s ${w})"`,
  brace: (w) => `{${w},}`,
  "glob-question": (w) => (w.length > 1 ? `?${w.slice(1)}` : undefined),
  "glob-bracket": (w) => (w.length > 1 ? `[${w[0]}]${w.slice(1)}` : undefined),
  "zsh-split": (w) => `\${=:-${w}}`,
  "zsh-flag": (w) => `\${(L):-${w}}`,
  "zsh-glob-subst": (w) => `\${~:-${w}}`,
  // A literal start does not keep the word whole when its run-time part splits.
  "prefix-cmd-subst": (w) => `x$(echo ' ${w}')`,
  "prefix-zsh-split": (w) => `x\${=:- ${w}}`,
};

// Ways to set a variable `v` to the word before the command uses `$v`.
const ASSIGN: Record<string, (word: string, command: string) => string> = {
  "for-loop": (w, c) => `for v in ${w}; do ${c}; done`,
  read: (w, c) => `read -r v <<< ${w}; ${c}`,
  "printf-v": (w, c) => `printf -v v %s ${w}; ${c}`,
  "print-v": (w, c) => `print -v v ${w}; ${c}`,
  "pipe-read": (w, c) => `echo ${w} | while read -r v; do ${c}; done`,
  "set-positional": (w, c) => `set -- ${w}; ${c.replace("$v", "$1")}`,
  assignment: (w, c) => `v=${w}; ${c}`,
  "assignment-and": (w, c) => `v=${w} && ${c}`,
  "assignment-skipped": (w, c) => `true || v=status; v=${w}; ${c}`,
  "assignment-twice": (w, c) => `v=status; v=${w}; ${c}`,
  "assignment-subshell": (w, c) => `v=status; (v=${w}; ${c})`,
};

const WRAP: Record<string, (command: string) => string> = {
  timeout: (c) => `timeout 5 ${c}`,
  nice: (c) => `nice ${c}`,
  "env-u": (c) => `env -u FOO ${c}`,
  nohup: (c) => `nohup ${c}`,
  command: (c) => `command ${c}`,
  subshell: (c) => `(${c})`,
  "if-body": (c) => `if true; then ${c}; fi`,
  "and-chain": (c) => `true && ${c}`,
  "print-prompt": (c) => `print -P '$(${c})'`,
  "cmd-subst-arg": (c) => `echo $(${c})`,
  "proc-subst": (c) => `cat <(${c})`,
  "zsh-proc-subst": (c) => `cat =(${c})`,
};

function cases(): [string, string][] {
  const found: [string, string][] = [];
  for (const [before, word, after] of TARGETS) {
    for (const [name, hide] of Object.entries(HIDE)) {
      const hidden = hide(word);
      if (hidden !== undefined) found.push([`${name}: ${word}`, `${before} ${hidden} ${after}`]);
    }
    for (const [name, assign] of Object.entries(ASSIGN)) {
      found.push([`${name}: ${word}`, assign(word, `${before} $v ${after}`)]);
    }
    for (const [name, wrap] of Object.entries(WRAP)) {
      found.push([`${name}: ${word}`, wrap(`${before} ${word} ${after}`)]);
    }
    const tokens = `${before} ${word}`.split(" ");
    const last = tokens.pop()!;
    found.push([`xargs-appends: ${word}`, `echo ${last} ${after} | xargs ${tokens.join(" ")}`]);
    found.push([`xargs-replace: ${word}`, `echo ${word} | xargs -I{} ${before} {} ${after}`]);
  }
  found.push(
    ["program-default: rm", "${X:-rm} -rf x"],
    ["program-quoted: rm", 'r""m -rf x'],
    ["secret: plain", "echo $SECRET_TOKEN"],
    ["secret: split name", "echo ${SECRET_TOK}EN"],
    ["secret: jq env", `jq -n 'env["SECRET_"+"TOKEN"]'`],
    ["secret: loop name", "for v in TOKEN; do jq -n env.SECRET_$v; done"],
    ["state: path loop", "for path in /tmp; do git status; done"],
    ["state: EDITOR read", "read -r EDITOR <<< 'touch pwned'; git commit"],
    ["state: set option", "set -o globsubst; git status"],
    ["state: cd var", "cd $HOME && ls"],
    ["constant: home", "ls $HOME ${HOME}/x"],
    ["constant: user", "git log --author=$USER"],
    ["loop: rebound", "for v in status; do for v in clean; do true; done; git $v -fd; done"],
    ["loop: read", "for v in status; do read -r v <<< clean; git $v -fd; done"],
    ["loop: literal", "for v in status log; do git $v; done"],
  );
  return found;
}

let root: string;
let work: string;
// The variables both the hook and zsh see.
const ENV = () => ({ HOME: join(root, "home"), USER: "oracle", LOGNAME: "oracle", SECRET_TOKEN: SECRET });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shell-unwrap-oracle-")));
  work = join(root, "work");
  const bin = join(root, "bin");
  mkdirSync(work);
  mkdirSync(bin);
  mkdirSync(join(root, "home"));
  // Files a glob could reach: one named after each hidden word.
  for (const [, word] of TARGETS) writeFileSync(join(work, word.replaceAll("/", "_")), "");
  // One printf per record, ending in a record separator, so the records of
  // programs that run at once never interleave.
  const record = `printf '%s\\0' "\${0:t}" "$@" $'\\x1e' >> "$ORACLE_RECORD"`;
  // `cat` reads its files as the real one does, so a process substitution it
  // is given has finished, and recorded, before zsh exits.
  const reads = `for f in "$@"; do [[ -r $f ]] && while IFS= read -r line; do :; done < "$f"; done`;
  const bodies: Record<string, string> = { timeout: `shift\nexec "$@"`, cat: `${reads}\nexit 0` };
  for (const name of STUBS) {
    const body = `${record}\n${bodies[name] ?? "exit 0"}`;
    writeFileSync(join(bin, name), `#!/bin/zsh -f\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  for (const [name, target] of Object.entries(WRAPPERS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${target} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // The hook installed in a Claude root, as coding-agent-sync installs it.
  mkdirSync(join(root, "claude/hooks"), { recursive: true });
  cpSync(BINARY, join(root, "claude/hooks/shell-unwrap"));
  const bash = (patterns: string[]) => patterns.map((pattern) => `Bash(${pattern})`);
  const permissions = { allow: bash(ALLOW), deny: bash(DENY), ask: bash(ASK) };
  writeFileSync(join(root, "claude/settings.json"), JSON.stringify({ permissions }));
});

/** The hook's decision for `script`, run the way Claude Code runs it. */
async function decide(script: string): Promise<string> {
  const event = { tool_name: "Bash", tool_input: { command: script }, cwd: work, permission_mode: "default" };
  const hook = Bun.spawn([join(root, "claude/hooks/shell-unwrap"), "claude"], {
    stdin: new Blob([JSON.stringify(event)]),
    // The environment zsh runs with, as Claude Code's hook and shell share it.
    env: { ...process.env, ...ENV() },
    stdout: "pipe",
  });
  const output = await new Response(hook.stdout).text();
  return output ? JSON.parse(output).hookSpecificOutput.permissionDecision : "abstain";
}

// Claude Code's glob, written here rather than imported, so the oracle does
// not share the hook's matcher: `*` is any text, and a trailing ` *` that is
// the only wildcard also matches the bare command.
function globMatches(pattern: string, text: string): boolean {
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionalTail = pattern.endsWith(" *") && pattern.split("*").length === 2;
  const body = optionalTail ? `${escape(pattern.slice(0, -2))}( .*)?` : pattern.split("*").map(escape).join(".*");
  return new RegExp(`^(?:${body})$`, "s").test(text);
}

// What a program reads its flags as: bundles split and joined values apart.
function readings(argv: string[]): string[] {
  const split = argv.flatMap((arg) => {
    if (/^-[A-Za-z]{2,4}$/.test(arg)) return [...arg.slice(1)].map((letter) => `-${letter}`);
    const joined = /^(--?[A-Za-z][A-Za-z-]*)=(.*)$/s.exec(arg);
    return joined ? [joined[1]!, joined[2]!] : [arg];
  });
  return [argv.join(" "), split.join(" ")];
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every program zsh ran for `script`, as argv lists. */
function run(script: string): string[][] {
  const record = join(root, "record");
  writeFileSync(record, "");
  const functions = BUILTINS.map(
    (name) => `${name}() { builtin printf '%s\\0' ${name} "$@" $'\\x1e' >> "$ORACLE_RECORD"; builtin ${name} "$@"; }`,
  ).join("\n");
  writeFileSync(join(root, "case.zsh"), `${AGENT_OPTIONS}\n${functions}\n${script}\n`);
  Bun.spawnSync(["/bin/zsh", "-f", join(root, "case.zsh")], {
    cwd: work,
    env: { PATH: join(root, "bin"), ORACLE_RECORD: record, ...ENV() },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5000,
  });
  return readFileSync(record, "utf8")
    .split("\x1e\0")
    .filter(Boolean)
    .map((line) => line.split("\0").slice(0, -1));
}

/** Why a recorded run breaks the rules, or undefined when it keeps them. */
function broken(argv: string[]): string | undefined {
  if (argv.some((arg) => arg.includes(SECRET))) return "carries the secret";
  for (const text of readings(argv)) {
    const rule = [...DENY, ...ASK].find((pattern) => globMatches(pattern, text));
    if (rule) return `matches \`${rule}\``;
  }
  const wrapper = /^(timeout|env|nice|nohup|xargs)$/.test(argv[0]!);
  if (!wrapper && !ALLOW.some((pattern) => globMatches(pattern, argv.join(" ")))) return "matches no allow rule";
  return undefined;
}

/** The strictest rule a recorded run meets. */
function guard(argv: string[]): "deny" | "ask" | undefined {
  const texts = readings(argv);
  if (argv.some((arg) => arg.includes(SECRET))) return "deny";
  if (DENY.some((pattern) => texts.some((text) => globMatches(pattern, text)))) return "deny";
  if (ASK.some((pattern) => texts.some((text) => globMatches(pattern, text)))) return "ask";
  return undefined;
}

/**
 * Whether what zsh ran bears a deny or ask out: some run meets the rule, or,
 * for a rule about the text itself (`*SECRET_TOKEN*`), the script names it.
 */
function confirmed(decision: string, script: string, runs: string[][]): boolean {
  const met = runs.map(guard);
  if (decision === "deny") {
    return met.includes("deny") || DENY.some((pattern) => pattern.startsWith("*") && globMatches(pattern, script));
  }
  return met.includes("ask") || met.includes("deny");
}

// SHELL_UNWRAP_AUDIT=1 prints every case's decision and what zsh ran.
const audit: string[] = [];

describe("decisions checked against zsh", () => {
  test.each(cases())("%s", async (name, script) => {
    const decision = await decide(script);
    const runs = run(script);
    const violations = runs.flatMap((argv) => {
      const why = broken(argv);
      return why ? [`\`${argv.join(" ")}\` ${why}`] : [];
    });
    const unconfirmed = (decision === "deny" || decision === "ask") && !confirmed(decision, script, runs);
    // An allow whose run breaks a rule is unsafe; a deny or ask no run bears
    // out is unconfirmed; an undecided case shows what its hidden command did.
    const guarded = decision === "deny" || decision === "ask";
    const mark = guarded
      ? unconfirmed
        ? "UNCONF"
        : ""
      : violations.length
        ? decision === "allow"
          ? "UNSAFE"
          : "hidden"
        : "";
    audit.push(`${decision.padEnd(7)} ${mark.padEnd(6)} ${name.padEnd(28)} ${script}`);
    if (decision === "allow") expect(violations).toEqual([]);
    if (decision === "deny" || decision === "ask")
      expect({ script, unconfirmed }).toEqual({ script, unconfirmed: false });
  });

  afterAll(() => {
    if (process.env.SHELL_UNWRAP_AUDIT) console.log(audit.sort().join("\n"));
  });
});
