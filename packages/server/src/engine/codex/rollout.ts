import * as fs from "node:fs"
import * as path from "node:path"

/**
 * codex 无-hooks 通路的就绪 + id 回填真源（0.139.0 实测 hooks 四断点后的替代信号）。
 *
 * 背景：codex 0.139.0 的 SessionStart hook 结构性不可靠（features.hooks 默认关、项目级
 * .codex/hooks.json 不被发现、--dangerously-bypass-hook-trust 不激活未信任 hooks、SessionStart
 * 推迟到首个 turn）——engine.session.started 永不到达、engineSessionId 永 null。但 codex 在会话
 * 起始即在 <codexHome>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl 落地 rollout 文件，
 * session_meta 首行即带 id + cwd。故就绪门控与 id 回填改以「本 workspace 的新 rollout 文件出现」
 * 为信号：文件名内嵌的 UUIDv7 就是 session id，session_meta.cwd 用来把并发会话精确定位到本 worktree。
 */

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** rollout 文件名 → session id（文件名内嵌 UUIDv7 即 session id，codex.md §3）；非 rollout / 无 UUID → null。 */
export const parseRolloutSessionId = (filename: string): string | null => {
  if (!filename.startsWith("rollout-") || !filename.endsWith(".jsonl")) return null
  const m = filename.match(UUID_RE)
  return m ? m[1]!.toLowerCase() : null
}

/** fs 注入缝（单测用 realRolloutFs 打真临时目录；就绪门控逻辑本身可纯测）。 */
export interface RolloutFs {
  readonly listDir: (dir: string) => string[]
  readonly readText: (p: string) => string | null
  readonly statMtimeMs: (p: string) => number | null
  /** 路径规范化（realpath）：codex 在 session_meta 记的 cwd 是 realpath（macOS /tmp→/private/tmp、
   * 任何软链根都会解析），而 ws.path 可能是软链路径——不归一化则 cwd 精确比对假阴性 → 门控超时误降级 +
   * 永不回填。realpath 失败（路径不存在，单测的假路径）回落原值。0.139.0 真机实测确认此归一化必需。 */
  readonly realpath: (p: string) => string
}

export const realRolloutFs: RolloutFs = {
  listDir: (dir) => { try { return fs.readdirSync(dir) } catch { return [] } },
  readText: (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } },
  statMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs } catch { return null } },
  realpath: (p) => { try { return fs.realpathSync(p) } catch { return p } },
}

/** rollout 首个 session_meta 行的 cwd（session_meta 是首行，落盘前返回 null → 视为未就绪）。 */
const rolloutCwd = (text: string): string | null => {
  for (const line of text.split("\n")) {
    const s = line.trim()
    if (s === "") continue
    let row: any
    try { row = JSON.parse(s) } catch { continue }
    if (row?.type === "session_meta") {
      const c = row?.payload?.cwd
      return typeof c === "string" ? c : null
    }
  }
  return null
}

export interface RolloutScanOpts {
  readonly home: string
  readonly cwd: string
  /** 只认会话开始之后创建的 rollout（旧会话/别的 tab 的残留 rollout 排除；防误回填旧 id）。 */
  readonly sinceMs: number
}

/** 在 <home>/sessions 日期树里找「本 workspace（cwd 匹配）、mtime≥since、最新」的 rollout。
 * cwd 未知（session_meta 尚未落盘）视为未就绪跳过——绝不抛，找不到返回 null。 */
export const scanNewestRollout = (fsx: RolloutFs, o: RolloutScanOpts): { sessionId: string; path: string } | null => {
  const root = path.join(o.home, "sessions")
  const desc = (dir: string): string[] => fsx.listDir(dir).sort((a, b) => b.localeCompare(a))
  const wantCwd = fsx.realpath(o.cwd) // ws.path 归一化一次（realpath），下方与 rollout 记录的 realpath cwd 比对
  let best: { sessionId: string; path: string; mtime: number } | null = null
  for (const y of desc(root)) {
    const yd = path.join(root, y)
    for (const m of desc(yd)) {
      const md = path.join(yd, m)
      for (const d of desc(md)) {
        const dd = path.join(md, d)
        for (const f of fsx.listDir(dd)) {
          const sid = parseRolloutSessionId(f)
          if (sid === null) continue
          const fp = path.join(dd, f)
          const mtime = fsx.statMtimeMs(fp)
          if (mtime === null || mtime < o.sinceMs) continue
          const text = fsx.readText(fp)
          if (text === null) continue
          const cwd = rolloutCwd(text)
          if (cwd === null || fsx.realpath(cwd) !== wantCwd) continue
          if (best === null || mtime > best.mtime) best = { sessionId: sid, path: fp, mtime }
        }
      }
    }
  }
  return best ? { sessionId: best.sessionId, path: best.path } : null
}

export interface RolloutGateDeps {
  readonly scan: () => { sessionId: string; path: string } | null
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

/** 轮询就绪门控：scan 命中即返回；到 timeout 仍无 → 返回 null（调用方降级走 waitStable）。
 * intervalMs ≤ 500（brief）：rollout 文件在会话起始即落地，几百 ms 即可捕获，不引入可感延迟。 */
export const awaitRollout = async (
  deps: RolloutGateDeps,
  o: { readonly timeoutMs: number; readonly intervalMs: number },
): Promise<{ sessionId: string; path: string } | null> => {
  const deadline = deps.now() + o.timeoutMs
  for (;;) {
    const hit = deps.scan()
    if (hit !== null) return hit
    if (deps.now() >= deadline) return null
    await deps.sleep(o.intervalMs)
  }
}
