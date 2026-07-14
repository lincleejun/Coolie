import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { capabilities, pickDirectory } from "../platform"

/**
 * 中央空态引导（conductor 风格 onboarding）：
 *  - desktop 无 project：原生目录对话框注册本地仓库；所有平台都可从 URL clone。
 *    web 不暴露本地目录按钮，也不请求任意文件系统权限。
 *  - 有 project 但无选中 workspace：提示按 ⌘N 新建 workspace。
 */
export const EmptyState = () => {
  const projects = useData((s) => s.projects)
  return projects.length === 0 ? <ProjectOnboarding /> : <NoWorkspaceHint />
}

type Mode = "none" | "open" | "clone"

/** 纯函数（可测）：onboarding 提交 → API 请求计划。空输入/未选模式 → null（不发请求）。 */
export const onboardingPlan = (mode: Mode, raw: string): { path: string; body: Record<string, string> } | null => {
  const v = raw.trim()
  if (v === "" || mode === "none") return null
  return mode === "clone"
    ? { path: "/projects/clone", body: { url: v } }
    : { path: "/projects", body: { repoRoot: v } }
}

export const registerPickedDirectory = async (
  pick: () => Promise<string | null>,
  register: (path: string) => Promise<unknown>,
): Promise<boolean> => {
  const selected = await pick()
  if (selected === null) return false
  await register(selected)
  return true
}

const ProjectOnboarding = () => {
  const [mode, setMode] = useState<Mode>("none")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const openDirectory = (): void => {
    if (busy) return
    const api = useData.getState().getApi()
    if (!api) return
    setBusy(true); setErr(null)
    void registerPickedDirectory(
      () => pickDirectory(),
      (repoRoot) => api.req("POST", "/projects", { repoRoot }),
    )
      .then((registered) => registered ? useData.getState().refreshProjects() : undefined)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const submit = (): void => {
    const plan = onboardingPlan(mode, value)
    if (plan === null || busy) return
    const api = useData.getState().getApi()
    if (!api) return
    setBusy(true); setErr(null)
    void api.req("POST", plan.path, plan.body)
      .then(() => useData.getState().refreshProjects())
      .then(() => { setValue(""); setMode("none") })
      .catch((e: any) => setErr(e?.message ?? String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1 className="onboarding-title">欢迎使用 Coolie</h1>
        <p className="onboarding-sub">添加一个项目开始：打开本地仓库，或从远端 clone。</p>
        <div className="onboarding-actions">
          {capabilities.directoryPicker && (
            <button className="ob-action" disabled={busy} onClick={openDirectory}>
              <span className="ob-icon">📁</span>
              <span className="ob-label">打开本地目录</span>
              <span className="ob-hint">已有 git 仓库</span>
            </button>
          )}
          <button className={`ob-action ${mode === "clone" ? "active" : ""}`} onClick={() => { setMode("clone"); setErr(null) }}>
            <span className="ob-icon">⬇</span>
            <span className="ob-label">Clone repository</span>
            <span className="ob-hint">从 URL 克隆</span>
          </button>
        </div>
        {mode !== "none" && (
          <div className="ob-input-row">
            <input
              className="ob-input" autoFocus disabled={busy}
              placeholder={mode === "clone" ? "https://github.com/owner/repo.git" : "/绝对路径/to/repo"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setMode("none") }}
            />
            <button className="btn" disabled={busy || value.trim() === ""} onClick={submit}>
              {busy ? (mode === "clone" ? "克隆中…" : "添加中…") : mode === "clone" ? "Clone" : "添加"}
            </button>
          </div>
        )}
        {err && <div className="ob-err">{err}</div>}
        <p className="onboarding-foot dim">Coolie 用 git worktree 为每个任务隔离一个 workspace。</p>
      </div>
    </div>
  )
}

const NoWorkspaceHint = () => {
  const projects = useData((s) => s.projects)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1 className="onboarding-title">新建一个 workspace</h1>
        <p className="onboarding-sub">每个 workspace 是一个隔离的 git worktree + 分支，跑一个 agent 会话。</p>
        <div className="onboarding-actions">
          <button className="ob-action wide" onClick={() => useUi.getState().setDispatchMode(true, projects[0]?.id ?? null)}>
            <span className="ob-icon">＋</span>
            <span className="ob-label">新建 workspace</span>
            <span className="ob-hint">⌘N · 描述任务并派发首条 prompt</span>
          </button>
        </div>
        <p className="onboarding-foot dim">或从左侧列表选择一个已有 workspace。</p>
      </div>
    </div>
  )
}
