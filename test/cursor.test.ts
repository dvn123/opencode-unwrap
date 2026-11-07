// The Cursor hook's verdicts, run the way Cursor runs it: each case pipes one
// `beforeShellExecution` event into the built bundle, installed in a temporary
// hooks directory beside its rules, and reads the verdict.

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = join(import.meta.dir, "../dist/cursor");
const ASK = ["git push *"];
const DENY = ["rm *", "git worktree add *"];
const REASONS = { "rm *": "use trash" };

const CASES: [string, "deny" | "ask" | undefined][] = [
  ["git status", undefined],
  ["git push origin main", "ask"],
  ["git -C repo status && git push", "ask"],
  ["timeout 5 git push", "ask"],
  ["rm -rf build", "deny"],
  ["FOO=1 /bin/rm build", "deny"],
  ["echo $(rm build)", "deny"],
  ["git worktree add ../x", "deny"],
  // Shapes the Claude hook leaves alone still have every command judged.
  ["f() { rm x; }; f", "deny"],
  ["export A=1; rm x", "deny"],
  ["rg x > out.txt", undefined],
  ["rm x > out.txt", "deny"],
  ["$program status", undefined],
  ["if true; then", "ask"],
];

let plugin: string;

beforeAll(() => {
  plugin = mkdtempSync(join(tmpdir(), "shell-unwrap-cursor-"));
  cpSync(DIST, plugin, { recursive: true });
  const bash = (patterns: string[]) => patterns.map((pattern) => `Bash(${pattern})`);
  writeFileSync(
    join(plugin, "shell-unwrap.json"),
    JSON.stringify({ permissions: { ask: bash(ASK), deny: bash(DENY) }, reasons: REASONS }),
  );
});

async function hook(root: string, event: unknown) {
  const run = Bun.spawn(["bun", join(root, "shell-unwrap.js")], {
    stdin: new Blob([JSON.stringify(event)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(run.stdout).text();
  expect(await run.exited).toBe(0);
  return JSON.parse(output);
}

describe("cursor hook", () => {
  test.each(CASES)("%p → %p", async (command, expected) => {
    const output = await hook(plugin, { command, cwd: plugin, hook_event_name: "beforeShellExecution" });
    expect(output.permission).toBe(expected);
  });

  test("a deny names its rule's reason", async () => {
    const output = await hook(plugin, { command: "rm x" });
    expect(output.user_message).toContain("use trash");
    expect(output.agent_message).toBe(output.user_message);
  });

  test("missing rules ask rather than drop the guards", async () => {
    const bare = mkdtempSync(join(tmpdir(), "shell-unwrap-cursor-"));
    cpSync(DIST, bare, { recursive: true });
    expect((await hook(bare, { command: "git status" })).permission).toBe("ask");
  });
});
