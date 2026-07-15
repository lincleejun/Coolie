#!/usr/bin/env node
/**
 * Task 0.6 experiment only. This produces two inspectable macOS artifacts:
 * A) a copied Node runtime plus bundled CommonJS, and
 * B) a Node Single Executable Application (SEA).
 *
 * Native addons stay as adjacent resources in both variants. This is evidence
 * for the ADR, not the production Wave 4 build implementation.
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  cpSync,
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
const EXPECTED_POSTJECT_VERSION = "1.0.0-alpha.6"
const args = process.argv.slice(2)
const selfCheck = args.includes("--self-check")
const outArg = args.find((arg) => !arg.startsWith("--"))
const out = resolve(outArg ?? join(root, "packages/server/dist/sidecar-spike"))
const shared = join(out, "_shared")
const bundle = join(shared, "server.cjs")
const runtimePath = resolve(process.env.COOLIE_SIDECAR_NODE ?? process.execPath)
const nativeModules = process.env.COOLIE_SIDECAR_NATIVE_MODULES
  ? resolve(process.env.COOLIE_SIDECAR_NATIVE_MODULES)
  : join(root, "packages/server")

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options })

const fail = (message, cause) => {
  const detail = cause instanceof Error ? `\nCause: ${cause.message}` : ""
  console.error(`sidecar spike preflight failed: ${message}${detail}`)
  process.exit(1)
}

const inspectRuntime = () => {
  try {
    return JSON.parse(execFileSync(runtimePath, [
      "-p",
      "JSON.stringify({version:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch})",
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
  } catch (error) {
    fail(
      `cannot execute candidate runtime ${runtimePath}. Set COOLIE_SIDECAR_NODE to an absolute Node ${EXPECTED_NODE_VERSION} executable.`,
      error,
    )
  }
}

const runtimeInfo = inspectRuntime()
if (runtimeInfo.version !== EXPECTED_NODE_VERSION || runtimeInfo.modules !== EXPECTED_NODE_MODULES_ABI)
  fail(
    `expected Node ${EXPECTED_NODE_VERSION} with modules ABI ${EXPECTED_NODE_MODULES_ABI}, ` +
    `got ${runtimeInfo.version ?? "unknown"} / ABI ${runtimeInfo.modules ?? "unknown"} from ${runtimePath}. ` +
    `Activate the pinned runtime or set COOLIE_SIDECAR_NODE=/absolute/path/to/node.`,
  )
if (runtimeInfo.platform !== process.platform || runtimeInfo.arch !== process.arch)
  fail(
    `candidate runtime target ${runtimeInfo.platform}-${runtimeInfo.arch} does not match build host ` +
    `${process.platform}-${process.arch}; use a matching host/runtime.`,
  )
const target = `${runtimeInfo.platform}-${runtimeInfo.arch}`

const workspacePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (workspacePackage.devDependencies?.postject !== EXPECTED_POSTJECT_VERSION)
  fail(
    `package.json must declare exact devDependency postject@${EXPECTED_POSTJECT_VERSION}; ` +
    `found ${workspacePackage.devDependencies?.postject ?? "missing"}.`,
  )
const lockfile = readFileSync(join(root, "bun.lock"), "utf8")
if (!lockfile.includes(`"postject": "${EXPECTED_POSTJECT_VERSION}"`) ||
    !lockfile.includes(`"postject": ["postject@${EXPECTED_POSTJECT_VERSION}"`))
  fail(`bun.lock does not pin the workspace and resolved postject@${EXPECTED_POSTJECT_VERSION} entries`)

let postjectPackage
try {
  postjectPackage = require(require.resolve("postject/package.json", { paths: [root] }))
} catch (error) {
  fail(
    `missing pinned postject@${EXPECTED_POSTJECT_VERSION}. Run bun install --frozen-lockfile at ${root} before building.`,
    error,
  )
}
if (postjectPackage.version !== EXPECTED_POSTJECT_VERSION)
  fail(`expected postject@${EXPECTED_POSTJECT_VERSION}, got ${postjectPackage.version ?? "unknown"}`)

const copy = (source, destination) => {
  mkdirSync(dirname(destination), { recursive: true })
  const stat = statSync(source)
  if (stat.isDirectory()) cpSync(source, destination, { recursive: true, dereference: true })
  else copyFileSync(source, destination)
}

const packageRoot = (name) =>
  dirname(require.resolve(`${name}/package.json`, { paths: [nativeModules] }))

let sqlitePackage
let ptyPackage
try {
  sqlitePackage = packageRoot("better-sqlite3")
  ptyPackage = packageRoot("node-pty")
  execFileSync(runtimePath, ["-e", [
    `const Database = require(${JSON.stringify(sqlitePackage)})`,
    "const db = new Database(':memory:')",
    "db.prepare('select 1').get()",
    "db.close()",
    `require(${JSON.stringify(ptyPackage)})`,
  ].join(";")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
} catch (error) {
  fail(
    `native addons are missing or do not match Node ${EXPECTED_NODE_VERSION} / ABI ${EXPECTED_NODE_MODULES_ABI}. ` +
    `Install with the candidate first on PATH, for example: ` +
    `PATH="$(dirname "$COOLIE_SIDECAR_NODE"):$PATH" bun install --frozen-lockfile --force`,
    error,
  )
}

if (selfCheck) {
  console.log(JSON.stringify({
    ok: true,
    runtimePath,
    runtime: runtimeInfo,
    postject: postjectPackage.version,
    nativeModules,
  }, null, 2))
  process.exit(0)
}

const copyNativeClosure = (destination) => {
  const modules = join(destination, "node_modules")
  const sqlite = sqlitePackage
  const pty = ptyPackage
  const sqliteRequire = createRequire(join(sqlite, "package.json"))
  const bindings = dirname(sqliteRequire.resolve("bindings/package.json"))
  const bindingsRequire = createRequire(join(bindings, "package.json"))
  const fileUri = dirname(bindingsRequire.resolve("file-uri-to-path/package.json"))

  for (const item of ["package.json", "lib"])
    copy(join(sqlite, item), join(modules, "better-sqlite3", item))
  copy(
    join(sqlite, "build/Release/better_sqlite3.node"),
    join(modules, "better-sqlite3/build/Release/better_sqlite3.node"),
  )

  for (const item of ["package.json", "lib"])
    copy(join(pty, item), join(modules, "node-pty", item))
  copy(join(pty, `prebuilds/${target}`), join(modules, "node-pty", `prebuilds/${target}`))
  chmodSync(join(modules, "node-pty", `prebuilds/${target}/spawn-helper`), 0o755)

  copy(bindings, join(modules, "bindings"))
  copy(fileUri, join(modules, "file-uri-to-path"))
}

const files = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? files(path) : [path]
})

const manifest = (directory) => {
  const entries = files(directory).map((path) => {
    const bytes = statSync(path).size
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex")
    return { path: relative(directory, path), bytes, sha256 }
  }).sort((a, b) => a.path.localeCompare(b.path))
  return {
    generatedAt: new Date().toISOString(),
    platform: runtimeInfo.platform,
    arch: runtimeInfo.arch,
    node: runtimeInfo.version,
    modulesAbi: runtimeInfo.modules,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(shared, { recursive: true })
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

const bundled = readFileSync(bundle, "utf8")
const seaRequireBridge = [
  "const { createRequire: __coolieCreateRequire } = require(\"node:module\");",
  "require = __coolieCreateRequire(process.execPath);",
].join("\n")
writeFileSync(bundle, bundled.replace(/^#![^\n]*\n/, (line) => `${line}${seaRequireBridge}\n`))

const runtime = join(out, "runtime")
mkdirSync(runtime, { recursive: true })
copy(runtimePath, join(runtime, "node"))
copy(bundle, join(runtime, "server.cjs"))
copyNativeClosure(runtime)
writeFileSync(join(runtime, "manifest.json"), JSON.stringify(manifest(runtime), null, 2))

const standalone = join(out, "standalone")
mkdirSync(standalone, { recursive: true })
const executable = join(standalone, "coolie-server")
const seaConfig = join(shared, "sea-config.json")
const blob = join(shared, "sea-prep.blob")
copy(runtimePath, executable)
copyNativeClosure(standalone)
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}, null, 2))
run(runtimePath, ["--experimental-sea-config", seaConfig])
if (process.platform === "darwin")
  run("codesign", ["--remove-signature", executable])
const { inject } = require("postject")
await inject(executable, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: "NODE_SEA",
})
chmodSync(executable, 0o755)
if (process.platform === "darwin")
  run("codesign", ["--sign", "-", executable])
writeFileSync(join(standalone, "manifest.json"), JSON.stringify(manifest(standalone), null, 2))

for (const variant of ["runtime", "standalone"]) {
  const data = JSON.parse(readFileSync(join(out, variant, "manifest.json"), "utf8"))
  console.log(`${variant}: ${data.totalBytes} bytes (${data.files.length} files)`)
}
