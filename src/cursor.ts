/**
 * Cursor `beforeShellExecution` hook.
 *
 * Cursor Desktop's `terminalAllowlist` has no deny or ask channel, so a broad
 * allow such as `git` would also allow the `git push --force` a deny forbids.
 * This hook carries those guards: it parses the command and judges every
 * command inside it, peeled as the Claude hook peels it.
 *
 * - It denies the command when any spelling of one matches a deny rule,
 *   naming the rule's reason.
 * - It asks when any spelling of one matches an ask rule, or when it cannot
 *   parse the command or read its rules: the guards fail closed.
 * - Otherwise it prints `{}`, which leaves the command to Cursor's allowlist.
 *
 * Cursor never reads an `allow` from this hook as approval, so the hook only
 * adds prompts and refusals. The bundle sits in `~/.cursor/hooks/` beside
 * `shell-unwrap.json`, which holds the rules as Claude Code `Bash(...)`
 * entries under `permissions` and their reasons under `reasons`.
 */

import { join } from "node:path";
import { MAX_COMMAND, buildRules, commands, denied, matching, type Rules } from "./claude.ts";
import { spellings } from "./peel.ts";
import { readReasons } from "./review.ts";

export { spellings, transparent } from "./peel.ts";

const RULES = join(import.meta.dir, "shell-unwrap.json");

export interface Verdict {
  readonly permission: "deny" | "ask";
  readonly user_message: string;
  readonly agent_message: string;
}

function verdict(permission: Verdict["permission"], message: string): Verdict {
  return { permission, user_message: message, agent_message: message };
}

export async function loadRules(path: string): Promise<Rules> {
  const file = await Bun.file(path).json();
  return buildRules(file.permissions ?? {}, await readReasons(path));
}

/** The hook's verdict, or undefined to leave the command to Cursor. */
export async function decide(script: string, rules: Rules): Promise<Verdict | undefined> {
  if (script.length > MAX_COMMAND) return verdict("ask", "shell-unwrap: the command is too long to check");
  let found: string[];
  try {
    found = await commands(script, false);
  } catch {
    return verdict("ask", "shell-unwrap: the command could not be parsed");
  }
  for (const command of found) {
    const message = denied(rules, command);
    if (message) return verdict("deny", message);
  }
  for (const command of found) {
    for (const spelling of [command, ...spellings(command)]) {
      if (matching(rules.ask, spelling).length > 0)
        return verdict("ask", `shell-unwrap: \`${spelling}\` needs approval`);
    }
  }
  return undefined;
}

export async function main(): Promise<void> {
  let output: Verdict | undefined;
  try {
    const event = await Bun.stdin.json();
    const script = event?.command;
    output =
      typeof script === "string"
        ? await decide(script, await loadRules(RULES))
        : verdict("ask", "shell-unwrap: the hook received no command");
  } catch {
    output = verdict("ask", "shell-unwrap: the hook failed");
  }
  process.stdout.write(JSON.stringify(output ?? {}));
}
