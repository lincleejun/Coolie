#!/usr/bin/env bun
/**
 * Bun may keep @wdio/native-utils@2.4.0 nested under tauri-service even when
 * overrides request 2.5.0. Copy 2.5.0 into any lingering 2.4.0 slots so WDIO
 * can import installMockSyncOverride.
 */
import { cpSync, existsSync, readdirSync, rmSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const bunDir = join(root, "node_modules/.bun")
if (!existsSync(bunDir)) process.exit(0)

const entries = readdirSync(bunDir)
const srcEntry = entries.find((name) => name.startsWith("@wdio+native-utils@2.5.0"))
if (!srcEntry) {
  console.error("native-utils 2.5.0 not installed; bun install first")
  process.exit(1)
}
const src = join(bunDir, srcEntry, "node_modules/@wdio/native-utils")
for (const name of entries.filter((n) => n.startsWith("@wdio+native-utils@2.4."))) {
  const dest = join(bunDir, name, "node_modules/@wdio/native-utils")
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  const version = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")).version
  console.log(`patched ${name} -> ${version}`)
}
