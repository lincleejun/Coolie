# ADR-005: Bundle a pinned Node runtime for the server sidecar

- Date: 2026-07-15
- Status: Accepted
- Scope: Coolie 0.1.0 Wave 4
- Task: `01KXKRA2X2NS53BWPYGWAKESE9` / roadmap Task 0.6

## Context

Coolie's Tauri artifact must start the existing server without a source checkout,
repository `node_modules`, global Node, or `tsx`. The server must continue to run
under Node because its terminal WebSocket loads `node-pty`; Bun is not an
accepted server runtime.

The spike compared:

1. a pinned Node executable plus bundled CommonJS and adjacent native resources;
2. a Node Single Executable Application (SEA) plus the same adjacent native
   resources.

This ADR chooses a Wave 4 implementation direction. The scripts added by this
task are intentionally marked as spike tooling and are not a production
packager.

## Decision

Wave 4 will use **option A: a pinned Node runtime plus bundled server
CommonJS/resources/native addons**.

- Pin the complete Node patch version per release. The verified release
  candidate in this spike is Node `22.22.3`.
- Build one sidecar resource set per Tauri target (`darwin-arm64` and
  `darwin-x64`). Do not copy native addons between Node ABI versions or
  architectures.
- Bundle server code, `@coolie/protocol`, `effect`, `ulid`, and `ws` into one
  CommonJS entry. Keep `better-sqlite3` and `node-pty` external so their normal
  package-relative native lookup remains intact.
- Tauri launches the bundled Node by absolute resource path with
  `[server.cjs, "start"]`; it must not search the user's `PATH` for Node.
- Verify every file against a generated SHA-256 manifest before launch or as
  part of release verification. Update Node, JavaScript, and native addons as
  one atomic app release.
- Keep source maps as CI/debug artifacts, not required runtime resources.

Node SEA is rejected for 0.1.0. It remains technically viable, but it does not
make this server single-file: both native packages and `node-pty`'s
`spawn-helper` must remain adjacent on disk. Its small size delta does not
justify an experimental Node feature, an alpha injection tool, a custom
`createRequire(process.execPath)` bridge, and an extra post-injection signing
step.

## Exact Wave 4 bundle manifest

Each architecture-specific app bundle must contain exactly this logical sidecar
payload (target-triple naming may be added by Tauri):

```text
sidecar/
  node
  server.cjs
  manifest.json
  node_modules/
    better-sqlite3/
      package.json
      lib/**
      build/Release/better_sqlite3.node
    bindings/
      package.json
      bindings.js
    file-uri-to-path/
      package.json
      index.js
    node-pty/
      package.json
      lib/**                  # runtime JS only; exclude *.test.js
      prebuilds/darwin-<arch>/
        pty.node
        spawn-helper          # mode 0755
  licenses/
    node-LICENSE
    better-sqlite3-LICENSE
    bindings-LICENSE
    file-uri-to-path-LICENSE
    node-pty-LICENSE
    bundled-js-THIRD_PARTY_NOTICES
```

`manifest.json` records format version, Coolie version/commit, Node version,
target triple, native ABI (`process.versions.modules`), relative path, byte
length, executable mode, and SHA-256 for every file except the manifest itself.
The build fails on an unexpected file, symlink, missing license, wrong
architecture, non-executable `spawn-helper`, or native ABI mismatch.

There are no static hook resources in the current server: Claude/Codex hook and
keepalive scripts are generated into isolated `COOLIE_HOME` at startup. If that
changes, the new resource must be explicit in this manifest.

## Spike implementation

`packages/server/scripts/build-sidecar-spike.mjs`:

- bundles the server with Bun's build tool targeting Node/CommonJS;
- builds option A by copying the exact `COOLIE_SIDECAR_NODE` candidate;
- builds option B with Node SEA and pinned `postject@1.0.0-alpha.6`;
- copies a pruned native runtime closure and emits per-file SHA-256 manifests;
- supports `COOLIE_SIDECAR_NATIVE_MODULES` so native packages can be installed
  with the exact target Node ABI;
- fails before writing output unless the candidate is Node 22.22.3 / modules
  ABI 127, the host architecture matches, package.json and `bun.lock` both pin
  the expected postject version, the installed postject version matches, and
  both native addons load under that candidate.

Reproducible setup and the single build + smoke command:

```bash
export COOLIE_SIDECAR_NODE=/absolute/path/to/node-v22.22.3/bin/node
PATH="$(dirname "$COOLIE_SIDECAR_NODE"):$PATH" bun install --frozen-lockfile
COOLIE_SIDECAR_NODE="$COOLIE_SIDECAR_NODE" bun run sidecar:spike
```

`bun run sidecar:spike:self-check` runs only dependency/runtime/ABI preflight.
The build never downloads postject through implicit `npx` or a global install.

