import { describe, it, expect } from "vitest"
import { planComposerKey } from "../src/composer/send.js"

const ev = (o: any) => ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, key: "", ...o })

describe("composer 三档发送 + 打断（spec §7.2 表格）", () => {
  it("Enter：空闲=完整管线发送；忙时=nativeQueue 直投（skipStable）", () => {
    expect(planComposerKey(ev({ key: "Enter" }), { engineWorking: false })).toEqual({ kind: "send", skipStable: false })
    expect(planComposerKey(ev({ key: "Enter" }), { engineWorking: true })).toEqual({ kind: "send", skipStable: true })
  })
  it("Cmd+Enter = 打断并发送", () => {
    expect(planComposerKey(ev({ key: "Enter", metaKey: true }), { engineWorking: true })).toEqual({ kind: "interrupt-send" })
  })
  it("Option+Enter = 仅插入不回车", () => {
    expect(planComposerKey(ev({ key: "Enter", altKey: true }), { engineWorking: false })).toEqual({ kind: "insert", skipStable: false })
    expect(planComposerKey(ev({ key: "Enter", altKey: true }), { engineWorking: true })).toEqual({ kind: "insert", skipStable: true })
  })
  it("Shift+Enter = composer 内换行", () => {
    expect(planComposerKey(ev({ key: "Enter", shiftKey: true }), { engineWorking: false })).toEqual({ kind: "newline" })
  })
  it("Esc = 失焦回终端；其它键不管", () => {
    expect(planComposerKey(ev({ key: "Escape" }), { engineWorking: false })).toEqual({ kind: "blur" })
    expect(planComposerKey(ev({ key: "a" }), { engineWorking: false })).toEqual({ kind: "none" })
  })
})
