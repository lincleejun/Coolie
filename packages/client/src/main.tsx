import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles.css"

if (import.meta.env.VITE_COOLIE_WDIO === "1") {
  void import("@wdio/tauri-plugin")
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
