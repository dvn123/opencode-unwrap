/**
 * Claude Code PreToolUse hook for Bash.
 *
 * Claude Code matches an allow rule only against a flat command: a loop, a
 * command substitution, a subshell, or a wrapper with options prompts even
 * when every program inside it is allowed, and a deny rule's reason never
 * reaches the model. This hook parses the command and judges each command
 * inside it with the OpenCode plugin's peel:
 *
 * - it denies the command when any peeled spelling of one matches a deny
 *   rule, naming the rule's reason in the plugin's words;
 * - it allows the command when every command inside it reaches an allow rule
 *   through transparent wrappers alone.
 *
 * Claude Code still evaluates its own deny and ask rules after a hook allows,
 * so the hook can only remove a prompt, never lift a guard. Anything it does
 * not model, it leaves to Claude: it prints nothing, including on any error.
 *
 * The bundle, with tree-sitter's WASM embedded, sits in `<claude root>/hooks/`;
 * the rules and reasons are read from the root.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import { basename, spellings, transparent, words } from "./peel.ts";
import { denial, readReasons, type Reasons } from "./review.ts";
import { base64 } from "./wasm.ts" with { type: "macro" };

export { spellings, transparent } from "./peel.ts";

const ROOT = resolve(import.meta.dir, "..");
const REASONS = "shell-unwrap.json";
// Claude Code prompts for a command it cannot fully analyse.
export const MAX_COMMAND = 10_000;
const ALLOWED = "shell-unwrap: every command matches an allow rule";

// Commands Claude Code prompts for even under a matching allow rule, or whose
// arguments run, write, or delete by themselves.
const FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
  "-files0-from",
]);
const FD_ACTIONS = new Set(["-x", "-X", "--exec", "--exec-batch"]);
const NEVER_ALLOWED = new Set(["tee", "watch", "setsid", "ionice", "flock", "pushd"]);
// Variables that change how later commands resolve or run.
const SPECIAL = new Set(["PATH", "IFS", "CDPATH", "ENV", "BASH_ENV", "HOME", "SHELL"]);
const DYNAMIC = new Set(["command_substitution", "simple_expansion", "expansion", "process_substitution"]);

export interface Rule {
  readonly pattern: string;
  readonly reason?: string;
}

/** Rules by the literal first word of their pattern; `null` holds the rest. */
type Bucket = Map<string | null, Rule[]>;

export interface Rules {
  readonly allow: Bucket;
  readonly ask: Bucket;
  readonly deny: Bucket;
  readonly directories: readonly string[];
}

export interface Decision {
  readonly permissionDecision: "allow" | "deny";
  readonly permissionDecisionReason: string;
}

const compiled = new Map<string, RegExp>();

/**
 * Claude Code's Bash glob: `*` matches any text, and a trailing ` *` that is
 * the rule's only wildcard also matches the bare command.
 */
export function toRegex(glob: string): RegExp {
  let regex = compiled.get(glob);
  if (!regex) {
    const pattern = glob.endsWith(":*") ? `${glob.slice(0, -2)} *` : glob;
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const optionalTail = pattern.endsWith(" *") && pattern.split("*").length === 2;
    const body = optionalTail ? `${escape(pattern.slice(0, -2))}( .*)?` : pattern.split("*").map(escape).join(".*");
    regex = new RegExp(`^(?:${body})$`, "s");
    compiled.set(glob, regex);
  }
  return regex;
}

function head(glob: string): string | null {
  const first = glob.split(" ", 1)[0]!;
  return first.includes("*") ? null : first;
}

function bashPatterns(entries: readonly unknown[]): string[] {
  return entries.flatMap((entry) => {
    if (entry === "Bash") return ["*"];
    if (typeof entry === "string" && entry.startsWith("Bash(") && entry.endsWith(")")) return [entry.slice(5, -1)];
    return [];
  });
}

/** A path with `~` expanded and symlinks resolved as far as it exists. */
function real(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const absolute = resolve(expanded);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return realpathSync(existing) + absolute.slice(existing.length);
}

