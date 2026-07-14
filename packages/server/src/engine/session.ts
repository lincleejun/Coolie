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
  readonly sessionId: string | null   // F7：codex=null（服务端造 id）；claude=uuid
  readonly resume: boolean
  readonly home: string
  readonly model?: string
  readonly effort?: string
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
    // F7 唯一合并点：codex launchCommand 本就忽略 sessionId（除 resume），空串安全；
    // claude resume 时 i.sessionId 必非 null。string|null 到此收敛为 launchCommand 要求的 string。
    const engineCommand = i.engine.launchCommand({
      sessionId: i.sessionId ?? "",
      resume: i.resume,
      // Hooks-capable lanes report Stop through /hooks; only hooks-off engines receive notify context.
      ...(!i.engine.capabilities.hooks ? { workspaceId: i.ws.id, home: i.home } : {}),
      ...(i.model !== undefined ? { model: i.model } : {}),
      ...(i.effort !== undefined ? { effort: i.effort } : {}),
    })
    yield* Effect.try({
      try: () => ensureKeepAliveScript(i.home),
      catch: (e) => new TmuxError({ op: "keepalive-script", message: `keep-alive 脚本写入失败：${String(e)}`, exitCode: null, stderr: "" }),
    })
    const command = wrapEngineCommand(i.home, i.ws.id, engineCommand)
    if (yield* tmux.hasSession(sessionName)) {
      // setup lane 已提前建立 placeholder engine@0；仅在全部 setup 成功后原位替换。
      yield* tmux.respawnWindow({ session: sessionName, window: 0, cwd: i.ws.path, command })
    } else {
      yield* tmux.newSession({
        name: sessionName, cwd: i.ws.path, windowName: "engine",
        command,
        env: { COOLIE_ROOT: i.repoRoot, COOLIE_WORKSPACE: i.ws.id, ...portEnv(i.ws.portBase) },
      })
    }
    return { sessionName, engineCommand }
  })
