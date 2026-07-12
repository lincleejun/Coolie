import * as fs from "node:fs"
import * as path from "node:path"

/**
 * codex 无-hooks 通路的 id 回填真源（0.139.0 实测 hooks 四断点后的替代信号）。
 *
 * 背景：codex 0.139.0 的 SessionStart hook 结构性不可靠（features.hooks 默认关、项目级
 * .codex/hooks.json 不被发现、--dangerously-bypass-hook-trust 不激活未信任 hooks、SessionStart
 * 推迟到首个 turn）——engine.session.started 永不到达、engineSessionId 永 null。codex 会在
 * <codexHome>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl 落地 rollout 文件（session_meta
 * 首行带 id + cwd）：文件名内嵌的 UUIDv7 就是 session id，session_meta.cwd 把并发会话精确定位到本 worktree。
 *
 * 【RE-SMOKE 反转，勿回退成投递前门控】交互式 TUI 的 rollout 是**首 turn 才懒落盘**的（真机实测：
 * composer 就绪静置 25s 无文件；首条 prompt 后 ~2s 出现；headless `codex exec` 才即刻落盘——首轮
 * 0.556s 的测量对象是 exec，不是 Coolie 跑的 TUI）。rollout 做投递前就绪门控 = 门控等 rollout、
 * rollout 等首条 prompt 的死锁。所以：投递照常走强化 waitStable（codex composer 实测不吞字、投递
 * 从未失败），rollout 只做**投递外的后台回填 watcher**（startRolloutBackfillWatcher）——命中后迟到
 * 回填 engineSessionId + engine.session.started（下游 C4/monitor/标题词汇统一，不感知迟到）。
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
   * 任何软链根都会解析），而 ws.path 可能是软链路径——不归一化则 cwd 精确比对假阴性 → watcher 永不
   * 命中、永不回填。realpath 失败（路径不存在，单测的假路径）回落原值。0.139.0 真机实测确认此归一化必需。 */
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

export interface RolloutWatcherDeps {
  readonly scan: () => { sessionId: string; path: string } | null
  /** 每 tick 先问是否还需要盯（bootstrap 注入：tab 仍存在且 engineSessionId 仍 null）——
   * workspace teardown（tab 删）或已被别的通路回填（未来 hooks 抢先）→ false，watcher 自停。
   * 判定在 scan **之前**：teardown 后连一次多余的 fs 扫描都不做。 */
  readonly shouldContinue: () => Promise<boolean>
  /** 命中回调（bootstrap 注入：setEngineSessionId + engine.session.started）。抛错 = 本 tick 作废、
   * 下一 tick 连 scan 带 onFound 整体重试（回填是幂等 UPDATE，重试安全）。 */
  readonly onFound: (hit: { sessionId: string; path: string }) => Promise<void>
  readonly now?: () => number
}

/** 后台回填 watcher：每 intervalMs 一 tick（shouldContinue → scan → onFound），命中且 onFound 成功后
 * 自停；maxMs 上限兜底防永久盯扫；返回显式 stop（幂等）。timer 逐 tick setTimeout + unref——绝不阻
 * 进程退出，tick 之间无并发（async tick 完成后才排下一个），任何异常吞掉重试。 */
export const startRolloutBackfillWatcher = (
  deps: RolloutWatcherDeps,
  o: { readonly intervalMs: number; readonly maxMs: number },
): (() => void) => {
  const now = deps.now ?? Date.now
  const deadline = now() + o.maxMs
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => { stopped = true; if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
  const arm = (): void => {
    if (stopped || now() >= deadline) return stop()
    timer = setTimeout(tick, o.intervalMs)
    timer.unref?.()
  }
  const tick = (): void => {
    void (async () => {
      if (stopped) return
      try {
        if (!(await deps.shouldContinue())) return stop()
        const hit = deps.scan()
        if (hit !== null) { await deps.onFound(hit); return stop() }
      } catch { /* 看护绝不外抛：本 tick 作废，下一 tick 重试 */ }
      arm()
    })()
  }
  arm()
  return stop
}