export function buildRules(permissions: Record<string, unknown>, reasons: Reasons): Rules {
  const bucket = (decision: string): Bucket => {
    const found: Bucket = new Map();
    const entries = permissions[decision];
    for (const pattern of bashPatterns(Array.isArray(entries) ? entries : [])) {
      const key = head(pattern);
      const rules = found.get(key) ?? [];
      rules.push({ pattern, reason: reasons[pattern] });
      found.set(key, rules);
    }
    return found;
  };
  const directories = permissions.additionalDirectories;
  return {
    allow: bucket("allow"),
    ask: bucket("ask"),
    deny: bucket("deny"),
    directories: (Array.isArray(directories) ? directories : []).filter((d) => typeof d === "string").map(real),
  };
}

async function loadRules(root: string): Promise<Rules> {
  const settings = await Bun.file(join(root, "settings.json")).json();
  return buildRules(settings.permissions ?? {}, await readReasons(join(root, REASONS)));
}

export function matching(bucket: Bucket, text: string): Rule[] {
  const word = text.split(" ", 1)[0]!;
  return [...(bucket.get(word) ?? []), ...(bucket.get(null) ?? [])].filter((rule) => toRegex(rule.pattern).test(text));
}

/** Leave the decision to Claude Code. */
export class Abstain extends Error {}

let parser: Parser | undefined;

async function bash(): Promise<Parser> {
  if (!parser) {
    await Parser.init({ wasmBinary: Uint8Array.fromBase64(base64("web-tree-sitter/tree-sitter.wasm")) });
    const created = new Parser();
    created.setLanguage(await Language.load(Uint8Array.fromBase64(base64("tree-sitter-bash/tree-sitter-bash.wasm"))));
    parser = created;
  }
  return parser;
}

/**
 * Where the command's text ends: at its statement's first redirect.
 * tree-sitter-bash leaves some words out of the command node, such as the `-`
 * in `python3 - <<EOF`, but they still sit before the redirect.
 */
function end(node: Node): number {
  const parent = node.parent;
  if (parent?.type === "redirected_statement") {
    const starts = parent.namedChildren
      .filter((child): child is Node => child !== null && child.startIndex >= node.endIndex)
      .map((child) => child.startIndex);
    if (starts.length > 0) return Math.min(...starts);
  }
  return node.endIndex;
}

/** One simple command's text, as Claude Code matches it. */
function command(node: Node, source: string): string {
  const name = node.childForFieldName("name");
  if (!name) throw new Abstain("assignment only");
  const inner = name.namedChildren[0] ?? name;
  if (DYNAMIC.has(inner.type) || inner.namedChildren.some((child) => child && DYNAMIC.has(child.type))) {
    throw new Abstain("dynamic program");
  }
  return source.slice(node.startIndex, end(node)).trim();
}

function checkRedirect(node: Node): void {
  if (node.type === "heredoc_redirect" || node.type === "herestring_redirect") return;
  const target = node.childForFieldName("destination")?.text ?? "";
  if (target === "/dev/null" || /^&?(\d+|-)$/.test(target)) return;
  if (node.children.some((child) => child?.type === "file_descriptor") && /^(\d+|-)$/.test(target)) return;
  throw new Abstain("redirect to a file");
}

/**
 * The simple commands in `script`, or Abstain for anything not modelled.
 * With `strict` off it abstains only on a script it cannot parse, and skips
 * what it cannot judge: a guard needs every command, not a reason to allow.
 */
