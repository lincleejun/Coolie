import { describe, it, expect } from "vitest"
import { archiveForceConfirmation, deleteConfirmation, wsBadge } from "../src/sidebar/Sidebar.js"
import type { Workspace, Tab } from "@coolie/protocol"

const ws = (o: Partial<Workspace> & { id: string }): Workspace => ({
  projectId: "P",
  name: o.id,
  branch: "main",
  status: "active",
  pinned: false,
  createdAt: 0,
  ...o,
}) as Workspace

const tab = (o: Partial<Tab> & { kind: Tab["kind"] }): Tab => ({
  id: "t",
  workspaceId: "w",
  engineId: null,
  engineSessionId: null,
  tmuxWindow: null,
  title: null,
  status: "idle",
  lastHookAt: null,
  ...o,
}) as Tab

describe("wsBadge", () => {
  it("workspace 状态优先于 tab 状态", () => {
    expect(wsBadge(ws({ id: "a", status: "creating" }), [tab({ kind: "engine", status: "working" })]).cls).toBe("b-creating")
    expect(wsBadge(ws({ id: "a", status: "error" }), undefined).cls).toBe("b-error")
    expect(wsBadge(ws({ id: "a", status: "archived" }), undefined).cls).toBe("b-archived")
  })

  it("active 时取 engine tab 状态", () => {
    expect(wsBadge(ws({ id: "a" }), [tab({ kind: "engine", status: "working" })]).glyph).toBe("●")
    expect(wsBadge(ws({ id: "a" }), [tab({ kind: "engine", status: "awaiting-input" })]).cls).toBe("b-await")
    expect(wsBadge(ws({ id: "a" }), [tab({ kind: "engine", status: "error" })]).cls).toBe("b-error")
    expect(wsBadge(ws({ id: "a" }), [tab({ kind: "engine", status: "idle" })]).cls).toBe("b-idle")
  })

  it("无 engine tab（仅 shell / 空）→ idle", () => {
    expect(wsBadge(ws({ id: "a" }), [tab({ kind: "shell", status: "working" })]).cls).toBe("b-idle")
    expect(wsBadge(ws({ id: "a" }), undefined).cls).toBe("b-idle")
    expect(wsBadge(ws({ id: "a" }), []).cls).toBe("b-idle")
  })
})

describe("workspace destructive confirmations", () => {
  it("warns managed workspaces that force operations permanently discard uncommitted changes", () => {
    const managed = ws({ id: "managed", ownership: "managed" })
    expect(archiveForceConfirmation(managed)).toContain("永久丢弃未提交改动")
    expect(deleteConfirmation(managed)).toContain("永久丢弃未提交改动")
  })

  it("explains adopted operations only unregister Coolie and preserve the external worktree", () => {
    const adopted = ws({ id: "external", ownership: "adopted" })
    expect(archiveForceConfirmation(adopted)).toContain("只取消 Coolie 管理")
    expect(deleteConfirmation(adopted)).toContain("保留外部 worktree")
  })
})
