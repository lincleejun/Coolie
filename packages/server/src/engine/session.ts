import { Effect } from "effect"
import { tmuxSessionName, type Workspace } from "@coolie/protocol"
import { TmuxError, type TmuxServiceShape } from "../tmux/service.js"
import type { Engine } from "./types.js"
import { ensureKeepAliveScript, wrapEngineCommand } from "./keepalive.js"
import { portEnv } from "../workspace/ports.js"

export interface StartEngineSessionInput {
  readonly ws: Workspace
  readonly repoRoot: string
  readonly engine: Engine
  readonly sessionId: string
  readonly resume: boolean
  readonly home: string
}

/**
 * 建 tmux session + window 0 = keep-alive 包装的 engine（bootstrap 的 create 与
 * SessionEnsurer 的 heal 共用；env 经 new-session -e 进 session environment，
 * 之后的 respawn-window 自动继承，不重复注入）。
 */
export const startEngineSession = (
  tmux: TmuxServiceShape, i: StartEngineSessionInput,
): Effect.Effect<{ sessionName: string; engineCommand: string[] }, TmuxError> =>
  Effect.gen(function* () {
    const sessionName = tmuxSessionName(i.ws.id)
    const engineCommand = i.engine.launchCommand({ sessionId: i.sessionId, resume: i.resume })
    yield* Effect.try({
      try: () => ensureKeepAliveScript(i.home),
      catch: (e) => new TmuxError({ op: "keepalive-script", message: `keep-alive 脚本写入失败：${String(e)}`, exitCode: null, stderr: "" }),
    })
    yield* tmux.newSession({
      name: sessionName, cwd: i.ws.path, windowName: "engine",
      command: wrapEngineCommand(i.home, i.ws.id, engineCommand),
      env: { COOLIE_ROOT: i.repoRoot, COOLIE_WORKSPACE: i.ws.id, ...portEnv(i.ws.portBase) },
    })
    return { sessionName, engineCommand }
  })
