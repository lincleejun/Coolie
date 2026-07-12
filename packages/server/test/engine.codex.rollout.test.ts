import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseRolloutSessionId, scanNewestRollout, awaitRollout, realRolloutFs } from "../src/engine/codex/rollout.js"

const UUID_A = "019f5586-002d-73c1-98b9-ef17a05f06c9"
const UUID_B = "019f5586-1111-73c1-98b9-ef17a05f0000"

describe("parseRolloutSessionId（文件名内嵌 UUIDv7 即 session id）", () => {
  it("从真实 codex rollout 文件名反查 UUID", () => {
    expect(parseRolloutSessionId(`rollout-2025-12-24T11-45-12-${UUID_A}.jsonl`)).toBe(UUID_A)
  })
  it("非 rollout 文件 / 无 UUID → null", () => {
    expect(parseRolloutSessionId("session.jsonl")).toBeNull()
    expect(parseRolloutSessionId("rollout-2025-12-24.jsonl")).toBeNull()
    expect(parseRolloutSessionId(`${UUID_A}.missing`)).toBeNull() // 缺失哨兵不是 rollout
  })
})

describe("scanNewestRollout（workspace-scoped：cwd 匹配 + since 过滤 + newest）", () => {
  let home: string
  const CWD = "/w/mine"
  const OTHER = "/w/other"
  const day = (uuid: string) => path.join(home, "sessions", "2026", "07", "12", `rollout-2026-07-12T00-00-00-${uuid}.jsonl`)
  const writeRollout = (uuid: string, cwd: string, mtimeMs: number, withMeta = true) => {
    const p = day(uuid)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const body = withMeta
      ? JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd } }) + "\n"
      : JSON.stringify({ type: "response_item", payload: { type: "message" } }) + "\n"
    fs.writeFileSync(p, body)
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
    return p
  }

  beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-rollout-")) })
  afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it("cwd 匹配且 mtime≥since → 命中，返回文件名 UUID + 路径", () => {
    const p = writeRollout(UUID_A, CWD, 10_000)
    const hit = scanNewestRollout(realRolloutFs, { home, cwd: CWD, sinceMs: 5_000 })
    expect(hit).toEqual({ sessionId: UUID_A, path: p })
  })
  it("cwd 不匹配（别的 worktree 的会话）→ 跳过", () => {
    expect(scanNewestRollout(realRolloutFs, { home, cwd: OTHER, sinceMs: 5_000 })).toBeNull()
  })
  it("mtime < since（会话开始前的旧 rollout）→ 跳过", () => {
    expect(scanNewestRollout(realRolloutFs, { home, cwd: CWD, sinceMs: 20_000 })).toBeNull()
  })
  it("session_meta 尚未落盘（cwd 未知）→ 视为未就绪，跳过", () => {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-rollout2-"))
    const p = path.join(home2, "sessions", "2026", "07", "12", `rollout-2026-07-12T00-00-00-${UUID_B}.jsonl`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, "") // 空文件：文件已建但 session_meta 未写
    fs.utimesSync(p, 10, 10)
    expect(scanNewestRollout(realRolloutFs, { home: home2, cwd: CWD, sinceMs: 5 })).toBeNull()
    fs.rmSync(home2, { recursive: true, force: true })
  })
  it("多个 cwd 匹配 → 取 mtime 最新的", () => {
    writeRollout(UUID_B, CWD, 30_000) // 更新
    const hit = scanNewestRollout(realRolloutFs, { home, cwd: CWD, sinceMs: 5_000 })
    expect(hit?.sessionId).toBe(UUID_B)
  })
  // 0.139.0 真机实测：session_meta.cwd 是 realpath（macOS /tmp→/private/tmp）。ws.path 为软链路径时
  // 精确比对会假阴性 → 门控超时误降级。归一化（realpath）后软链与真实路径视为同一 workspace。
  it("cwd 软链 vs realpath → 归一化后匹配（真机 realpath 语义）", () => {
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-rollout3-"))
    const realWork = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-realwork-"))
    const linkWork = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coolie-link-")), "ws-link")
    fs.symlinkSync(realWork, linkWork)
    const uuid = "019f55a4-03c1-7972-b38d-20ff48eb8e7c"
    const p = path.join(home3, "sessions", "2026", "07", "12", `rollout-2026-07-12T00-00-00-${uuid}.jsonl`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // rollout 记录 realpath（codex 语义）；调用方传软链路径 → 归一化后仍命中
    fs.writeFileSync(p, JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: fs.realpathSync(realWork) } }) + "\n")
    fs.utimesSync(p, 10, 10)
    const hit = scanNewestRollout(realRolloutFs, { home: home3, cwd: linkWork, sinceMs: 5 })
    expect(hit?.sessionId).toBe(uuid)
    fs.rmSync(home3, { recursive: true, force: true }); fs.rmSync(realWork, { recursive: true, force: true })
  })
})

describe("awaitRollout（轮询就绪门控：注入 scan/now/sleep）", () => {
  it("前几轮 null、随后命中 → 返回命中，且轮询过（sleep 被调用）", async () => {
    let t = 0
    const slept: number[] = []
    let calls = 0
    const hit = { sessionId: UUID_A, path: "/x" }
    const out = await awaitRollout(
      { scan: () => (++calls >= 3 ? hit : null), now: () => t, sleep: async (ms) => { slept.push(ms); t += ms } },
      { timeoutMs: 10_000, intervalMs: 250 },
    )
    expect(out).toEqual(hit)
    expect(calls).toBe(3)
    expect(slept).toEqual([250, 250])
  })
  it("始终 null 直到超时 → 返回 null", async () => {
    let t = 0
    const out = await awaitRollout(
      { scan: () => null, now: () => t, sleep: async (ms) => { t += ms } },
      { timeoutMs: 1_000, intervalMs: 250 },
    )
    expect(out).toBeNull()
  })
})
