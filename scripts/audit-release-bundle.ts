#!/usr/bin/env bun
/**
 * Task 4.2 — assert a release .app has no WDIO test plugins/servers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const app = resolve(process.argv[2] ?? "packages/client/src-tauri/target/release/bundle/macos/Coolie.app")
if (!existsSync(app)) {
  console.error(`release app not found: ${app}`)
  process.exit(1)
}

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })

const files = listFiles(app)
const forbidden = [/wdio/i, /webdriver/i, /tauri-plugin-wdio/i]
const hits: string[] = []
for (const file of files) {
  const rel = relative(app, file)
  if (forbidden.some((pattern) => pattern.test(rel))) hits.push(rel)
  // binary name / rpath scan on small text-ish files
  if (statSync(file).size < 2_000_000 && /\.(json|plist|js|mjs|cjs|txt|md)$/i.test(file)) {
    const text = readFileSync(file, "utf8")
    if (forbidden.some((pattern) => pattern.test(text))) hits.push(rel)
  }
}

const sidecarNode = join(app, "Contents/Resources/sidecar/node")
const sidecarServer = join(app, "Contents/Resources/sidecar/server.cjs")
// Tauri may nest resources differently; also accept Resources/_up_/ or similar.
const sidecarOk =
  existsSync(sidecarNode) ||
  files.some((f) => f.endsWith("/sidecar/node")) && files.some((f) => f.endsWith("/sidecar/server.cjs"))

if (!sidecarOk) {
  console.error("release app missing sidecar/node or server.cjs")
  process.exit(1)
}
if (hits.length > 0) {
  console.error("release bundle contains WDIO/test plugin references:\n" + hits.slice(0, 40).join("\n"))
  process.exit(1)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      app,
      files: files.length,
      hasSidecar: true,
      wdioFree: true,
    },
    null,
    2,
  ),
)
