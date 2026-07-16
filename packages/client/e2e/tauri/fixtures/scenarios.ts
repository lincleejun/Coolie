/** Named programmable mock-daemon scenarios for Tauri suites (Task 2C.2). */
import type { MockDaemonControl } from "./mock-daemon.js"

export interface MockScenario {
  readonly name: string
  readonly setup: (daemon: MockDaemonControl) => Promise<void> | void
}

export const emptyStateScenario: MockScenario = {
  name: "empty-state",
  setup: (daemon) => { daemon.reset() },
}

export const offlineReplayScenario: MockScenario = {
  name: "offline-replay",
  async setup(daemon) {
    daemon.reset()
    daemon.emitEvent({ type: "project.added", workspaceId: null, payload: { id: "p1" } })
    daemon.disconnectSseClients()
  },
}

export const parallelSafeScenario = (suffix: string): MockScenario => ({
  name: `parallel-${suffix}`,
  setup: (daemon) => {
    daemon.reset()
    daemon.emitEvent({
      type: "workspace.created",
      workspaceId: `w-${suffix}`,
      payload: { id: `w-${suffix}`, name: suffix },
    })
  },
})

export const runScenario = async (
  daemon: MockDaemonControl,
  scenario: MockScenario,
): Promise<void> => {
  await scenario.setup(daemon)
}
