import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import { review, type Evaluation } from "../src/review.ts"
import { match } from "../src/rules.ts"

const RULES: Permission.Ruleset = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "./gradlew *", effect: "allow" },
  { action: "shell", resource: "git status *", effect: "allow" },
  { action: "shell", resource: "rm *", effect: "deny" },
]

async function judged(command: string, effect: Permission.Effect, action = "shell") {
  const event: Evaluation = { action, resources: [command], effect }
  let loads = 0
  await review(event, async () => {
    loads++
    return RULES
  })
  return { effect: event.effect, message: event.message, loads }
}

describe("review", () => {
  test("denies a command whose peeled spelling is denied", async () => {
    expect(await judged("timeout 30 rm -rf x", "allow")).toEqual({
      effect: "deny",
      message: "`rm -rf x` is denied by the shell rules",
      loads: 1,
    })
  })

  // `gradlew` falls to the catch-all ask, and `git status` is allowed; only a
  // deny carries over from a peeled spelling.
  test.each([
    ["./gradlew build", "allow"],
    ["timeout 30 git status", "ask"],
  ] as const)("keeps %s at %s", async (command, effect) => {
    expect(await judged(command, effect)).toEqual({ effect, message: undefined, loads: 1 })
  })

  test("loads no rules when there is nothing to peel", async () => {
    expect(await judged("git status", "allow")).toEqual({ effect: "allow", message: undefined, loads: 0 })
  })

  test("ignores other actions", async () => {
    expect(await judged("timeout 30 rm -rf x", "allow", "read")).toEqual({
      effect: "allow",
      message: undefined,
      loads: 0,
    })
  })

  test("fails closed when the rules cannot load", async () => {
    const event: Evaluation = { action: "shell", resources: ["nohup rm -rf x"], effect: "allow" }
    await review(event, async () => {
      throw new Error("offline")
    })
    expect(event).toEqual({
      action: "shell",
      resources: ["nohup rm -rf x"],
      effect: "deny",
      message: "opencode-unwrap could not load the shell rules: offline",
    })
  })
})

// OpenCode's `Wildcard.match`, ported.
test.each([
  ["rm *", "rm", true],
  ["rm *", "rm -rf x", true],
  ["rm *", "rmdir x", false],
  ["git * push *", "git -C repo push origin", true],
  ["a?c", "abc", true],
  ["*.env", "dir\\.env", true],
])("%s against %s is %p", (pattern, input, expected) => {
  expect(match(input, pattern)).toBe(expected)
})
