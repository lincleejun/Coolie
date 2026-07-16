import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.join(rootDir, "packages/client")

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./packages/client/e2e/tauri/**/*.spec.ts"],
  exclude: ["./packages/client/e2e/tauri/fixtures/**"],
  maxInstances: 1,
  capabilities: [{
    browserName: "webkit",
    "wdio:tauriOptions": {
      application: path.join(clientRoot, "src-tauri"),
      configPath: path.join(clientRoot, "src-tauri/tauri.test.conf.json"),
    },
  }],
  logLevel: "info",
  outputDir: path.join(clientRoot, "e2e/tauri/artifacts/logs"),
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
    ["junit", { outputDir: path.join(clientRoot, "e2e/tauri/artifacts/junit") }],
  ],
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
  before: async () => {
    process.env.TZ = "UTC"
    process.env.LANG = "en_US.UTF-8"
  },
  afterTest: async (_test, _context, { error }) => {
    if (!error) return
    const stamp = Date.now()
    try {
      await browser.saveScreenshot(path.join(clientRoot, `e2e/tauri/artifacts/screenshots/failure-${stamp}.png`))
    } catch {
      // best-effort failure artifact
    }
  },
}

export default config
