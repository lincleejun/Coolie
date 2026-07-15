import { Context, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"

export interface CoolieConfigShape {
  readonly home: string
  readonly dbPath: string
  readonly serverInfoPath: string
  /** daemon 与 client 共用的 AF_UNIX socket 路径。 */
  readonly sockPath: string
  readonly workspacesRoot: string
  /** tmux 专属 socket 名（tmux -L <socket>）；测试注入 coolie-test-* 隔离 */
  readonly tmuxSocket: string
  /** claude 引擎自己的数据目录（转录所在）；测试注入临时目录 */
  readonly claudeHome: string
  /** codex 引擎自己的数据目录（rollout 转录所在）；`COOLIE_CODEX_HOME` 覆写，默认 ~/.codex */
  readonly codexHome: string
  /** claude 文件夹信任配置文件（~/.claude.json，projects[].hasTrustDialogAccepted 存于此）；
   * bootstrap 起 engine 前预置此标志规避新 worktree 的 trust dialog 死锁。`COOLIE_CLAUDE_CONFIG` 覆盖（测试注入临时文件）。 */
  readonly claudeConfigPath?: string
  /** codex 文件夹信任配置文件（~/.codex/config.toml，projects."<path>".trust_level 存于此）；
   * bootstrap 起 codex 前预置 project trust 跳过 TUI 首启信任对话框。`COOLIE_CODEX_CONFIG` 覆盖
   * （测试注入临时文件防污染真实 ~/.codex/config.toml——Task6 零泄漏不变量）。缺省 undefined →
   * codex adapter 回落 defaultCodexConfigPath(codexHome)。 */
  readonly codexConfigPath?: string | undefined
  /** Plan3 Task15：首条 prompt 投递等待 SessionStart hook 就绪信号的上限（ms）；
   * 缺省 90000（要跑赢真实 claude 首启延迟——claude-mem 首会话播种记忆时 SessionStart 实测 ~22.3s，
   * 20s 门控会早约 2s 超时误降级 → 吞字；留足余量）。`COOLIE_PROMPT_READY_TIMEOUT_MS` 可覆盖，
   * 测试用极小值快速练到超时降级路径。 */
  readonly promptReadyTimeoutMs?: number
  /** codex 无-hooks 通路的后台回填 watcher 上限（ms）。投递**不**等 rollout——TUI 的 rollout 首 turn
   * 才懒落盘（RE-SMOKE 实测），投递前门控即死锁；create 后布防 watcher 盯 rollout 出现 → 回填
   * engineSessionId + engine.session.started。首条 composer 输入可能在 create 数分钟后才来 → 上限
   * 给宽，缺省 30min，超限自停（防永久盯扫）。`COOLIE_ROLLOUT_BACKFILL_MAX_MS` 覆盖，测试用小值。 */
  readonly rolloutBackfillMaxMs?: number
  /** .coolie setup/init watchdog. */
  readonly initTimeoutMs?: number
}
export class CoolieConfig extends Context.Tag("CoolieConfig")<CoolieConfig, CoolieConfigShape>() {}

export const CoolieConfigLive = Layer.sync(CoolieConfig, () => {
  const home = process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie")
  return {
    home,
    dbPath: path.join(home, "coolie.db"),
    serverInfoPath: path.join(home, "server.json"),
    sockPath: path.join(home, "coolie.sock"),
    workspacesRoot: process.env.COOLIE_WORKSPACES_ROOT ?? path.join(os.homedir(), "coolie", "workspaces"),
    tmuxSocket: process.env.COOLIE_TMUX_SOCKET ?? "coolie",
    claudeHome: process.env.COOLIE_CLAUDE_HOME ?? path.join(os.homedir(), ".claude"),
    codexHome: process.env.COOLIE_CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    claudeConfigPath: process.env.COOLIE_CLAUDE_CONFIG ?? path.join(os.homedir(), ".claude.json"),
    // 缺省 undefined → codex adapter 回落 defaultCodexConfigPath(codexHome)；测试用 COOLIE_CODEX_CONFIG 指向临时文件。
    codexConfigPath: process.env.COOLIE_CODEX_CONFIG,
    promptReadyTimeoutMs: Number(process.env.COOLIE_PROMPT_READY_TIMEOUT_MS ?? 90_000),
    rolloutBackfillMaxMs: Number(process.env.COOLIE_ROLLOUT_BACKFILL_MAX_MS ?? 30 * 60_000),
    initTimeoutMs: Number(process.env.COOLIE_INIT_TIMEOUT_MS ?? 10 * 60_000),
  }
})
