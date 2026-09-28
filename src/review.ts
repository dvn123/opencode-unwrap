import { spellings, transparent } from "./peel.ts"
import type { Permission } from "@opencode/schema/permission"
import { evaluate, matching } from "./rules.ts"

export interface Evaluation {
  readonly action: string
  readonly resources: readonly string[]
  effect: Permission.Effect
  message?: string
}

/** Why a shell deny rule exists, by the rule's exact `resource` pattern. */
export type Reasons = Readonly<Record<string, string>>

/**
 * Denies a shell command when the rules deny any spelling peeled from it, so
 * a wrapped command is never looser than the denied command it runs. The deny
 * names the reason its rule carries. Otherwise an asked command is allowed when
 * every resource reaches an allow through transparent wrappers only
 * (`timeout 30 git status`); program paths, assignments, and wrappers that
 * change the command, its arguments, or its user never carry an allow, so
 * `./gradlew` does not inherit anything from `gradlew`. Rules load only when
 * there is something to peel.
 */
export async function review(
  event: Evaluation,
  rules: () => Promise<Permission.Ruleset>,
  reasons: Reasons = {},
): Promise<void> {
  if (event.action !== "shell" || event.effect === "deny") return
  const peeled = event.resources.flatMap(spellings)
  if (peeled.length === 0) return
  let loaded: Permission.Ruleset
  try {
    loaded = await rules()
  } catch (cause) {
    event.effect = "deny"
    event.message = `opencode-unwrap could not load the shell rules: ${cause instanceof Error ? cause.message : cause}`
    return
  }
  const denied = peeled.find((spelling) => evaluate(loaded, "shell", spelling) === "deny")
  if (denied) {
    event.effect = "deny"
    event.message = denial(denied, because(loaded, denied, reasons))
  } else if (event.effect === "ask" && event.resources.every((resource) => passes(loaded, resource))) {
    event.effect = "allow"
  }
}

/**
 * Whether `command` is allowed outright, or reaches an allow rule through
 * transparent wrappers alone. Only the catch-all is looked through: a narrower
 * rule that matches a spelling on the way decides it, so an ask written for
 * `timeout * bq cp` still asks.
 */
function passes(rules: Permission.Ruleset, command: string): boolean {
  if (evaluate(rules, "shell", command) === "allow") return true
  for (let spelling: string | undefined = command; spelling !== undefined; spelling = transparent(spelling)) {
    const rule = matching(rules, "shell", spelling)
    if (rule && rule.resource !== "*") return rule.effect === "allow"
  }
  return false
}

/**
 * The reason for a shell command OpenCode's own rules denied. OpenCode runs
 * `permission.evaluate` only for what its rules did not deny, and answers the
 * rest with a bare "Permission denied", so this reads the blocked call's
 * resources and deciding rules instead: the first resource whose deciding
 * rule carries a reason names it.
 */
export function explain(
  resources: readonly string[],
  rules: Permission.Ruleset,
  reasons: Reasons,
): string | undefined {
  for (const resource of resources) {
    const reason = because(rules, resource, reasons)
    if (reason) return `\`${resource}\`: ${reason}`
  }
  return undefined
}

function because(rules: Permission.Ruleset, resource: string, reasons: Reasons): string | undefined {
  const rule = matching(rules, "shell", resource)
  return rule?.effect === "deny" ? reasons[rule.resource] : undefined
}

function denial(command: string, reason: string | undefined): string {
  return `\`${command}\` is denied by the shell rules` + (reason ? `: ${reason}` : "")
}
