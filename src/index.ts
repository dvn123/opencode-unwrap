import type { Plugin } from "@opencode/plugin"
import { review } from "./review.ts"

const plugin: Plugin.Plugin = {
  id: "opencode-unwrap",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", (event) =>
      review(event, async () => {
        // The rules OpenCode itself evaluates: the agent's, then the session's.
        const session = await ctx.session.get({ sessionID: event.sessionID })
        const agentID = event.agent ?? session.agent
        if (!agentID) throw new Error("the session names no agent")
        const agent = await ctx.agent.get({ agentID })
        return [...agent.data.permissions, ...(session.permissions ?? [])]
      }),
    )
  },
}

export default plugin
