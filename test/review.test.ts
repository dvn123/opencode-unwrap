import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import { explain, review, type Evaluation } from "../src/review.ts"
import { match } from "../src/rules.ts"

const RULES: Permission.Ruleset = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "./gradlew *", effect: "allow" },
  { action: "shell", resource: "git status *", effect: "allow" },
  { action: "shell", resource: "bq *", effect: "allow" },
  { action: "shell", resource: "bq cp *", effect: "ask" },
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

  // Only transparent wrappers carry an allow; a path, an assignment, or a
  // wrapper that changes the command, its arguments, or its user does not.
  test.each([
    ["./gradlew build", "allow", "allow"],
    ["timeout 30 git status", "ask", "allow"],
    ["timeout -k 5 --foreground 30 git status -s", "ask", "allow"],
    ["/usr/bin/time -p nice -n 5 nohup git status", "ask", "allow"],
    ["timeout 30 bq cp a b", "ask", "ask"],
    ["timeout 30 unknown", "ask", "ask"],
    ["time -o out git status", "ask", "ask"],
    ["/tmp/timeout 30 git status", "ask", "ask"],
    ["xargs git status", "ask", "ask"],
    ["FOO=1 git status", "ask", "ask"],
    ["env timeout 30 git status", "ask", "ask"],
  ] as const)("judges %s from %s to %s", async (command, effect, expected) => {
    expect(await judged(command, effect)).toEqual({ effect: expected, message: undefined, loads: 1 })
  })

  test("allows only when every resource passes", async () => {
    const event: Evaluation = { action: "shell", resources: ["timeout 30 git status", "unknown"], effect: "ask" }
    await review(event, async () => RULES)
    expect(event.effect).toBe("ask")
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

describe("reasons", () => {
  const REASONS = { "rm *": "use `trash`" }

  async function reasoned(command: string, effect: Permission.Effect) {
    const event: Evaluation = { action: "shell", resources: [command], effect }
    await review(event, async () => RULES, REASONS)
    return { effect: event.effect, message: event.message }
  }

  test("names the reason for a peeled deny", async () => {
    expect(await reasoned("timeout 30 rm -rf x", "allow")).toEqual({
      effect: "deny",
      message: "`rm -rf x` is denied by the shell rules: use `trash`",
    })
  })

  // OpenCode's own denies reach the plugin only as a failed call.
  test.each([
    [["rm -rf x"], "`rm -rf x`: use `trash`"],
    [["git status", "rm x"], "`rm x`: use `trash`"],
    [["git status"], undefined],
  ])("explains %p", (resources, expected) => {
    expect(explain(resources, RULES, REASONS)).toBe(expected)
  })

  // Only the deciding rule's reason applies.
  test("names no reason a deny rule does not carry", () => {
    expect(explain(["rm -rf x"], RULES, { "git status *": "unused" })).toBeUndefined()
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