`packages/server/scripts/smoke-sidecar-spike.mjs` creates a clean temporary
home/repository, starts each artifact with its working directory outside the
checkout, waits for `server.json`, requests `/health`, writes through the real
SQLite repository, then connects to the real terminal WebSocket. A fake engine
keeps the tmux window alive; the data path under test is the production
WebSocket → `node-pty` → `tmux attach` path. Teardown calls `/shutdown`, kills
only the unique test tmux socket, and removes the temporary tree.

## Evidence

Environment:

- macOS Darwin 24.6.0, Apple arm64
- Node 22.22.3 candidate runtime
- Bun 1.3.14 used only as the build tool
- `better-sqlite3` 12.11.1
- `node-pty` 1.1.0
- tmux 3.6a

Option A, pinned runtime:

- 116,413,197 bytes, 72 files
- gzip tar: 38,278,535 bytes
- Node executable: 112,915,776 bytes
- bundled server entry: 1,221,338 bytes
- clean startup samples to `server.json`: 1,596 ms cold, then 212 ms and
  342 ms; median 342 ms

Option B, SEA:

- 116,178,067 bytes, 71 files
- gzip tar: 38,313,018 bytes
- SEA executable: 113,901,984 bytes
- clean startup samples to `server.json`: 2,241 ms cold, then 576 ms and
  291 ms; median 576 ms
- uncompressed saving versus A: 235,130 bytes (0.20%)
- compressed result versus A: 34,483 bytes larger

For all six clean-room launches:

- `GET /health` returned `{"ok":true}`;
- `better-sqlite3` created and wrote a 90,112-byte migrated database;
- terminal WebSocket attach received the unique marker through real
  `node-pty` and tmux;
- the server process was Node/SEA, never Bun.

The Node executable and both native addons are arm64 Mach-O files. Their load
commands declare macOS minimum 11.0, which is compatible with the product's
macOS 12+ target. Both addons link only system `libc++`/`libSystem` in this
probe.

## Native addon and architecture constraints

Native ABI matching is a release invariant, not an install-time detail. The
worktree's first install was built by Node 24 and loaded successfully there,
but failed under Node 22 with:

```text
NODE_MODULE_VERSION 137 ... requires NODE_MODULE_VERSION 127
```

Reinstalling both native packages with Node 22, then rebuilding both artifacts,
made `/health`, SQLite, and terminal attach pass. Wave 4 therefore must install
or rebuild native dependencies with the exact bundled Node patch and test the
resulting artifact. The release job must not silently reuse a developer's
existing `node_modules`.

The x64 slice was not built in this arm64 timebox. It must be built and smoked
on a matching macOS x64 runner (or a separately justified cross-build process)
before a universal distribution claims x64 support.

## Update, signing, and debugging tradeoffs

Option A:

- Updates replace the whole versioned sidecar directory atomically; rollback
  can retain the previous directory until the new `/health` succeeds.
- Normal Node module resolution and native stack traces remain available.
- A CI-only source map can map the bundled stack to TypeScript.
- The runtime and native packages are visible resources, which makes manifest
  auditing and field diagnosis straightforward.

Option B:

- The SEA injection mutates the Node Mach-O and invalidates its signature.
  This spike removed the original signature, injected the blob, and applied an
  ad-hoc signature. Release signing/notarization would have to happen after
  injection.
- The server needs a custom filesystem `require` bridge for native packages.
- Updating server JavaScript requires rebuilding and re-signing the executable.
- Native resources still need the same versioned directory and manifest, so
  rollback and update complexity are not reduced.
- SEA and the pinned postject version are additional experimental failure
  surfaces during crash/debug triage.

## Risks and required Wave 4 follow-up

- This spike did not integrate Tauri process ownership, app shutdown behavior,
  target-triple resource naming, or release code signing.
- It did not run on a physical macOS 12 host or x64 hardware; `minos 11.0` is
  binary evidence, not a substitute for those release smokes.
- The spike copies a conservative runtime closure and still includes some
  package metadata/test files. Wave 4 must enforce the exact allowlist above,
  include licenses, and regenerate the measured size.
- Node distribution provenance/checksum and third-party notices must be pinned
  in the release build.
- `tmux`, Git, and engine CLIs remain discovered system dependencies; this ADR
  bundles only the Coolie server runtime.
- App sandbox, hardened runtime, signing, notarization, and auto-update are
  outside this timebox. Signing/notarization remain excluded from 0.1.0 by the
  PRD, but ad-hoc app assembly still needs a final bundle smoke.

## Consequences

Wave 4 has a conventional, auditable server layout with the least packaging
novelty. The cost is roughly 116 MB uncompressed per architecture before app
bundle compression. That cost is dominated by Node itself and is also paid by
SEA; changing to SEA would not materially reduce the artifact.
