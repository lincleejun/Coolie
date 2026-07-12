import { describe, it, expect, beforeEach } from "vitest"
import { orderedActiveWs } from "../src/hotkeys/useGlobalHotkeys.js"
import { useData } from "../src/stores/data.js"
import { useUi } from "../src/stores/ui.js"
import type { Workspace } from "@coolie/protocol"

const ws = (o: Partial<Workspace> & { id: string }): Workspace => ({
  projectId: "P",
  name: o.id,
  branch: "main",
  status: "active",
  pinned: false,
  createdAt: 0,
  ...o,
}) as Workspace

describe("orderedActiveWs", () => {
  beforeEach(() => {
    useData.setState({ workspaces: [] })
    useUi.setState({ selectedWs: null })
  })

  it("只含 active/creating/error，剔除 archived", () => {
    useData.setState({
      workspaces: [
        ws({ id: "a", status: "active" }),
        ws({ id: "b", status: "archived" }),
        ws({ id: "c", status: "creating" }),
        ws({ id: "d", status: "error" }),
      ],
    })
    expect(orderedActiveWs().map((w) => w.id)).toEqual(["a", "c", "d"])
  })

  it("pinned 优先 → 组内 createdAt 倒序", () => {
    useData.setState({
      workspaces: [
        ws({ id: "old", pinned: false, createdAt: 100 }),
        ws({ id: "new", pinned: false, createdAt: 300 }),
        ws({ id: "pinOld", pinned: true, createdAt: 50 }),
        ws({ id: "pinNew", pinned: true, createdAt: 200 }),
      ],
    })
    expect(orderedActiveWs().map((w) => w.id)).toEqual(["pinNew", "pinOld", "new", "old"])
  })
})