export async function commands(script: string, strict = true): Promise<string[]> {
  const tree = (await bash()).parse(script);
  if (!tree || tree.rootNode.hasError) throw new Abstain("unparseable");
  const found: string[] = [];
  const stack: Node[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "function_definition":
      case "declaration_command":
      case "unset_command":
        if (strict) throw new Abstain(node.type);
        break;
      case "variable_assignment":
      case "variable_assignments":
        if (strict && node.parent && node.parent.type !== "command") throw new Abstain("shell variable assignment");
        break;
      case "file_redirect":
      case "heredoc_redirect":
      case "herestring_redirect":
        if (strict) checkRedirect(node);
        break;
      case "for_statement": {
        const variable = node.childForFieldName("variable");
        if (strict && variable && SPECIAL.has(variable.text)) throw new Abstain("loop over a special variable");
        break;
      }
      case "command":
        try {
          found.push(command(node, script));
        } catch (error) {
          if (strict || !(error instanceof Abstain)) throw error;
        }
        break;
    }
    stack.push(...node.namedChildren.filter((child): child is Node => child !== null).reverse());
  }
  return found;
}

/** The denial for the first of `command`'s spellings a deny rule matches. */
export function denied(rules: Rules, command: string): string | undefined {
  for (const spelling of [command, ...spellings(command)]) {
    const found = matching(rules.deny, spelling);
    if (found.length > 0) return denial(spelling, found.find((rule) => rule.reason)?.reason);
  }
  return undefined;
}

/**
 * Whether the program runs, writes, or deletes by its own arguments in a way
 * Claude Code prompts for even under a matching allow.
 */
function runsItself(spelling: string): boolean {
  const [program = "", ...rest] = words(spelling).map((word) => word.value);
  const options = new Set(rest.map((argument) => argument.split("=", 1)[0]!));
  const name = basename(program);
  return (
    NEVER_ALLOWED.has(name) ||
    (name === "find" && [...options].some((option) => FIND_ACTIONS.has(option))) ||
    (name === "fd" && [...options].some((option) => FD_ACTIONS.has(option)))
  );
}

/**
 * Whether `command` reaches an allow rule, peeling only transparent wrappers;
 * an ask or deny met on the way decides instead, as in the OpenCode review.
 */
function passes(rules: Rules, command: string): boolean {
  for (let spelling: string | undefined = command; spelling !== undefined; spelling = transparent(spelling)) {
    if (matching(rules.deny, spelling).length > 0 || matching(rules.ask, spelling).length > 0) return false;
    if (runsItself(spelling)) return false;
    if (matching(rules.allow, spelling).length > 0) return true;
  }
  return false;
}

function inside(target: string, directories: readonly string[]): boolean {
  return directories.some((root) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/** A PreToolUse decision, or undefined to leave the command to Claude Code. */
export async function decide(script: string, cwd: string, rules: Rules): Promise<Decision | undefined> {
  if (script.length > MAX_COMMAND) return undefined;
  let found: string[];
  try {
    found = await commands(script);
  } catch (error) {
    if (error instanceof Abstain) return undefined;
    throw error;
  }
  if (found.length === 0) return undefined;
  for (const command of found) {
    const message = denied(rules, command);
    if (message) return { permissionDecision: "deny", permissionDecisionReason: message };
  }
  const directories = [real(cwd), ...rules.directories];
  const split = found.map((command) => words(command).map((word) => word.value));
  const names = new Set(split.filter((parts) => parts.length > 0).map((parts) => basename(parts[0]!)));
  let working = cwd;
  for (const [index, command] of found.entries()) {
    const parts = split[index]!;
    if (parts[0] === "cd") {
      if (names.has("git") || parts.length !== 2) return undefined;
      const target = parts[1]!;
      const next = real(target.startsWith("~") ? target : resolve(working, target));
      if (!inside(next, directories)) return undefined;
      working = next;
    } else if (!passes(rules, command)) {
      return undefined;
    }
  }
  return { permissionDecision: "allow", permissionDecisionReason: ALLOWED };
}

export async function main(): Promise<void> {
  let decision: Decision | undefined;
  try {
    const event = await Bun.stdin.json();
    if (event?.tool_name !== "Bash") return;
    const script = event.tool_input?.command;
    if (typeof script !== "string") return;
    decision = await decide(script, event.cwd || process.cwd(), await loadRules(ROOT));
  } catch {
    // Any failure falls back to Claude Code's own flow.
    return;
  }
  if (decision) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }));
  }
}
