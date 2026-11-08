// The Claude hook's decisions, run the way Claude Code runs it: each case
// pipes one Bash tool call into the built bundle, installed in a temporary
// Claude root with a neutral policy, and reads the decision.

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = join(import.meta.dir, "../dist/hook");
const ALLOW = ["git status *", "git diff *", "rg *", "echo *", "ls *", "wc *", "fd *", "head *"];
// The compiler covers options before a subcommand with one `prog -* sub` hole.
const ASK = ["git push *", "git -* push *"];
const DENY = ["rm *", "find *", "python3 - *", "git clean *", "git -* clean *", "gh api -X POST *", "gh api --method POST *", "git rebase -i *"];
const REASONS = { "rm *": "use trash", "python3 - *": "write a script" };

const CASES: [string, "allow" | "ask" | "deny" | undefined][] = [
  ["git status", "allow"],
  ["for f in a b; do rg -n x $f; done", "allow"],
  ["echo $(git status --short)", "allow"],
  ["(cd extra && ls)", "allow"],
  ["cd extra && rg -n x", "allow"],
  ["cd extra && git status", undefined],
  ["cd / && ls", undefined],
  ["env -u TOKEN rg x", "allow"],
  ["env A=1 rg x", undefined],
  ["timeout -k 5 30 rg x", "allow"],
  ["/usr/bin/time -p rg x", "allow"],
  ["fd x | xargs -n1 wc -l", "allow"],
  ["fd -x wc -l {}", undefined],
  ["rg x 2>&1 | head -5", "allow"],
  ["rg x > out.txt", undefined],
  ["rg x < in.txt", undefined],
  ["PATH=/tmp; git status", undefined],
  ["$program status", undefined],
  ["f() { ls; }; f", undefined],
  ["ls | tee out.txt", undefined],
  ["git push origin main", "ask"],
  ["git -C extra push origin main", "ask"],
  ["fd x | xargs -n1 git push", "ask"],
  ["python3 script.py", undefined],
  ["if true; then", undefined],
  ["if true; then xargs -n1 rm", "deny"],
  ["GIT_EDITOR=true git status", "allow"],
  ["GIT_PAGER=cat git status", undefined],
  ["fd x | xargs -n1 rm", "deny"],
  ["ls > out.txt; xargs -0 rm < list", "deny"],
  ["git -C extra clean -fd", "deny"],
  ["git -c core.pager=cat --no-pager clean -fd", "deny"],
  ["gh api -XPOST repos/x", "deny"],
  ["gh api --method=POST repos/x", "deny"],
  ["git rebase -ix main", "deny"],
  ["rm -rf build", "deny"],
  ["timeout 5 rm build", "deny"],
  ["FOO=1 /bin/rm build", "deny"],
  ["echo $(rm build)", "deny"],
  // tree-sitter-bash leaves this `-` out of the command node.
  ["python3 - <<'EOF'\nprint(1)\nEOF", "deny"],
  ["find . -delete", "deny"],
  ["xargs -n1 git status", "allow"],
  ["env -u HOME timeout 30 git status", "allow"],
];
const DENIALS: Record<string, string> = {
  "rm -rf build": "`rm -rf build` is denied by the shell rules: use trash",
  "timeout 5 rm build": "`rm build` is denied by the shell rules: use trash",
  "FOO=1 /bin/rm build": "`rm build` is denied by the shell rules: use trash",
  "find . -delete": "`find . -delete` is denied by the shell rules",
};

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shell-unwrap-")));
  mkdirSync(join(root, "extra"));
  cpSync(DIST, join(root, "hooks"), { recursive: true });
  const bash = (patterns: string[]) => patterns.map((pattern) => `Bash(${pattern})`);
  const permissions = {
    allow: bash(ALLOW),
    ask: bash(ASK),
    deny: bash(DENY),
    additionalDirectories: [join(root, "extra")],
  };
  writeFileSync(join(root, "settings.json"), JSON.stringify({ permissions }));
  writeFileSync(join(root, "shell-unwrap.json"), JSON.stringify({ reasons: REASONS }));
});

async function hook(tool: string, command: string) {
  const event = { tool_name: tool, tool_input: { command }, cwd: root };
  const run = Bun.spawn(["bun", join(root, "hooks/shell-unwrap.js"), "claude"], {
    stdin: new Blob([JSON.stringify(event)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(run.stdout).text();
  expect(await run.exited).toBe(0);
  return output ? JSON.parse(output).hookSpecificOutput : undefined;
}

describe("claude hook", () => {
  test.each(CASES)("%p → %p", async (command, expected) => {
    const output = await hook("Bash", command.replaceAll("extra", join(root, "extra")));
    expect(output?.permissionDecision).toBe(expected);
    if (command in DENIALS) expect(output?.permissionDecisionReason).toBe(DENIALS[command]);
  });

  test("other tools get no decision", async () => {
    expect(await hook("Read", "git status")).toBeUndefined();
  });

  test("a missing settings file asks, so the guards fail closed", async () => {
    const bare = mkdtempSync(join(tmpdir(), "shell-unwrap-"));
    cpSync(DIST, join(bare, "hooks"), { recursive: true });
    const run = Bun.spawn(["bun", join(bare, "hooks/shell-unwrap.js"), "claude"], {
      stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm x" } })]),
      stdout: "pipe",
    });
    const output = JSON.parse(await new Response(run.stdout).text()).hookSpecificOutput;
    expect(output.permissionDecision).toBe("ask");
    expect(await run.exited).toBe(0);
  });

  test("the bundle exports the peel without reading stdin", async () => {
    const bundle = join(DIST, "shell-unwrap.js");
    const run = Bun.spawn(
      [
        "bun",
        "-e",
        `const m = await import(${JSON.stringify(bundle)}); console.log(JSON.stringify(m.spellings("timeout 5 rm x")))`,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
      },
    );
    expect(JSON.parse(await new Response(run.stdout).text())).toEqual(["rm x"]);
  });
});
