/**
 * Task 4.2 — drive the packaged debug test artifact (sidecar + WDIO plugins).
 * Release binaries are audited separately and must not include WDIO.
 */
import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MOCK_E2E_PORT, MOCK_E2E_TOKEN } from "./e2e/tauri/fixtures/mock-daemon.js"
import { ensureMockHarness } from "./e2e/tauri/fixtures/harness.js"

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const suite = process.env.COOLIE_PACKAGED_SUITE ?? "packaged"

const packagedAppBundle =
  process.env.COOLIE_PACKAGED_TEST_APP ??
  path.join(rootDir, "src-tauri/target/debug/bundle/macos/Coolie.app")

const packagedBinaryCandidates = [
  process.env.COOLIE_PACKAGED_TEST_BIN,
  path.join(packagedAppBundle, "Contents/MacOS/coolie-client"),
  path.join(packagedAppBundle, "Contents/MacOS/Coolie"),
  packagedAppBundle,
].filter((value): value is string => typeof value === "string" && value.length > 0)

const packagedApp = packagedBinaryCandidates.find((candidate) => existsSync(candidate))
if (!packagedApp) {
  throw new Error(
    `packaged test app missing at ${packagedAppBundle}. Run: COOLIE_SIDECAR_NODE=... bun run build:packaged-test-app`,
  )
}

const nativeSpecs = ["./e2e/tauri/native-contract.spec.ts"]
const mockSmoke = ["./e2e/tauri/smoke.spec.ts", "./e2e/tauri/mock/connection.spec.ts"]
const specs =
  suite === "native" ? nativeSpecs
    : suite === "mock" ? mockSmoke
      : [...mockSmoke, ...nativeSpecs]

const e2eHome = path.join(rootDir, "e2e/tauri/artifacts/packaged-home")

export const config: WebdriverIO.Config = {
  runner: "local",
  specs,
  exclude: ["./e2e/tauri/fixtures/**"],
  maxInstances: 1,
  capabilities: [{
    browserName: "tauri",
    "tauri:options": {
      application: packagedApp,
    },
    "wdio:tauriOptions": {
      application: packagedApp,
    },
  }],
  logLevel: "info",
  outputDir: path.join(rootDir, "e2e/tauri/artifacts/logs-release"),
  bail: 0,
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 2,
  services: [[
    "@wdio/tauri-service",
    {
      driverProvider: "embedded",
      embeddedPort: 4446,
      captureBackendLogs: true,
      captureFrontendLogs: true,
      env: {
        ...process.env,
        COOLIE_HOME: e2eHome,
        COOLIE_E2E_SERVER: suite === "native" && process.env.COOLIE_PACKAGED_NATIVE_NO_MOCK === "1"
          ? ""
          : `${MOCK_E2E_PORT}:${MOCK_E2E_TOKEN}`,
      },
    },
  ]],
  framework: "mocha",
  reporters: [
    "spec",
    ["junit", { outputDir: path.join(rootDir, "e2e/tauri/artifacts/junit-release") }],
  ],
  mochaOpts: {
    ui: "bdd",
    timeout: 180000,
  },
  onPrepare: async () => {
    await ensureMockHarness()
    process.env.VITE_COOLIE_MOCK_SERVER = `${MOCK_E2E_PORT}:${MOCK_E2E_TOKEN}`
  },
  before: async () => {
    process.env.TZ = "UTC"
    process.env.LANG = "en_US.UTF-8"
    // Prefer attach to launcher-owned mock; do not race a second bind.
    await ensureMockHarness()
  },
  afterTest: async (_test, _context, { error }) => {
    if (!error) return
    const stamp = Date.now()
    try {
      await browser.saveScreenshot(
        path.join(rootDir, `e2e/tauri/artifacts/screenshots/release-failure-${stamp}.png`),
      )
    } catch {
      /* best-effort */
    }
  },
}

export default config
