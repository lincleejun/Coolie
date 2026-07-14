import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Reuses index.html -> src/main.tsx -> App. An empty command is a second,
// build-time barrier against daemon spawning in addition to runtime capabilities.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist-web", target: "es2022" },
  define: { __COOLIE_SERVER_CMD__: JSON.stringify("") },
})
