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
  }
})
