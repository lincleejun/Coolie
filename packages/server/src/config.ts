import { Context, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"

export interface CoolieConfigShape {
  readonly home: string
  readonly dbPath: string
  readonly serverInfoPath: string
  readonly workspacesRoot: string
  /** tmux 专属 socket 名（tmux -L <socket>）；测试注入 coolie-test-* 隔离 */
  readonly tmuxSocket: string
  /** claude 引擎自己的数据目录（转录所在）；测试注入临时目录 */
  readonly claudeHome: string
  /** Plan3 Task15：首条 prompt 投递等待 SessionStart hook 就绪信号的上限（ms）；
   * 缺省 90000（要跑赢真实 claude 首启延迟——claude-mem 首会话播种记忆时 SessionStart 实测 ~22.3s，
   * 20s 门控会早约 2s 超时误降级 → 吞字；留足余量）。`COOLIE_PROMPT_READY_TIMEOUT_MS` 可覆盖，
   * 测试用极小值快速练到超时降级路径。 */
  readonly promptReadyTimeoutMs?: number
}
export class CoolieConfig extends Context.Tag("CoolieConfig")<CoolieConfig, CoolieConfigShape>() {}

export const CoolieConfigLive = Layer.sync(CoolieConfig, () => {
  const home = process.env.COOLIE_HOME ?? path.join(os.homedir(), ".coolie")
  return {
    home,
    dbPath: path.join(home, "coolie.db"),
    serverInfoPath: path.join(home, "server.json"),
    workspacesRoot: process.env.COOLIE_WORKSPACES_ROOT ?? path.join(os.homedir(), "coolie", "workspaces"),
    tmuxSocket: process.env.COOLIE_TMUX_SOCKET ?? "coolie",
    claudeHome: process.env.COOLIE_CLAUDE_HOME ?? path.join(os.homedir(), ".claude"),
    promptReadyTimeoutMs: Number(process.env.COOLIE_PROMPT_READY_TIMEOUT_MS ?? 90_000),
  }
})
