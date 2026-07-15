import { runtimeTmuxKillSessions } from "./runtime-env.js"

export default function resetRuntimeTmuxSocket(): void {
  runtimeTmuxKillSessions()
}
