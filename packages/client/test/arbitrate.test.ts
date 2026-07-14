import { describe, it, expect } from "vitest"
import { arbitrateTerminalKey } from "../src/terminal/arbitrate.js"

const ESC = String.fromCharCode(0x1b)
const CTRL_A = String.fromCharCode(0x01)
const CTRL_E = String.fromCharCode(0x05)
const CTRL_U = String.fromCharCode(0x15)

const ev = (o: any) => ({ metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, code: "", key: "", type: "keydown", ...o })

describe("终端三层仲裁（spec §7.3，Superset 原样）", () => {
  it("① 注册表命中的 Cmd chord → bubble", () => {
    expect(arbitrateTerminalKey(ev({ metaKey: true, code: "KeyT", key: "t" }))).toEqual({ action: "bubble" })
    expect(arbitrateTerminalKey(ev({ metaKey: true, code: "Digit5", key: "5" }))).toEqual({ action: "bubble" })
    expect(arbitrateTerminalKey(ev({ metaKey: true, code: "KeyK", key: "k" }))).toEqual({ action: "bubble" })
  })
  it("② 行编辑翻译", () => {
    expect(arbitrateTerminalKey(ev({ metaKey: true, key: "ArrowLeft" }))).toEqual({ action: "write", bytes: CTRL_A })
    expect(arbitrateTerminalKey(ev({ metaKey: true, key: "ArrowRight" }))).toEqual({ action: "write", bytes: CTRL_E })
    expect(arbitrateTerminalKey(ev({ metaKey: true, key: "Backspace" }))).toEqual({ action: "write", bytes: CTRL_U })
    expect(arbitrateTerminalKey(ev({ altKey: true, key: "ArrowLeft" }))).toEqual({ action: "write", bytes: ESC + "b" })
    expect(arbitrateTerminalKey(ev({ altKey: true, key: "ArrowRight" }))).toEqual({ action: "write", bytes: ESC + "f" })
    expect(arbitrateTerminalKey(ev({ shiftKey: true, key: "Enter" }))).toEqual({ action: "write", bytes: ESC + "\r" })
  })
  it("③ 其余 Cmd 组合一律不进 PTY（bubble）：Cmd+C/V/A/Q", () => {
    for (const code of ["KeyC", "KeyV", "KeyA", "KeyQ"])
      expect(arbitrateTerminalKey(ev({ metaKey: true, code, key: code.slice(3).toLowerCase() }))).toEqual({ action: "bubble" })
  })
  it("其它按键全部透传：Ctrl+A/E、Esc、普通字符", () => {
    expect(arbitrateTerminalKey(ev({ ctrlKey: true, key: "a", code: "KeyA" }))).toEqual({ action: "pty" })
    expect(arbitrateTerminalKey(ev({ ctrlKey: true, key: "e", code: "KeyE" }))).toEqual({ action: "pty" })
    expect(arbitrateTerminalKey(ev({ key: "Escape", code: "Escape" }))).toEqual({ action: "pty" }) // claude 双击 Esc rewind 不受影响
    expect(arbitrateTerminalKey(ev({ key: "x", code: "KeyX" }))).toEqual({ action: "pty" })
  })
  it("非 keydown 不拦截", () => {
    expect(arbitrateTerminalKey(ev({ type: "keyup", metaKey: true, code: "KeyT" }))).toEqual({ action: "pty" })
  })
})
