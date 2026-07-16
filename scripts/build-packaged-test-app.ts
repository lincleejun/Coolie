#!/usr/bin/env bun
/**
 * Task 4.2 — build a debug macOS .app that includes:
 * - Wave 4.1 sidecar resources
 * - WDIO embedded plugins (debug_assertions)
 * - packaged frontend (no checkout absolute paths)
 *
 * Output: packages/client/src-tauri/target/debug/bundle/macos/Coolie.app
 */
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const nodeBin = process.env.COOLIE_SIDECAR_NODE ?? process.execPath

const run = (command: string, args: string[], cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!process.env.COOLIE_SIDECAR_NODE) {
  console.error("COOLIE_SIDECAR_NODE must point at Node v22.22.3 for sidecar ABI matching")
  process.exit(1)
}

process.env.COOLIE_SIDECAR_NODE = resolve(nodeBin)
process.env.PATH = `${dirname(process.env.COOLIE_SIDECAR_NODE)}:${process.env.PATH ?? ""}`

run("bun", ["run", "sidecar:build"])
run("bun", ["run", "build:app:test"], join(root, "packages/client"))

const app = join(root, "packages/client/src-tauri/target/debug/bundle/macos/Coolie.app")
if (!existsSync(app)) {
  console.error(`expected packaged test app at ${app}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, app }, null, 2))
