import { describe, expect, it } from "vitest"
import { useData } from "../src/stores/data.js"

describe("custom engine data actions", () => {
  it("saves through the API then refreshes /config", async () => {
    const calls: Array<[string, string, unknown]> = []
    const api = {
      info: { port: 1, token: "t", pid: 1 },
      req: async (method: string, path: string, body?: unknown) => {
        calls.push([method, path, body])
        return path === "/config" ? { tmuxSocket: "s", engines: [], namePools: [] } : {}
      },
      wsTerminalUrl: () => "",
    } as any
    useData.getState().setApi(api)
    const definition: any = { id: "agent", displayName: "Agent" }
    await useData.getState().saveCustomEngine(definition)
    expect(calls).toEqual([
      ["POST", "/engines/custom", definition],
      ["GET", "/config", undefined],
    ])
  })

  it("switches the existing task engine and refreshes tabs", async () => {
    const calls: Array<[string, string, unknown]> = []
    const api = {
      info: { port: 1, token: "t", pid: 1 },
      req: async (method: string, path: string, body?: unknown) => {
        calls.push([method, path, body])
        return []
      },
      wsTerminalUrl: () => "",
    } as any
    useData.getState().setApi(api)
    await useData.getState().switchEngine("W", "copilot")
    expect(calls).toEqual([
      ["POST", "/workspaces/W/engine", { engineId: "copilot" }],
      ["GET", "/workspaces/W/tabs", undefined],
    ])
  })
})
