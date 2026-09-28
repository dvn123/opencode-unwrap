import type { Plugin } from "@opencode/plugin"
import type { Permission } from "@opencode/schema/permission"
import { explain, review, type Reasons } from "./review.ts"

/**
 * Deny reasons live beside the plugins directory, in `opencode-unwrap.json`
 * as `{"reasons": {"<rule resource>": "<reason>"}}`. They are advice, so a
 * missing or unreadable file leaves them out rather than failing the plugin,
 * which would drop the wrapped-command denies with it.
 */
async function loadReasons(): Promise<Reasons> {
  try {
    const document = await Bun.file(`${import.meta.dir}/../opencode-unwrap.json`).json()
    const reasons = document?.reasons
    if (!reasons || typeof reasons !== "object") return {}
    return Object.fromEntries(Object.entries(reasons).filter(([, reason]) => typeof reason === "string")) as Reasons
  } catch {
    return {}
  }
}

/** The fields of OpenCode's `Permission.BlockedError` this plugin reads and sets. */
interface Blocked {
  readonly _tag: "Permission.BlockedError"
  readonly rules: Permission.Ruleset
  readonly resources: readonly string[]
  reason?: string
}

const plugin: Plugin.Plugin = {
  id: "opencode-unwrap",
  async setup(ctx) {
    const reasons = await loadReasons()
    // The rules OpenCode itself evaluates: the agent's, then the session's.
    async function rules(sessionID: string, agent?: string): Promise<Permission.Ruleset> {
      const session = await ctx.session.get({ sessionID })
      const agentID = agent ?? session.agent
      if (!agentID) throw new Error("the session names no agent")
      const loaded = await ctx.agent.get({ agentID })
      return [...loaded.data.permissions, ...(session.permissions ?? [])]
    }
    await ctx.permission.hook("evaluate", (event) => review(event, () => rules(event.sessionID, event.agent), reasons))
    if (Object.keys(reasons).length === 0) return
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "shell" || event.status !== "error") return
      // OpenCode's own deny, with the resources and the rules that decided them.
      const blocked = event.error.error as Partial<Blocked> | undefined
      if (blocked?._tag !== "Permission.BlockedError" || !blocked.rules || !blocked.resources) return
      const reason = explain(blocked.resources, blocked.rules, reasons)
      if (reason) blocked.reason = reason
    })
  },
}

export default plugin
