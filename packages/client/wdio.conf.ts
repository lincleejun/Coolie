import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MOCK_E2E_PORT, MOCK_E2E_TOKEN } from "./e2e/tauri/fixtures/mock-daemon.js"
import { ensureMockHarness } from "./e2e/tauri/fixtures/harness.js"
import { ensureRealHarness } from "./e2e/tauri/fixtures/real-harness.js"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Prefer COOLIE_TAURI_SUITE — do not pass WDIO's --suite flag (it requires config.suites
// and races with our custom selection).
const suite = process.env.COOLIE_TAURI_SUITE ?? "all"

// @wdio/tauri-service v1 requires a built binary / .app — not a src-tauri directory.
const packagedAppBundle =
  process.env.COOLIE_PACKAGED_TEST_APP ??
  path.join(rootDir, "src-tauri/target/debug/bundle/macos/Coolie.app")

const applicationCandidates = [
  process.env.COOLIE_PACKAGED_TEST_BIN,
  path.join(packagedAppBundle, "Contents/MacOS/coolie-client"),
  path.join(packagedAppBundle, "Contents/MacOS/Coolie"),
  packagedAppBundle,
].filter((value): value is string => typeof value === "string" && value.length > 0)

const application = applicationCandidates.find((candidate) => existsSync(candidate))
if (!application) {
  throw new Error(
    `packaged test app missing at ${packagedAppBundle}. ` +
      "Run: COOLIE_SIDECAR_NODE=<node-v22.22.3> bun run build:packaged-test-app",
  )
}

const mockSpecs = ["./e2e/tauri/mock/**/*.spec.ts"]
const realSpecs = ["./e2e/tauri/real/**/*.spec.ts"]
const visualSpecs = ["./e2e/tauri/visual/**/*.spec.ts"]
const nativeSpecs = ["./e2e/tauri/native-contract.spec.ts"]
const allSpecs = ["./e2e/tauri/mock/**/*.spec.ts", "./e2e/tauri/smoke.spec.ts"]
const selectedSpecs =
  suite === "mock" ? mockSpecs
    : suite === "real" ? realSpecs
      : suite === "visual" ? visualSpecs
        : suite === "native" ? nativeSpecs
          : allSpecs

const e2eHome = path.join(rootDir, "e2e/tauri/artifacts/source-home")
const mockServer = `${MOCK_E2E_PORT}:${MOCK_E2E_TOKEN}`

// Spawn merges process.env then options.env. For real suite the daemon port is only
// known after onPrepare — omit COOLIE_E2E_SERVER here so onPrepare can set process.env.
const launchEnv: Record<string, string | undefined> = {
  COOLIE_HOME: e2eHome,
}
if (suite !== "real") {
  launchEnv.COOLIE_E2E_SERVER = mockServer
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: selectedSpecs,
  exclude: ["./e2e/tauri/fixtures/**"],
  maxInstances: 1,
  capabilities: [{
    // @wdio/tauri-service@1.2 only accepts browserName tauri|wry (webkit is deleted/rejected).
    browserName: "tauri",
    "tauri:options": {
      application,
    },
    "wdio:tauriOptions": {
      application,
    },
  }],
  logLevel: "info",
  outputDir: path.join(rootDir, "e2e/tauri/artifacts/logs"),
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,
  services: [[
    "@wdio/tauri-service",
    {
      driverProvider: "embedded",
      embeddedPort: 4445,
      captureBackendLogs: true,
      captureFrontendLogs: true,
      env: launchEnv,
    },
  ]],
  framework: "mocha",
  reporters: [
    "spec",
    ["junit", { outputDir: path.join(rootDir, "e2e/tauri/artifacts/junit") }],
  ],
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
  onPrepare: async () => {
    if (suite === "real") {
      const daemon = await ensureRealHarness()
      const realServer = `${daemon.port}:${daemon.token}`
      process.env.VITE_COOLIE_MOCK_SERVER = realServer
      process.env.COOLIE_E2E_SERVER = realServer
      return
    }
    if (suite === "mock" || suite === "all" || suite === "visual" || suite === "native") {
      await ensureMockHarness()
      process.env.VITE_COOLIE_MOCK_SERVER = mockServer
      process.env.COOLIE_E2E_SERVER = mockServer
    }
  },
  before: async () => {
    process.env.TZ = "UTC"
    process.env.LANG = "en_US.UTF-8"
    if (suite === "real") {
      const daemon = await ensureRealHarness()
      const realServer = `${daemon.port}:${daemon.token}`
      process.env.VITE_COOLIE_MOCK_SERVER = realServer
      process.env.COOLIE_E2E_SERVER = realServer
      return
    }
    if (suite === "mock" || suite === "all" || suite === "visual" || suite === "native") {
      await ensureMockHarness()
    }
  },
  afterTest: async (_test, _context, { error }) => {
    if (!error) return
    const stamp = Date.now()
    try {
      await browser.saveScreenshot(path.join(rootDir, `e2e/tauri/artifacts/screenshots/failure-${stamp}.png`))
    } catch {
      // best-effort failure artifact
    }
  },
}

export default config
