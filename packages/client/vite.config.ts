import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../..")
// Dev: non-empty sentinel so discovery.ts enables daemon spawn via Tauri invoke.
// Actual argv is owned by Rust (dev: tsx+main.ts; release: bundled sidecar/node+server.cjs).
// Never embed checkout absolute paths into the release frontend bundle.
const serverCmd = process.env.COOLIE_VITE_PACKAGED === "1"
  ? "sidecar:packaged"
  : [
      path.join(repoRoot, "node_modules/.bin/tsx"),
      path.join(repoRoot, "packages/server/src/main.ts"),
      "start",
    ].join(" ")

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
  define: { __COOLIE_SERVER_CMD__: JSON.stringify(serverCmd) },
})
