/** Task 4 实现真身：持久 tmux control-mode client。此处先立类型契约。 */
export interface ControlClient {
  readonly exec: (command: string) => Promise<void>
  readonly dispose: () => void
  readonly isAlive: () => boolean
  readonly childPid: () => number | null
}
