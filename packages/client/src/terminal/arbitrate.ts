/**
 * 终端焦点三层仲裁（spec §7.3，Superset terminal-key-event-handler 结构原样、独立实现）：
 * ① 注册表命中的 Cmd chord → bubble 给 app（xterm 提前 bail，事件自然冒泡到 document 的全局 dispatcher）
 * ② 行编辑翻译：macOS 原生行编辑键 → readline/escape 序列直写 PTY
 * ③ 其余 Cmd 组合一律不进 PTY（Ghostty/VS Code/Superset 三家共识）
 * 其它按键全部透传（Ctrl+A/E 归 shell/engine；Esc 归 claude 自己的双击 rewind）。
 */
import { resolveHotkey } from "../hotkeys/registry"

export interface TermKeyEvent {
  type: string
  metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean
  code: string; key: string
}

export type KeyDecision = { action: "bubble" } | { action: "write"; bytes: string } | { action: "pty" }

const ESC = String.fromCharCode(0x1b)
const CTRL_A = String.fromCharCode(0x01)
const CTRL_E = String.fromCharCode(0x05)
const CTRL_U = String.fromCharCode(0x15)

export const arbitrateTerminalKey = (e: TermKeyEvent): KeyDecision => {
  if (e.type !== "keydown") return { action: "pty" }
  // ① app 快捷键
  if (resolveHotkey(e)) return { action: "bubble" }
  // ② 行编辑翻译（语义键用 e.key）
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") return { action: "write", bytes: CTRL_A }   // 行首
    if (e.key === "ArrowRight") return { action: "write", bytes: CTRL_E }  // 行尾
    if (e.key === "Backspace") return { action: "write", bytes: CTRL_U }   // kill line
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") return { action: "write", bytes: ESC + "b" }  // 词左
    if (e.key === "ArrowRight") return { action: "write", bytes: ESC + "f" } // 词右
  }
  if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && e.key === "Enter")
    return { action: "write", bytes: ESC + "\r" } // ESC CR：claude /terminal-setup 的换行序列，不依赖 kitty 握手
  // ③ 其余 Cmd chord 一律不进 PTY
  if (e.metaKey) return { action: "bubble" }
  return { action: "pty" }
}
