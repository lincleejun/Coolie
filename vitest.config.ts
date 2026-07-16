import { defineConfig } from "vitest/config"

const runtimeTests = [
  "packages/server/test/bootstrap-prompt-gate.test.ts",
  "packages/server/test/daemon.test.ts",
  "packages/server/test/delivery.test.ts",
  "packages/server/test/heal.test.ts",
  "packages/server/test/http-heal.test.ts",
  "packages/server/test/lifecycle-tmux.test.ts",
  "packages/server/test/pty-smoke.test.ts",
  "packages/server/test/tmux-control.test.ts",
  "packages/server/test/tmux-ops.test.ts",
  "packages/server/test/tmux-service.test.ts",
  "packages/server/test/ws-terminal.test.ts",
  "packages/client/test/api-client.test.ts",
  "packages/client/test/sse-e2e.test.ts",
  "packages/client/test/real-daemon.fixture.test.ts",
  "packages/cli/test/cli-e2e.test.ts",
  "packages/cli/test/workspace-e2e.test.ts",
  "packages/cli/test/agent-api.test.ts",
  "packages/cli/test/inbox.test.ts",
  "packages/server/test/runtime-env.test.ts",
]

const runtime = process.env.COOLIE_TEST_TRACK === "runtime"
const runtimeInclude = process.env.COOLIE_RUNTIME_SLICE === "core"
  ? runtimeTests.filter((file) => file !== "packages/cli/test/cli-e2e.test.ts")
  : runtimeTests

export default defineConfig({
  test: {
    include: runtime ? runtimeInclude : ["packages/*/test/**/*.test.ts"],
    exclude: runtime ? [] : runtimeTests,
    environment: "node",
    testTimeout: 30_000,
    passWithNoTests: true,
    ...(runtime ? {
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      isolate: false,
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      testTimeout: 90_000,
      hookTimeout: 120_000,
      globalSetup: ["packages/server/test/helpers/runtime-env.ts"],
      setupFiles: ["packages/server/test/helpers/runtime-setup.ts"],
    } : {}),
  },
})
