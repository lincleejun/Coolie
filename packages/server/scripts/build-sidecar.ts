#!/usr/bin/env bun
/**
 * Wave 4.1 production sidecar packager (ADR-005 option A).
 * Bundles pinned Node + server.cjs + pruned native closure + licenses + SHA-256 manifest.
 * Does not download Node; set COOLIE_SIDECAR_NODE to the exact v22.22.3 binary.
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const EXPECTED_NODE_VERSION = "v22.22.3"
const EXPECTED_NODE_MODULES_ABI = "127"
const COOLIE_VERSION = "0.1.0"

const args = process.argv.slice(2)
const selfCheck = args.includes("--self-check")
const outArg = args.find((arg) => !arg.startsWith("--"))
const out = resolve(outArg ?? join(root, "packages/server/dist/sidecar"))
const tauriResources = join(root, "packages/client/src-tauri/resources/sidecar")
const runtimePath = resolve(process.env.COOLIE_SIDECAR_NODE ?? process.execPath)
const nativeModules = process.env.COOLIE_SIDECAR_NATIVE_MODULES
  ? resolve(process.env.COOLIE_SIDECAR_NATIVE_MODULES)
  : join(root, "packages/server")

const fail = (message: string, cause?: unknown): never => {
  const detail = cause instanceof Error ? `\nCause: ${cause.message}` : ""
  console.error(`sidecar build failed: ${message}${detail}`)
  process.exit(1)
}

const run = (command: string, argv: string[], options: { cwd?: string; stdio?: "inherit" | "pipe" } = {}) =>
  execFileSync(command, argv, { cwd: root, stdio: "inherit", ...options })

const inspectRuntime = () => {
  try {
    return JSON.parse(
      execFileSync(
        runtimePath,
        [
          "-p",
          "JSON.stringify({version:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch})",
        ],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ) as { version: string; modules: string; platform: string; arch: string }
  } catch (error) {
    fail(
      `cannot execute candidate runtime ${runtimePath}. Set COOLIE_SIDECAR_NODE to Node ${EXPECTED_NODE_VERSION}.`,
      error,
    )
  }
}

const runtimeInfo = inspectRuntime()
if (runtimeInfo.version !== EXPECTED_NODE_VERSION || runtimeInfo.modules !== EXPECTED_NODE_MODULES_ABI)
  fail(
    `expected Node ${EXPECTED_NODE_VERSION} / ABI ${EXPECTED_NODE_MODULES_ABI}, ` +
      `got ${runtimeInfo.version ?? "unknown"} / ABI ${runtimeInfo.modules ?? "unknown"} from ${runtimePath}`,
  )
if (runtimeInfo.platform !== process.platform || runtimeInfo.arch !== process.arch)
  fail(
    `candidate runtime ${runtimeInfo.platform}-${runtimeInfo.arch} does not match host ` +
      `${process.platform}-${process.arch}`,
  )
const target = `${runtimeInfo.platform}-${runtimeInfo.arch}`
const gitCommit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
})()

const packageRoot = (name: string) =>
  dirname(require.resolve(`${name}/package.json`, { paths: [nativeModules] }))

let sqlitePackage: string
let ptyPackage: string
try {
  sqlitePackage = packageRoot("better-sqlite3")
  ptyPackage = packageRoot("node-pty")
  execFileSync(
    runtimePath,
    [
      "-e",
      [
        `const Database = require(${JSON.stringify(sqlitePackage)})`,
        "const db = new Database(':memory:')",
        "db.prepare('select 1').get()",
        "db.close()",
        `require(${JSON.stringify(ptyPackage)})`,
      ].join(";"),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  )
} catch (error) {
  fail(
    `native addons missing or ABI mismatch for Node ${EXPECTED_NODE_VERSION}. ` +
      `Rebuild with: PATH="$(dirname "$COOLIE_SIDECAR_NODE"):$PATH" bun install --frozen-lockfile --force`,
    error,
  )
}

if (selfCheck) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        runtimePath,
        runtime: runtimeInfo,
        nativeModules,
        out,
        tauriResources,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const copyFile = (source: string, destination: string) => {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

const copyTree = (source: string, destination: string) => {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true })
}

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

const findLicense = (pkgDir: string): string | null => {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "License"]) {
    const candidate = join(pkgDir, name)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const nodeLicenseSource = (() => {
  const beside = join(dirname(runtimePath), "..", "LICENSE")
  if (existsSync(beside)) return resolve(beside)
  const sibling = join(dirname(runtimePath), "LICENSE")
  if (existsSync(sibling)) return sibling
  fail(`cannot find Node LICENSE next to ${runtimePath}`)
})()

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const bundle = join(out, "server.cjs")
run("bun", [
  "build",
  "packages/server/src/main.ts",
  "--target=node",
  "--format=cjs",
  `--outfile=${bundle}`,
  "--external",
  "better-sqlite3",
  "--external",
  "node-pty",
])

// Production entry must not include SEA createRequire bridge.
const bundled = readFileSync(bundle, "utf8").replace(/^#![^\n]*\n/, "")
if (bundled.includes("__coolieCreateRequire") || bundled.includes("NODE_SEA"))
  fail("bundled server unexpectedly contains SEA bridge markers")
writeFileSync(bundle, `#!/usr/bin/env node\n${bundled}`)

copyFile(runtimePath, join(out, "node"))
chmodSync(join(out, "node"), 0o755)

const modules = join(out, "node_modules")
const sqliteRequire = createRequire(join(sqlitePackage, "package.json"))
const bindings = dirname(sqliteRequire.resolve("bindings/package.json"))
const bindingsRequire = createRequire(join(bindings, "package.json"))
const fileUri = dirname(bindingsRequire.resolve("file-uri-to-path/package.json"))

copyFile(join(sqlitePackage, "package.json"), join(modules, "better-sqlite3/package.json"))
copyTree(join(sqlitePackage, "lib"), join(modules, "better-sqlite3/lib"))
copyFile(
  join(sqlitePackage, "build/Release/better_sqlite3.node"),
  join(modules, "better-sqlite3/build/Release/better_sqlite3.node"),
)

copyFile(join(ptyPackage, "package.json"), join(modules, "node-pty/package.json"))
mkdirSync(join(modules, "node-pty/lib"), { recursive: true })
for (const entry of readdirSync(join(ptyPackage, "lib"), { withFileTypes: true })) {
  if (!entry.isFile()) continue
  if (entry.name.endsWith(".test.js")) continue
  copyFile(join(ptyPackage, "lib", entry.name), join(modules, "node-pty/lib", entry.name))
}
const prebuild = join(ptyPackage, "prebuilds", target)
if (!existsSync(prebuild)) fail(`missing node-pty prebuild for ${target} at ${prebuild}`)
copyTree(prebuild, join(modules, "node-pty/prebuilds", target))
chmodSync(join(modules, "node-pty/prebuilds", target, "spawn-helper"), 0o755)

copyFile(join(bindings, "package.json"), join(modules, "bindings/package.json"))
copyFile(join(bindings, "bindings.js"), join(modules, "bindings/bindings.js"))
copyFile(join(fileUri, "package.json"), join(modules, "file-uri-to-path/package.json"))
copyFile(join(fileUri, "index.js"), join(modules, "file-uri-to-path/index.js"))

const licenses = join(out, "licenses")
mkdirSync(licenses, { recursive: true })
copyFile(nodeLicenseSource, join(licenses, "node-LICENSE"))
for (const [name, dir] of [
  ["better-sqlite3", sqlitePackage],
  ["bindings", bindings],
  ["file-uri-to-path", fileUri],
  ["node-pty", ptyPackage],
] as const) {
  const license = findLicense(dir)
  if (!license) fail(`missing LICENSE for ${name} in ${dir}`)
  copyFile(license, join(licenses, `${name}-LICENSE`))
}

const notices = [
  "Coolie 0.1.0 bundled JavaScript third-party notices",
  "",
  "The sidecar server.cjs bundle includes code from:",
  "- @coolie/protocol (workspace)",
  "- effect",
  "- ulid",
  "- ws",
  "",
  "Native packages better-sqlite3 and node-pty remain external with adjacent LICENSE files.",
  "Node.js runtime LICENSE is licenses/node-LICENSE.",
  "",
].join("\n")
writeFileSync(join(licenses, "bundled-js-THIRD_PARTY_NOTICES"), notices)

const allowedExact = new Set([
  "node",
  "server.cjs",
  "manifest.json",
  "node_modules/better-sqlite3/package.json",
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/bindings/package.json",
  "node_modules/bindings/bindings.js",
  "node_modules/file-uri-to-path/package.json",
  "node_modules/file-uri-to-path/index.js",
  "node_modules/node-pty/package.json",
  `node_modules/node-pty/prebuilds/${target}/pty.node`,
  `node_modules/node-pty/prebuilds/${target}/spawn-helper`,
  "licenses/node-LICENSE",
  "licenses/better-sqlite3-LICENSE",
  "licenses/bindings-LICENSE",
  "licenses/file-uri-to-path-LICENSE",
  "licenses/node-pty-LICENSE",
  "licenses/bundled-js-THIRD_PARTY_NOTICES",
])

const allowedPrefixes = [
  "node_modules/better-sqlite3/lib/",
  "node_modules/node-pty/lib/",
]

const isAllowed = (rel: string) => {
  if (allowedExact.has(rel)) return true
  return allowedPrefixes.some((prefix) => rel.startsWith(prefix) && !rel.includes(".."))
}

// Write provisional files list before manifest, then emit manifest excluding itself.
const preManifestFiles = listFiles(out).map((path) => relative(out, path).split("\\").join("/"))
for (const rel of preManifestFiles) {
  if (!isAllowed(rel) && rel !== "manifest.json")
    fail(`unexpected sidecar file (not in ADR allowlist): ${rel}`)
}
for (const required of allowedExact) {
  if (required === "manifest.json") continue
  if (!existsSync(join(out, required))) fail(`missing required sidecar file: ${required}`)
}

const spawnHelper = join(out, `node_modules/node-pty/prebuilds/${target}/spawn-helper`)
const mode = statSync(spawnHelper).mode & 0o777
if ((mode & 0o111) === 0) fail(`spawn-helper is not executable: mode=${mode.toString(8)}`)

const fileEntries = listFiles(out)
  .map((path) => {
    const rel = relative(out, path).split("\\").join("/")
    const st = statSync(path)
    return {
      path: rel,
      bytes: st.size,
      mode: (st.mode & 0o777).toString(8),
      executable: (st.mode & 0o111) !== 0,
      sha256: sha256(path),
    }
  })
  .sort((a, b) => a.path.localeCompare(b.path))

const manifest = {
  formatVersion: 1,
  coolieVersion: COOLIE_VERSION,
  gitCommit,
  node: runtimeInfo.version,
  modulesAbi: runtimeInfo.modules,
  targetTriple: target,
  platform: runtimeInfo.platform,
  arch: runtimeInfo.arch,
  generatedAt: new Date().toISOString(),
  totalBytes: fileEntries.reduce((sum, entry) => sum + entry.bytes, 0),
  files: fileEntries,
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

// Final allowlist check including manifest.json
for (const rel of listFiles(out).map((path) => relative(out, path).split("\\").join("/"))) {
  if (!isAllowed(rel)) fail(`unexpected sidecar file after manifest: ${rel}`)
}

// Stage into Tauri resources for bundling.
rmSync(tauriResources, { recursive: true, force: true })
mkdirSync(dirname(tauriResources), { recursive: true })
copyTree(out, tauriResources)

console.log(
  JSON.stringify(
    {
      ok: true,
      out,
      tauriResources,
      totalBytes: manifest.totalBytes,
      files: manifest.files.length,
      targetTriple: target,
      node: runtimeInfo.version,
      gitCommit,
    },
    null,
    2,
  ),
)
