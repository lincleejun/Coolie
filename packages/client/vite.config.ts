import { defineConfig, type Plugin } from "vite"
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

/**
 * Tauri's custom protocol does not emit CORS headers. Vite's default `crossorigin`
 * on <script>/<link> can make WKWebView treat those as CORS fetches; strip it for
 * packaged loads. (Blank window root cause was Inbox zustand selector churn — this
 * is defense-in-depth for asset loading.)
 */
function stripCrossoriginForTauri(): Plugin {
  return {
    name: "coolie-strip-crossorigin",
    transformIndexHtml(html) {
      return html
        .replace(/<script([^>]*?)\s+crossorigin(?:="[^"]*")?([^>]*)>/gi, "<script$1$2>")
        .replace(/<link([^>]*?)\s+crossorigin(?:="[^"]*")?([^>]*)>/gi, "<link$1$2>")
    },
  }
}

export default defineConfig({
  // Relative asset URLs so packaged custom-protocol loads resolve next to index.html.
  base: "./",
  plugins: [react(), stripCrossoriginForTauri()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    target: "es2022",
    modulePreload: { polyfill: false },
  },
  define: { __COOLIE_SERVER_CMD__: JSON.stringify(serverCmd) },
})
