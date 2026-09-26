import { spellings } from "./peel.ts"
import type { Permission } from "@opencode/schema/permission"
import { evaluate } from "./rules.ts"

export interface Evaluation {
  readonly action: string
  readonly resources: readonly string[]
  effect: Permission.Effect
  message?: string
}

/**
 * Denies a shell command when the rules deny any spelling peeled from it, so
 * a wrapped command is never looser than the denied command it runs. Only a
 * deny carries over: a peeled spelling that no narrower rule covers falls to
 * the catch-all, and `./gradlew` must not inherit the catch-all's `ask` as
 * `gradlew`. Rules load only when there is something to peel.
 */
export async function review(event: Evaluation, rules: () => Promise<Permission.Ruleset>): Promise<void> {
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
    event.message = `\`${denied}\` is denied by the shell rules`
  }
}
