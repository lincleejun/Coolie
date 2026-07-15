import { describe, expect, it } from "vitest"
import { buildCommands, filterCommands, movePaletteSelection } from "../src/chrome/CommandPalette.js"
import type { HotkeyId } from "../src/hotkeys/registry.js"
import { t } from "../src/i18n/index.js"

describe("命令面板纯动作表", () => {
  const hits: string[] = []
  const commands = buildCommands({
    hotkeys: [
      { id: "workspace.new", chord: "meta+n", labelKey: "hotkey.workspace.new", category: "workspace" },
      { id: "app.commandPalette", chord: "meta+k", labelKey: "hotkey.app.commandPalette", category: "app" },
    ],
    runnableActionIds: new Set<HotkeyId>(["workspace.new", "app.commandPalette"]),
    workspaces: [{ id: "w1", name: "usa-yellowstone" }, { id: "w2", name: "china-guilin" }],
    checkpointWorkspace: { id: "w1", name: "usa-yellowstone" },
    translate: (key) => t(key, "en"),
    runHotkey: (id) => hits.push(id),
    selectWs: (id) => hits.push(id),
    createCheckpoint: () => hits.push("checkpoint:create"),
    listCheckpoints: () => hits.push("checkpoint:list"),
  })

  it("从有效 registry/action 表和 workspace 生成命令", () => {
    expect(commands.map((c) => c.id)).toEqual([
      "hk:workspace.new", "ws:w1", "ws:w2", "checkpoint:create", "checkpoint:list",
    ])
    expect(commands[0]?.title).toBe("Workspace · Create workspace (composer becomes initial prompt)")
    expect(/\p{Script=Han}/u.test(commands[0]?.title ?? "")).toBe(false)
  })

  it("模糊搜索 title 并保持评分顺序", () => {
    expect(filterCommands(commands, "guilin").map((c) => c.id)).toEqual(["ws:w2"])
    expect(filterCommands(commands, "")).toEqual(commands)
  })

  it("同名 workspace 的模糊结果仍路由到各自 id", () => {
    const duplicate = buildCommands({
      hotkeys: [],
      runnableActionIds: new Set(),
      workspaces: [{ id: "a", name: "same" }, { id: "b", name: "same" }],
      runHotkey: () => {},
      selectWs: () => {},
    })
    expect(filterCommands(duplicate, "same").map((command) => command.id)).toEqual(["ws:a", "ws:b"])
  })

  it("动作路由执行对应 action", () => {
    commands[0]?.run()
    commands[2]?.run()
    commands[3]?.run()
    expect(hits).toEqual(["workspace.new", "w2", "checkpoint:create"])
  })

  it("上下选择在结果边界内循环", () => {
    expect(movePaletteSelection(0, -1, 3)).toBe(2)
    expect(movePaletteSelection(2, 1, 3)).toBe(0)
    expect(movePaletteSelection(0, 1, 0)).toBe(0)
  })
})
