import { useState } from "react"
import { useData } from "../stores/data"
import { useUi } from "../stores/ui"
import { capabilities, pickDirectory } from "../platform"
import type { Project } from "@coolie/protocol"
import { useT } from "../i18n"

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

export const ProjectOnboarding = ({ onProjectReady }: {
  onProjectReady?: (project: Project) => void
}) => {
  const tr = useT()
  const [mode, setMode] = useState<Mode>("none")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const openDirectory = (): void => {
    if (busy) return
    const api = useData.getState().getApi()
    if (!api) return
    setBusy(true); setErr(null)
    let project: Project | null = null
    void registerPickedDirectory(
      () => pickDirectory(),
      async (repoRoot) => {
        project = await api.req("POST", "/projects", { repoRoot })
        return project
      },
    )
      .then(async (registered) => {
        if (!registered) return
        await useData.getState().refreshProjects()
        if (project) onProjectReady?.(project)
      })
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
      .then(async (project: Project) => {
        await useData.getState().refreshProjects()
        setValue(""); setMode("none")
        onProjectReady?.(project)
      })
      .catch((e: any) => setErr(e?.message ?? String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1 className="onboarding-title" role="heading">{tr("onboarding.openProject")}</h1>
        <p className="onboarding-sub">{tr("onboarding.openSubtitle")}</p>
        <div className="onboarding-actions">
          {capabilities.directoryPicker && (
            <button className="ob-action" disabled={busy} onClick={openDirectory}>
              <span className="ob-icon">📁</span>
              <span className="ob-label">{tr("onboarding.openProject")}</span>
              <span className="ob-hint">{tr("onboarding.localHint")}</span>
            </button>
          )}
          <button className={`ob-action ${mode === "clone" ? "active" : ""}`} aria-label={tr("onboarding.openRepository")} onClick={() => { setMode("clone"); setErr(null) }}>
            <span className="ob-icon">⬇</span>
            <span className="ob-label">{tr("onboarding.openRepository")}</span>
            <span className="ob-hint">{tr("onboarding.cloneHint")}</span>
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
              {busy ? (mode === "clone" ? tr("onboarding.cloning") : tr("onboarding.adding"))
                : mode === "clone" ? tr("onboarding.clone") : tr("onboarding.add")}
            </button>
          </div>
        )}
        {err && <div className="ob-err">{err}</div>}
        <p className="onboarding-foot dim">{tr("onboarding.isolation")}</p>
      </div>
    </div>
  )
}

const NoWorkspaceHint = () => {
  const tr = useT()
  const projects = useData((s) => s.projects)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1 className="onboarding-title" role="heading">{tr("onboarding.newTitle")}</h1>
        <p className="onboarding-sub">{tr("onboarding.newSubtitle")}</p>
        <div className="onboarding-actions">
          <button
            className="ob-action wide"
            aria-label={tr("sidebar.new")}
            onClick={() => useUi.getState().setDispatchMode(true, projects[0]?.id ?? null)}
          >
            <span className="ob-icon">＋</span>
            <span className="ob-label">{tr("sidebar.new")}</span>
            <span className="ob-hint">{tr("onboarding.newHint")}</span>
          </button>
        </div>
        <p className="onboarding-foot dim">{tr("onboarding.selectExisting")}</p>
      </div>
    </div>
  )
}
