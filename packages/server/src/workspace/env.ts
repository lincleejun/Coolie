import type { Workspace } from "@coolie/protocol"
import { portEnv } from "./ports.js"

export interface WorkspaceEnvContext {
  readonly workspace: Workspace
  readonly repoRoot: string
}

/** Central builder for PRD FR-3.5 COOLIE_* variables injected into engine/setup/shell sessions. */
export const buildWorkspaceEnv = (ctx: WorkspaceEnvContext): Record<string, string> => {
  const ws = ctx.workspace
  const ports = portEnv(ws.portBase)
  return {
    ...ports,
    COOLIE_WORKSPACE: ws.id,
    COOLIE_WORKSPACE_NAME: ws.name,
    COOLIE_WORKSPACE_PATH: ws.path,
    COOLIE_ROOT_PATH: ctx.repoRoot,
    COOLIE_ROOT: ctx.repoRoot,
    COOLIE_DEFAULT_BRANCH: ws.baseBranch,
    COOLIE_PORT: String(ws.portBase),
    COOLIE_WORKSPACE_KIND: ws.kind ?? "task",
    COOLIE_WORKSPACE_OWNERSHIP: ws.ownership ?? "managed",
    COOLIE_IS_LOCAL: "1",
  }
}
