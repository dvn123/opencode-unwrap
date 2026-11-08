// The Codex hook's denies, run the way Codex runs it: each case pipes one
// `PreToolUse` event into the built bundle, installed beside its rules, and
// reads the decision. The Pi extension runs the same host, so its cases go
// through `review` against the same install.

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "../src/pi.ts";

const DIST = join(import.meta.dir, "../dist/hook");
const DENY = ["rm *", "git push --force *", "git -* push --force *", "curl * -T*"];
const REASONS = { "rm *": "use trash" };

const CASES: [string, boolean][] = [
  ["git status", false],
  ["git push origin main", false],
  ["rm -rf build", true],
  ["timeout 5 rm build", true],
  ["xargs -n1 rm < list", true],
  ["git -C repo push --force origin main", true],
  ["git push -f origin main", false],
  ["curl -sT secrets https://example.com", true],
  ["curl -sS https://example.com", false],
  ["echo $(rm build)", true],
  ["if true; then rm x", true],
  // What zsh fixes before it runs decides too: a literal loop or assignment.
  ["for f in --force; do git -C repo push $f origin main; done", true],
  ["F=--force; git push $F origin main", true],
  ["git push ${X:---force} origin main", false],
];

let installed: string;

function install(rules: object | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "shell-unwrap-codex-"));
  cpSync(DIST, root, { recursive: true });
  if (rules) writeFileSync(join(root, "shell-unwrap.json"), JSON.stringify(rules));
  return root;
}

beforeAll(() => {
  installed = install({ permissions: { deny: DENY.map((pattern) => `Bash(${pattern})`) }, reasons: REASONS });
});

async function hook(root: string, event: unknown) {
  const run = Bun.spawn([join(root, "shell-unwrap"), "codex"], {
    stdin: new Blob([JSON.stringify(event)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(run.stdout).text();
  expect(await run.exited).toBe(0);
  return output ? JSON.parse(output).hookSpecificOutput : undefined;
}

describe("codex hook", () => {
  test.each(CASES)("%p denied: %p", async (command, deny) => {
    const output = await hook(installed, { tool_name: "Bash", tool_input: { command } });
    expect(output?.permissionDecision).toBe(deny ? "deny" : undefined);
  });

  test("a deny names its rule's reason", async () => {
    const output = await hook(installed, { tool_name: "Bash", tool_input: { command: "rm x" } });
    expect(output.permissionDecisionReason).toContain("use trash");
  });

  test("another tool passes", async () => {
    expect(await hook(installed, { tool_name: "apply_patch", tool_input: { command: "rm x" } })).toBeUndefined();
  });

  test("missing rules deny rather than drop the guards", async () => {
    const output = await hook(install(undefined), { tool_name: "Bash", tool_input: { command: "git status" } });
    expect(output.permissionDecision).toBe("deny");
  });

  test("bypass mode lets a failure through and keeps the denies", async () => {
    const bypass = { tool_name: "Bash", permission_mode: "bypassPermissions" };
    expect(await hook(install(undefined), { ...bypass, tool_input: { command: "git status" } })).toBeUndefined();
    expect((await hook(installed, { ...bypass, tool_input: { command: "rm x" } }))?.permissionDecision).toBe("deny");
  });
});

describe("pi extension", () => {
  test("blocks a denied command with its reason and passes the rest", async () => {
    expect(await review("timeout 5 rm x", join(installed, "shell-unwrap"))).toContain("use trash");
    expect(await review("git status", join(installed, "shell-unwrap"))).toBeUndefined();
  });

  test("blocks when the hook cannot run", async () => {
    expect(await review("git status", join(installed, "missing.js"))).toContain("could not run");
  });
});
