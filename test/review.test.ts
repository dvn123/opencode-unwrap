import { describe, expect, test } from "bun:test";
import type { Permission } from "@opencode/schema/permission";
import { join } from "node:path";
import { type Evaluation, explain, review } from "../src/opencode.ts";

// The plugin asks the built binary, as it does once installed.
const BINARY = join(import.meta.dir, "../dist/hook/shell-unwrap");

const RULES: Permission.Ruleset = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "./gradlew *", effect: "allow" },
  { action: "shell", resource: "git status *", effect: "allow" },
  { action: "shell", resource: "make check", effect: "allow" },
  { action: "shell", resource: "bq *", effect: "allow" },
  { action: "shell", resource: "bq cp *", effect: "ask" },
  { action: "shell", resource: "rm *", effect: "deny" },
];

async function judged(command: string, effect: Permission.Effect, action = "shell") {
  const event: Evaluation = { action, resources: [command], effect };
  let loads = 0;
  const rules = async () => {
    loads++;
    return RULES;
  };
  await review(event, rules, {}, BINARY);
  return { effect: event.effect, message: event.message, loads };
}

describe("review", () => {
  test("denies a command whose peeled spelling is denied", async () => {
    expect(await judged("timeout 30 rm -rf x", "allow")).toEqual({
      effect: "deny",
      message: "`rm -rf x` is denied by the shell rules",
      loads: 1,
    });
  });

  // Only transparent wrappers carry an allow; a path, an assignment, or a
  // wrapper that changes the command, its user, or its environment does not.
  // `xargs` adds arguments, so only a rule that accepts more carries it.
  test.each([
    ["./gradlew build", "allow", "allow"],
    ["timeout 30 git status", "ask", "allow"],
    ["timeout -k 5 --foreground 30 git status -s", "ask", "allow"],
    ["/usr/bin/time -p nice -n 5 nohup git status", "ask", "allow"],
    ["timeout 30 bq cp a b", "ask", "ask"],
    ["timeout 30 unknown", "ask", "ask"],
    ["time -o out git status", "ask", "ask"],
    ["/tmp/timeout 30 git status", "ask", "ask"],
    ["xargs -n1 git status", "ask", "allow"],
    ["xargs make check", "ask", "ask"],
    ["FOO=1 git status", "ask", "ask"],
    ["env -u HOME timeout 30 git status", "ask", "allow"],
    ["env FOO=1 git status", "ask", "ask"],
    ["GIT_EDITOR=true git status", "ask", "allow"],
    ["COLUMNS=200 git status", "ask", "allow"],
    // An ask reached through a peel asks, however the raw text was judged.
    ["xargs -n1 bq cp a b", "allow", "ask"],
    ["xargs -n1 bq ls", "allow", "allow"],
    // An allow is carried only where zsh fixes every word, and zsh's reading,
    // quoting removed, meets the rules too.
    ["timeout 30 git status $X", "ask", "ask"],
    ["timeout 30 git status $(ls)", "ask", "ask"],
    ['bq "cp" a b', "allow", "ask"],
  ] as const)("judges %s from %s to %s", async (command, effect, expected) => {
    expect(await judged(command, effect)).toEqual({ effect: expected, message: undefined, loads: 1 });
  });

  test("allows only when every resource passes", async () => {
    const event: Evaluation = { action: "shell", resources: ["timeout 30 git status", "unknown"], effect: "ask" };
    await review(event, async () => RULES, {}, BINARY);
    expect(event.effect).toBe("ask");
  });

  test("loads no rules when there is nothing to peel", async () => {
    expect(await judged("git status", "allow")).toEqual({ effect: "allow", message: undefined, loads: 0 });
  });

  test("ignores other actions", async () => {
    expect(await judged("timeout 30 rm -rf x", "allow", "read")).toEqual({
      effect: "allow",
      message: undefined,
      loads: 0,
    });
  });

  test("fails closed when the rules cannot load", async () => {
    const event: Evaluation = { action: "shell", resources: ["nohup rm -rf x"], effect: "allow" };
    const offline = async (): Promise<Permission.Ruleset> => {
      throw new Error("offline");
    };
    await review(event, offline, {}, BINARY);
    expect(event).toEqual({
      action: "shell",
      resources: ["nohup rm -rf x"],
      effect: "deny",
      message: "shell-unwrap could not load the shell rules: offline",
    });
  });
});

describe("reasons", () => {
  const REASONS = { "rm *": "use `trash`" };

  async function reasoned(command: string, effect: Permission.Effect) {
    const event: Evaluation = { action: "shell", resources: [command], effect };
    await review(event, async () => RULES, REASONS, BINARY);
    return { effect: event.effect, message: event.message };
  }

  test("names the reason for a peeled deny", async () => {
    expect(await reasoned("timeout 30 rm -rf x", "allow")).toEqual({
      effect: "deny",
      message: "`rm -rf x` is denied by the shell rules: use `trash`",
    });
  });

  // OpenCode's own denies reach the plugin only as a failed call.
  test.each([
    [["rm -rf x"], "`rm -rf x`: use `trash`"],
    [["git status", "rm x"], "`rm x`: use `trash`"],
    [["git status"], undefined],
  ])("explains %p", async (resources, expected) => {
    expect(await explain(resources, RULES, REASONS, BINARY)).toBe(expected);
  });

  // Only the deciding rule's reason applies.
  test("names no reason a deny rule does not carry", async () => {
    expect(await explain(["rm -rf x"], RULES, { "git status *": "unused" }, BINARY)).toBeUndefined();
  });
});
