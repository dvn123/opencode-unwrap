/**
 * Codex `PreToolUse` hook for Bash, which the Pi extension also runs.
 *
 * Codex prefix rules match a literal argv prefix and hold no text rule, so a
 * guard misses a wrapped, bundled or joined spelling, and every text rule
 * falls away. This hook denies a command when any peeled spelling of a command
 * inside it matches a deny rule, naming the rule's reason, and denies when it
 * cannot read its rules or fails, so its guards fail closed.
 *
 * It only denies. Codex rejects an `ask` from this hook, so asks stay native
 * prefix rules, and Pi's permission system already asks for a command behind a
 * wrapper it does not know. The bundle sits beside `shell-unwrap.json`, which
 * holds the deny rules as Claude Code `Bash(...)` entries under `permissions`
 * and their reasons under `reasons`.
 */

import { join } from "node:path";
import { denied, guarded, type Rules } from "./claude.ts";
import { loadRules } from "./cursor.ts";

const RULES = join(import.meta.dir, "shell-unwrap.json");
const FAILED = "shell-unwrap: the hook failed, so its guards were not checked";

/** The reason to deny the script, or undefined to leave it to the host. */
export async function decide(script: string, rules: Rules): Promise<string | undefined> {
  for (const command of await guarded(script)) {
    const message = denied(rules, command);
    if (message) return message;
  }
  return undefined;
}

export async function main(): Promise<void> {
  let reason: string | undefined;
  try {
    const event = await Bun.stdin.json();
    const script = event?.tool_input?.command;
    if (event?.tool_name !== "Bash" || typeof script !== "string") return;
    reason = await decide(script, await loadRules(RULES));
  } catch {
    reason = FAILED;
  }
  if (reason) {
    const output = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
  }
}
