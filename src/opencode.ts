/**
 * OpenCode plugin. OpenCode loads plugins in its own process, so this file
 * stays TypeScript and asks the `shell-unwrap` binary, installed beside
 * `shell-unwrap.json` one directory above the plugin, to judge each shell
 * evaluation with OpenCode's own rules. The binary reviews without the rules
 * first and asks for them only when a command has something to peel, since
 * loading them costs two OpenCode calls.
 */

import type { Plugin } from "@opencode/plugin";
import type { Permission } from "@opencode/schema/permission";

export interface Evaluation {
  readonly action: string;
  readonly resources: readonly string[];
  effect: Permission.Effect;
  message?: string;
}

/** Why a shell deny rule exists, by the rule's exact `resource` pattern. */
export type Reasons = Readonly<Record<string, string>>;

// Named as coding-agent-sync installs it: `shell-unwrap.exe` on Windows.
const BINARY = `${import.meta.dir}/../shell-unwrap${process.platform === "win32" ? ".exe" : ""}`;

/** The binary's JSON answer to one JSON request; rejects when it cannot run. */
async function ask<T>(binary: string, operation: string, request: unknown): Promise<T> {
  const child = Bun.spawn([binary, "opencode", operation], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`shell-unwrap exited with ${code}`);
  return JSON.parse(output) as T;
}

interface Verdict {
  readonly effect?: Permission.Effect;
  readonly message?: string;
  readonly needsRules?: boolean;
}

/** What shell-unwrap.json adds to the rules: deny reasons, and the policy the binary reads. */
export interface Extras {
  readonly reasons: Reasons;
  readonly policy: Record<string, unknown>;
}

/**
 * Reads `{"reasons": {"<rule pattern>": "<reason>"}, "policy": {…}}`. Both are
 * optional, so a missing or unreadable file leaves them out rather than
 * failing the caller, which would drop the wrapped-command denies with it.
 */
export async function readExtras(path: string): Promise<Extras> {
  try {
    const file = await Bun.file(path).json();
    const reasons = file?.reasons && typeof file.reasons === "object" ? file.reasons : {};
    const policy = file?.policy && typeof file.policy === "object" ? file.policy : {};
    return {
      reasons: Object.fromEntries(Object.entries(reasons).filter(([, reason]) => typeof reason === "string")) as Reasons,
      policy,
    };
  } catch {
    return { reasons: {}, policy: {} };
  }
}

/**
 * Judges one evaluation in place: denies a command whose peeled spelling is
 * denied, asks for an allowed one whose peeled spelling asks, and allows an
 * asked one whose every resource reaches an allow through transparent
 * wrappers. It denies when it cannot load the rules or run the binary, so the
 * guards fail closed.
 */
export async function review(
  event: Evaluation,
  rules: () => Promise<Permission.Ruleset>,
  { reasons, policy }: Extras = { reasons: {}, policy: {} },
  binary = BINARY,
): Promise<void> {
  if (event.action !== "shell" || event.effect === "deny") return;
  const request = { action: event.action, resources: event.resources, effect: event.effect, reasons, policy };
  let verdict: Verdict;
  try {
    verdict = await ask<Verdict>(binary, "review", request);
    if (verdict.needsRules) {
      let loaded: Permission.Ruleset;
      try {
        loaded = await rules();
      } catch (cause) {
        event.effect = "deny";
        event.message = `shell-unwrap could not load the shell rules: ${cause instanceof Error ? cause.message : cause}`;
        return;
      }
      verdict = await ask<Verdict>(binary, "review", { ...request, rules: loaded });
    }
  } catch (cause) {
    event.effect = "deny";
    event.message = `shell-unwrap could not run: ${cause instanceof Error ? cause.message : cause}`;
    return;
  }
  if (verdict.effect) event.effect = verdict.effect;
  if (verdict.message) event.message = verdict.message;
}

/**
 * The reason for a shell command OpenCode's own rules denied: the first
 * resource whose deciding rule carries one names it.
 */
export async function explain(
  resources: readonly string[],
  rules: Permission.Ruleset,
  reasons: Reasons,
  binary = BINARY,
): Promise<string | undefined> {
  const { reason } = await ask<{ reason: string }>(binary, "explain", { resources, rules, reasons });
  return reason || undefined;
}

/** The fields of OpenCode's `Permission.BlockedError` this plugin reads and sets. */
interface Blocked {
  readonly _tag: "Permission.BlockedError";
  readonly rules: Permission.Ruleset;
  readonly resources: readonly string[];
  reason?: string;
}

const plugin: Plugin.Plugin = {
  id: "shell-unwrap",
  async setup(ctx) {
    // Deny reasons and the policy live beside the plugins directory.
    const extras = await readExtras(`${import.meta.dir}/../shell-unwrap.json`);
    const { reasons } = extras;
    // The rules OpenCode itself evaluates: the agent's, then the session's.
    async function rules(sessionID: string, agent?: string): Promise<Permission.Ruleset> {
      const session = await ctx.session.get({ sessionID });
      const agentID = agent ?? session.agent;
      if (!agentID) throw new Error("the session names no agent");
      const loaded = await ctx.agent.get({ agentID });
      return [...loaded.data.permissions, ...(session.permissions ?? [])];
    }
    await ctx.permission.hook("evaluate", (event) => review(event, () => rules(event.sessionID, event.agent), extras));
    if (Object.keys(reasons).length === 0) return;
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "shell" || event.status !== "error") return;
      // OpenCode's own deny, with the resources and the rules that decided them.
      const blocked = event.error.error as Partial<Blocked> | undefined;
      if (blocked?._tag !== "Permission.BlockedError" || !blocked.rules || !blocked.resources) return;
      const reason = await explain(blocked.resources, blocked.rules, reasons).catch(() => undefined);
      if (reason) blocked.reason = reason;
    });
  },
};

export default plugin;
