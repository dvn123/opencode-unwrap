import type { Plugin } from "@opencode/plugin"
import type { Permission } from "@opencode/schema/permission"
import { explain, readReasons, review } from "./review.ts"

/** The fields of OpenCode's `Permission.BlockedError` this plugin reads and sets. */
interface Blocked {
  readonly _tag: "Permission.BlockedError"
  readonly rules: Permission.Ruleset
  readonly resources: readonly string[]
  reason?: string
}

const plugin: Plugin.Plugin = {
  id: "shell-unwrap",
  async setup(ctx) {
    // Deny reasons live beside the plugins directory.
    const reasons = await readReasons(`${import.meta.dir}/../shell-unwrap.json`)
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
