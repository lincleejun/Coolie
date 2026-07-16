#!/usr/bin/env bun
/** Task 4.6 — verify local markdown links among release docs + README. */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const files = [
  "README.md",
  "docs/installation.md",
  "docs/security.md",
  "docs/troubleshooting.md",
]

let failed = false
for (const rel of files) {
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    console.error(`missing ${rel}`)
    failed = true
    continue
  }
  const text = readFileSync(abs, "utf8")
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!)
  for (const link of links) {
    if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("#") || link.startsWith("mailto:"))
      continue
    const target = resolve(dirname(abs), link.split("#")[0]!)
    if (!existsSync(target)) {
      console.error(`${rel} -> missing ${link}`)
      failed = true
    }
  }
}
if (failed) process.exit(1)
console.log(JSON.stringify({ ok: true, files: files.length }, null, 2))
