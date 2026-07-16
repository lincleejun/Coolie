/** server 只读端点的响应形状（与 packages/server/src/git/inspect.ts 同形；client 不 import server 包） */
export interface DiffStat { filesChanged: number; insertions: number; deletions: number }
export interface FileChange { path: string; insertions: number; deletions: number }
export interface ChangesReport {
  againstBase: FileChange[]; committed: FileChange[]
  staged: FileChange[]; unstaged: FileChange[]; untracked: string[]
}
export type DiffSection = "againstBase" | "committed" | "staged" | "unstaged" | "untracked"
export interface FileDiff { path: string; section: DiffSection; unified: string; binary: boolean }
export interface SlashCommand { name: string; source: "repo" | "user" }
export interface EngineInfo {
  id: string; displayName: string
  capabilities: { nativeQueue: boolean; midSessionModelSwitch: boolean; resume: boolean; hooks: boolean; effort: boolean }
  models: string[]
  modelEfforts?: Readonly<Record<string, readonly string[]>>
  efforts?: readonly string[]
  custom?: boolean
  enabled?: boolean
  presetId?: string | null
  availability?: { available: boolean; accountHint: string | null; error: string | null }
  definition?: import("@coolie/protocol").CustomEngineDefinition
}
export interface NamePoolInfo { id: string; displayName: string }
