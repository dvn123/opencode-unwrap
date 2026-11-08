/**
 * Pi extension: runs shell-unwrap's Codex hook on every `bash` tool call and
 * blocks the call with the hook's reason when it denies.
 *
 * Pi runs extensions in Node, and the hook bundle needs Bun, so the extension
 * starts the bundle beside it, `shell-unwrap.js`, as the Codex host. It blocks
 * when the hook cannot run, so the guards fail closed. It never asks: Pi's
 * permission system already asks for a command behind a wrapper it does not
 * know, and a second prompt would only repeat it.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "shell-unwrap.js");
const TIMEOUT_MS = 10_000;
const UNAVAILABLE = "shell-unwrap could not run, so its guards were not checked";

interface ToolCall {
  readonly toolName: string;
  readonly input: { readonly command?: unknown };
}

interface Pi {
  on(event: "tool_call", handler: (event: ToolCall) => Promise<{ block: true; reason: string } | undefined>): void;
}

/** The hook's stdout for one command; rejects when it cannot run. */
function runHook(command: string, hook = HOOK): Promise<string> {
  return new Promise((resolve, reject) => {
    // From the bundle's directory, since a mise `bun` shim exits in a project
    // whose mise config is untrusted.
    const child = spawn("bun", [hook, "codex"], {
      cwd: dirname(hook),
      stdio: ["pipe", "pipe", "ignore"],
      timeout: TIMEOUT_MS,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`exit ${code}`))));
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  });
}

/** The reason to block the command, or undefined to let it through. */
export async function review(command: string, hook = HOOK): Promise<string | undefined> {
  try {
    const output = (await runHook(command, hook)).trim();
    if (!output) return undefined;
    return JSON.parse(output).hookSpecificOutput?.permissionDecisionReason ?? UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export default function shellUnwrap(pi: Pi): void {
  pi.on("tool_call", async (event) => {
    const command = event.input.command;
    if (event.toolName !== "bash" || typeof command !== "string") return undefined;
    const reason = await review(command);
    return reason ? { block: true, reason } : undefined;
  });
}
