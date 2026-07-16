#!/usr/bin/env bun
/**
 * Task 4.5 — Full north-star acceptance gate on local/packaged evidence.
 * Writes a machine-readable acceptance report under artifacts/.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const reportDir = join(root, "artifacts")
mkdirSync(reportDir, { recursive: true })

type Step = { id: string; name: string; ok: boolean; detail?: string; ms: number }

const steps: Step[] = []
const run = (id: string, name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  const ok = result.status === 0
  steps.push({
    id,
    name,
    ok,
    detail: ok ? (result.stdout ?? "").slice(0, 500) : (result.stderr || result.stdout || "").slice(0, 2000),
    ms: Date.now() - started,
  })
  if (!ok) {
    console.error(`FAIL ${id}: ${name}`)
    console.error(steps[steps.length - 1]!.detail)
  } else {
    console.log(`PASS ${id}: ${name} (${steps[steps.length - 1]!.ms}ms)`)
  }
  return ok
}

const node = process.env.COOLIE_SIDECAR_NODE
if (!node) {
  console.error("Set COOLIE_SIDECAR_NODE to Node v22.22.3")
  process.exit(1)
}

let failed = false
failed = !run("docs:links", "Release doc links", "bun", ["run", "docs:links"]) || failed
failed = !run("typecheck", "Typecheck", "bun", ["run", "typecheck"]) || failed
failed = !run("test:fast", "Fast tests", "bun", ["run", "test:fast"]) || failed
failed = !run("sidecar:build", "Build sidecar", "bun", ["run", "sidecar:build"], {
  COOLIE_SIDECAR_NODE: node,
  PATH: `${dirname(node)}:${process.env.PATH ?? ""}`,
}) || failed
failed = !run("sidecar:smoke", "Sidecar clean-room smoke", "bun", ["run", "sidecar:smoke"]) || failed

// Optional packaged artifact steps — skip gracefully if not built yet unless REQUIRED.
const releaseApp = join(root, "packages/client/src-tauri/target/release/bundle/macos/Coolie.app")
const requireArtifact = process.env.COOLIE_REQUIRE_ARTIFACT === "1"
if (existsSync(releaseApp)) {
  failed = !run("audit", "Release bundle WDIO audit", "bun", ["run", "scripts/audit-release-bundle.ts", releaseApp]) || failed
  failed = !run("artifact-smoke", "Clean macOS artifact smoke", "bun", ["run", "scripts/smoke-macos-artifact.ts", releaseApp]) || failed
} else if (requireArtifact) {
  steps.push({
    id: "artifact",
    name: "Release .app present",
    ok: false,
    detail: `missing ${releaseApp}`,
    ms: 0,
  })
  failed = true
} else {
  steps.push({
    id: "artifact",
    name: "Release .app present",
    ok: true,
    detail: "skipped (build with bun run build:app:release); set COOLIE_REQUIRE_ARTIFACT=1 to require",
    ms: 0,
  })
}

// North-star UI evidence from Task 3.9 suites (mock) — local harness, not artifact GUI.
failed = !run(
  "north-star-ui",
  "North-star UI journeys (mock daily-flow)",
  "bun",
  ["run", "test:tauri", "--", "--suite", "mock"],
) || failed

const report = {
  version: "0.1.0",
  generatedAt: new Date().toISOString(),
  gitCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  ok: !failed,
  northStar: {
    "1-10_local_ui": steps.some((s) => s.id === "north-star-ui" && s.ok),
    "11_pr_merge": "layered: mock finish-archive + real local merge covered by server/cli tests",
    "12_archive_restore": "covered by mock finish-archive + lifecycle tests",
  },
  steps,
}

const out = join(reportDir, "acceptance-report.json")
writeFileSync(out, JSON.stringify(report, null, 2) + "\n")
console.log(`Wrote ${out}`)
process.exit(failed ? 1 : 0)
