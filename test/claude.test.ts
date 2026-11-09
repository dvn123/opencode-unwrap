// The Claude hook's decisions, run the way Claude Code runs it: each row of
// test/decisions.tsv pipes one Bash tool call into the built binary,
// installed in a temporary Claude root with test/policy.json, and reads the
// decision. internal/unwrap/decisions_test.go judges the same table in
// process.

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = join(import.meta.dir, "../dist/hook");

interface Row {
  readonly line: number;
  readonly group: string;
  readonly command: string;
  readonly decision: string;
  readonly fragment: string;
}

/** The decision table's rows, with escapes filled in and placeholders kept. */
function table(): Row[] {
  const lines = readFileSync(join(import.meta.dir, "decisions.tsv"), "utf8").split("\n");
  return lines.flatMap((text, index) => {
    if (!text || text.startsWith("#") || text.startsWith("group\t")) return [];
    const [group = "", command = "", decision = "", fragment = ""] = text.split("\t");
    return [
      { line: index + 1, group, command: command.replaceAll("\\n", "\n").replaceAll("\\t", "\t"), decision, fragment },
    ];
  });
}

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shell-unwrap-")));
  mkdirSync(join(root, "extra"));
  // The symlinks the table's redirect rows write through.
  symlinkSync(mkdtempSync(join(tmpdir(), "shell-unwrap-outside-")), join(root, "escape"));
  symlinkSync(join(root, "extra"), join(root, "inner"));
  symlinkSync(join(root, ".env"), join(root, "env-link"));
  // Directories git would take for a bare repository: `bare`; `linked`,
  // whose commondir names bare; and `dotgit`, whose empty `.git` directory
  // git passes over. `bare/work` is a repository of its own.
  for (const dir of [
    "bare/objects",
    "bare/refs",
    "linked",
    "dotgit/.git",
    "dotgit/objects",
    "dotgit/refs",
    "bare/work/.git/objects",
    "bare/work/.git/refs",
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const head of ["bare", "linked", "dotgit", "bare/work/.git"]) {
    writeFileSync(join(root, head, "HEAD"), "ref: refs/heads/main\n");
  }
  writeFileSync(join(root, "linked/commondir"), "../bare\n");
  cpSync(DIST, join(root, "hooks"), { recursive: true });
  const policy = readFileSync(join(import.meta.dir, "policy.json"), "utf8").replaceAll("{extra}", join(root, "extra"));
  const { permissions, reasons } = JSON.parse(policy);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ permissions }));
  writeFileSync(join(root, "shell-unwrap.json"), JSON.stringify({ reasons }));
});

async function hook(tool: string, command: string, mode = "default") {
  const event = { tool_name: tool, tool_input: { command }, cwd: root, permission_mode: mode };
  const run = Bun.spawn([join(root, "hooks/shell-unwrap"), "claude"], {
    stdin: new Blob([JSON.stringify(event)]),
    stdout: "pipe",
    stderr: "pipe",
    // Where `mktemp` with no template puts its file, as in decisions_test.go.
    env: { ...process.env, TMPDIR: join(root, "extra") },
  });
  const output = await new Response(run.stdout).text();
  expect(await run.exited).toBe(0);
  return output ? JSON.parse(output).hookSpecificOutput : undefined;
}

describe("claude hook", () => {
  test.each(table())("decisions.tsv:$line $group $command", async (row) => {
    const command = row.command.replaceAll("{extra}", join(root, "extra")).replaceAll("{root}", root);
    const output = await hook("Bash", command);
    expect(output?.permissionDecision ?? "abstain").toBe(row.decision);
    // An abstain prints nothing; the in-process test checks its reason.
    if (row.decision === "deny" || row.decision === "ask") {
      expect(output.permissionDecisionReason).toContain(row.fragment);
    }
  });

  test("bypass mode drops asks and keeps denies", async () => {
    expect(await hook("Bash", "git push origin main", "bypassPermissions")).toBeUndefined();
    expect((await hook("Bash", "timeout 5 rm build", "bypassPermissions"))?.permissionDecision).toBe("deny");
  });

  test("other tools get no decision", async () => {
    expect(await hook("Read", "git status")).toBeUndefined();
  });

  test("a missing settings file asks, so the guards fail closed", async () => {
    const bare = mkdtempSync(join(tmpdir(), "shell-unwrap-"));
    cpSync(DIST, join(bare, "hooks"), { recursive: true });
    const run = Bun.spawn([join(bare, "hooks/shell-unwrap"), "claude"], {
      stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm x" } })]),
      stdout: "pipe",
    });
    const output = JSON.parse(await new Response(run.stdout).text()).hookSpecificOutput;
    expect(output.permissionDecision).toBe("ask");
    expect(await run.exited).toBe(0);
  });

  test("the binary decides a batch as each host does", async () => {
    const items = ["git status", "timeout 5 rm x", "for r in o; do git push $r; done"].map((script) => ({
      script,
      cwd: root,
    }));
    const decide = async (host: string) => {
      const run = Bun.spawn([join(DIST, "shell-unwrap"), "decide", host, join(root, "settings.json")], {
        stdin: new Blob([JSON.stringify(items)]),
        stdout: "pipe",
      });
      return JSON.parse(await new Response(run.stdout).text());
    };
    expect(await decide("claude")).toEqual(["allow", "deny", "ask"]);
    expect(await decide("cursor")).toEqual([null, "deny", "ask"]);
    expect(await decide("codex")).toEqual([null, "deny", null]);
  });

  test("the binary prints the peel without reading stdin", async () => {
    const run = Bun.spawn([join(DIST, "shell-unwrap"), "spellings", "timeout 5 rm x"], {
      stdin: "ignore",
      stdout: "pipe",
    });
    expect(JSON.parse(await new Response(run.stdout).text())).toEqual({ "timeout 5 rm x": ["rm x"] });
  });
});
