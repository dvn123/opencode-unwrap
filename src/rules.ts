/**
 * OpenCode's rule evaluation, ported so a peeled spelling is judged exactly as
 * OpenCode judges a command: `Wildcard.match` and the last-match-wins
 * `Permission.evaluate` from OpenCode 2.0.18.
 */

import type { Permission } from "@opencode/schema/permission"

const compiled = new Map<string, RegExp>()

export function match(input: string, pattern: string): boolean {
  let regex = compiled.get(pattern)
  if (!regex) {
    let escaped = pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
    regex = new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s")
    compiled.set(pattern, regex)
  }
  return regex.test(input.replaceAll("\\", "/"))
}

/** The rule that decides `resource`: the last one matching. */
export function matching(rules: Permission.Ruleset, action: string, resource: string): Permission.Rule | undefined {
  return rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))
}

export function evaluate(rules: Permission.Ruleset, action: string, resource: string): Permission.Effect {
  return matching(rules, action, resource)?.effect ?? "ask"
}
