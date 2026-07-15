import { describe, it, expect, beforeEach, vi } from "vitest"
import { useData } from "../src/stores/data.js"
import { useUi } from "../src/stores/ui.js"

const fakeApi = () => {
  const calls: string[] = []
  return {
    calls,
    info: { port: 1, token: "t", pid: 1 },
    req: async (m: string, p: string) => {
      calls.push(`${m} ${p}`)
      if (p === "/workspaces" || p === "/projects" || p.endsWith("/tabs")) return []
      if (p.endsWith("/git/diffstat")) return { filesChanged: 0, insertions: 0, deletions: 0 }
      return {}
    },
    wsTerminalUrl: () => "",
  } as any
}

describe("useData.applyEvent", () => {
  beforeEach(() => {
    useData.setState({ projects: [], workspaces: [], tabsByWs: {}, diffstatByWs: {}, pendingSends: [], warnings: [] } as any)
    useData.getState().setSessionDisposer(() => {}) // 复位注入的回收器，避免用例间串味
    useData.getState().setTabSessionDisposer(() => {})
  })
  it("workspace.* 触发 workspaces 重拉", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useData.getState().applyEvent({ seq: 1, workspaceId: "W", type: "workspace.created", payload: {}, ts: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toContain("GET /workspaces")
  })
  it("tab.* / composer.* 触发对应 ws 的 tabs 重拉", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useData.getState().applyEvent({ seq: 2, workspaceId: "W", type: "tab.status.changed", payload: {}, ts: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toContain("GET /workspaces/W/tabs")
  })
  it("tab.closed 回收对应 tab 的终端会话，避免 tmux window 索引复用串台", () => {
    const api = fakeApi(); useData.getState().setApi(api)
    const disposed: Array<[string, string]> = []
    useData.getState().setTabSessionDisposer((wsId, tabId) => disposed.push([wsId, tabId]))
    useData.getState().applyEvent({
      seq: 9, workspaceId: "W", type: "tab.closed", payload: { tabId: "T" }, ts: 0,
    })
    expect(disposed).toEqual([["W", "T"]])
  })
  it("project.* 触发 projects 重拉", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useData.getState().applyEvent({ seq: 3, workspaceId: null, type: "project.added", payload: {}, ts: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.calls).toContain("GET /projects")
  })
  it("workspace.archived → 调用注入的终端会话回收器（F2：防 N×tabs 活 WS 泄漏）", () => {
    const api = fakeApi(); useData.getState().setApi(api)
    const disposed: string[] = []
    useData.getState().setSessionDisposer((wsId) => disposed.push(wsId))
    useData.getState().applyEvent({ seq: 4, workspaceId: "W", type: "workspace.archived", payload: {}, ts: 0 })
    expect(disposed).toEqual(["W"])
    // 常规 workspace.* 不回收（只有 archived/deleted 才断连）
    useData.getState().applyEvent({ seq: 5, workspaceId: "W", type: "workspace.updated", payload: {}, ts: 0 })
    expect(disposed).toEqual(["W"])
  })
  it("workspace.deleted → 若等于当前 selectedWs 则清空（data↔ui seam）", () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useUi.getState().selectWs("W")
    useData.getState().applyEvent({ seq: 7, workspaceId: "W", type: "workspace.deleted", payload: {}, ts: 0 })
    expect(useUi.getState().selectedWs).toBeNull()
  })
  it("workspace.deleted → 删的不是当前选中项则 selectedWs 不动", () => {
    const api = fakeApi(); useData.getState().setApi(api)
    useUi.getState().selectWs("W")
    useData.getState().applyEvent({ seq: 8, workspaceId: "OTHER", type: "workspace.deleted", payload: {}, ts: 0 })
    expect(useUi.getState().selectedWs).toBe("W")
  })
  it("prompt.delivery.degraded → 浮出 UI 警告并带 code（F5：不静默丢）", () => {
    useData.getState().applyEvent({
      seq: 6, workspaceId: "W", type: "prompt.delivery.degraded",
      payload: { code: "enter_not_confirmed", reason: "回车未确认" }, ts: 0,
    })
    const w = useData.getState().warnings
    expect(w).toHaveLength(1)
    expect(w[0]!.code).toBe("enter_not_confirmed")
  })
})

describe("useData 生命周期动作（D2：archive/unarchive/delete 打对端点）", () => {
  it("setPinnedWs POST /pin，成功前不修改本地 workspace", async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    const calls: Array<{ m: string; p: string; b: any }> = []
    const api = {
      info: { port: 1, token: "t", pid: 1 },
      req: async (m: string, p: string, b: any) => { calls.push({ m, p, b }); await pending; return {} },
      wsTerminalUrl: () => "",
    } as any
    useData.setState({ workspaces: [{ id: "W", pinned: false }] as any })
    useData.getState().setApi(api)
    const request = useData.getState().setPinnedWs("W", true)
    expect(useData.getState().workspaces[0]!.pinned).toBe(false)
    resolve()
    await request
    expect(calls).toEqual([{ m: "POST", p: "/workspaces/W/pin", b: { pinned: true } }])
    expect(useData.getState().workspaces[0]!.pinned).toBe(false)
  })
  it("archiveWs 默认 force=false；确认后可 force=true", async () => {
    const calls: Array<{ m: string; p: string; b: any }> = []
    const api = { info: { port: 1, token: "t", pid: 1 }, req: async (m: string, p: string, b: any) => { calls.push({ m, p, b }); return {} }, wsTerminalUrl: () => "" } as any
    useData.getState().setApi(api)
    await useData.getState().archiveWs("W")
    expect(calls[0]).toEqual({ m: "POST", p: "/workspaces/W/archive", b: { force: false } })
    await useData.getState().archiveWs("W", true)
    expect(calls[1]).toEqual({ m: "POST", p: "/workspaces/W/archive", b: { force: true } })
  })
  it("unarchiveWs POST /unarchive；deleteWs DELETE 带 force=1", async () => {
    const calls: string[] = []
    const api = { info: { port: 1, token: "t", pid: 1 }, req: async (m: string, p: string) => { calls.push(`${m} ${p}`); return {} }, wsTerminalUrl: () => "" } as any
    useData.getState().setApi(api)
    await useData.getState().unarchiveWs("W")
    await useData.getState().deleteWs("W")
    expect(calls).toEqual(["POST /workspaces/W/unarchive", "DELETE /workspaces/W?force=1"])
  })
  it("exposes task metadata and reorder mutations", async () => {
    const calls: Array<{ m: string; p: string; b: any }> = []
    const api = {
      info: { port: 1, token: "t", pid: 1 },
      req: async (m: string, p: string, b: any) => { calls.push({ m, p, b }); return {} },
      wsTerminalUrl: () => "",
    } as any
    useData.getState().setApi(api)
    await useData.getState().renameWs("W", "New name")
    await useData.getState().setTaskStatusWs("W", "in_review")
    await useData.getState().renameBranchWs("W", "feature/new")
    await useData.getState().reorderWs("P", ["W", "M"])
    expect(calls).toEqual([
      { m: "POST", p: "/workspaces/W/rename", b: { name: "New name" } },
      { m: "POST", p: "/workspaces/W/task-status", b: { status: "in_review" } },
      { m: "POST", p: "/workspaces/W/branch", b: { branch: "feature/new" } },
      { m: "POST", p: "/workspaces/reorder", b: { projectId: "P", workspaceIds: ["W", "M"] } },
    ])
  })
})

