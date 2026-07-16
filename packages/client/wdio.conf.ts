import path from "node:path"
import { fileURLToPath } from "node:url"
import { MOCK_E2E_PORT, MOCK_E2E_TOKEN } from "./e2e/tauri/fixtures/mock-daemon.js"
import { ensureMockHarness } from "./e2e/tauri/fixtures/harness.js"
import { ensureRealHarness } from "./e2e/tauri/fixtures/real-harness.js"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

const suiteArg = process.argv.indexOf("--suite")
const suite = suiteArg >= 0 ? process.argv[suiteArg + 1] : "all"

const mockSpecs = ["./e2e/tauri/mock/**/*.spec.ts"]
const realSpecs = ["./e2e/tauri/real/**/*.spec.ts"]
const visualSpecs = ["./e2e/tauri/visual/**/*.spec.ts"]
const allSpecs = ["./e2e/tauri/mock/**/*.spec.ts", "./e2e/tauri/smoke.spec.ts"]

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: suite === "mock" ? mockSpecs
    : suite === "real" ? realSpecs
      : suite === "visual" ? visualSpecs
        : allSpecs,
  exclude: ["./e2e/tauri/fixtures/**"],
  maxInstances: suite === "real" ? 1 : 1,
  capabilities: [{
    browserName: "webkit",
    "wdio:tauriOptions": {
      application: path.join(rootDir, "src-tauri"),
      configPath: path.join(rootDir, "src-tauri/tauri.test.conf.json"),
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
      process.env.VITE_COOLIE_MOCK_SERVER = `${daemon.port}:${daemon.token}`
      return
    }
    if (suite === "mock" || suite === "all") {
      await ensureMockHarness()
      process.env.VITE_COOLIE_MOCK_SERVER = `${MOCK_E2E_PORT}:${MOCK_E2E_TOKEN}`
    }
    if (suite === "visual") {
      await ensureMockHarness()
      process.env.VITE_COOLIE_MOCK_SERVER = `${MOCK_E2E_PORT}:${MOCK_E2E_TOKEN}`
    }
  },
  before: async () => {
    process.env.TZ = "UTC"
    process.env.LANG = "en_US.UTF-8"
    if (suite === "real") {
      const daemon = await ensureRealHarness()
      process.env.VITE_COOLIE_MOCK_SERVER = `${daemon.port}:${daemon.token}`
      return
    }
    if (suite === "mock" || suite === "all") await ensureMockHarness()
    if (suite === "visual") await ensureMockHarness()
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
