import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../..")
// GUI 拉起 daemon 的默认命令（开发形态）：与 CLI ensureServer 同一目标（tsx + server main.ts start）。
// 空格分隔（discovery.ts split(" ") 对应）；依赖 checkout 路径无空格——有空格时两侧同步换分隔符。
// 打包形态（M2）改为随 app 分发的 coolie-server 入口。
const serverCmd = [
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