describe("useData.sendInput", () => {
  it("记账 pendingSends 并在失败后清除（fetch 打向死端口必然 reject）", async () => {
    const api = fakeApi(); useData.getState().setApi(api)
    const p = useData.getState().sendInput("W", { text: "hi", mode: "send", skipStable: false })
    expect(useData.getState().pendingSends.filter((x) => x.wsId === "W")).toHaveLength(1)
    await p.catch(() => {}) // port 1 不可达：reject 即可，账要清
    expect(useData.getState().pendingSends).toHaveLength(0)
  })
  it("targets the selected engine tab in composer and engine-switch requests", async () => {
    const calls: Array<{ path: string; body: any }> = []
    const api = {
      info: { port: 1234, token: "t", pid: 1 },
      req: async (_method: string, path: string, body: any) => {
        calls.push({ path, body })
        return path.endsWith("/tabs") ? [] : {}
      },
      wsTerminalUrl: () => "",
    } as any
    useData.getState().setApi(api)
    useUi.getState().selectTab("W", "engine-two")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await useData.getState().sendInput("W", { text: "hello", mode: "send", skipStable: false })
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toMatchObject({ tabId: "engine-two", text: "hello" })
    fetchSpy.mockRestore()

    await useData.getState().switchEngine("W", "codex")
    expect(calls[0]).toMatchObject({
      path: "/workspaces/W/engine",
      body: { engineId: "codex", tabId: "engine-two" },
    })
  })

  it("falls back to the primary engine when a shell tab is selected", async () => {
    useData.setState({
      tabsByWs: {
        W: [
          { id: "engine-one", workspaceId: "W", kind: "engine" },
          { id: "shell-one", workspaceId: "W", kind: "shell" },
        ],
      },
    } as any)
    useUi.getState().selectTab("W", "shell-one")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await useData.getState().sendInput("W", { text: "hello", mode: "send", skipStable: false })
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toMatchObject({ tabId: "engine-one" })
    fetchSpy.mockRestore()
  })
})
