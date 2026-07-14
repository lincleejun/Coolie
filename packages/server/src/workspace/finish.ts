import { Context, Data, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { ProjectsRepo } from "../repo/projects.js"
import { WorkspacesRepo } from "../repo/workspaces.js"
import { EventsRepo } from "../repo/events.js"
import { ConflictError, ValidationError } from "../repo/errors.js"

export class FinishOpsError extends Data.TaggedError("FinishOpsError")<{
  readonly tool: "git" | "gh"
  readonly args: readonly string[]
  readonly message: string
  readonly exitCode: number | null
  readonly stderr: string
}> {}

export class MergeConflictError extends Data.TaggedError("MergeConflictError")<{
  readonly message: string
  readonly stderr: string
}> {}

export interface FinishOpsShape {
  readonly git: (cwd: string, args: readonly string[]) => Effect.Effect<string, FinishOpsError>
  readonly gh: (cwd: string, args: readonly string[]) => Effect.Effect<string, FinishOpsError>
}
export class FinishOps extends Context.Tag("FinishOps")<FinishOps, FinishOpsShape>() {}

const run = (tool: "git" | "gh", cwd: string, args: readonly string[]): Effect.Effect<string, FinishOpsError> =>
  Effect.async((resume) => {
    execFile(tool, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      if (!error) return resume(Effect.succeed(String(stdout)))
      resume(Effect.fail(new FinishOpsError({
        tool, args, message: `${tool} ${args[0] ?? ""} 失败：${String(stderr || error.message).trim()}`,
        exitCode: typeof error.code === "number" ? error.code : null,
        stderr: String(stderr ?? ""),
      })))
    })
  })

export const FinishOpsLive = Layer.succeed(FinishOps, {
  git: (cwd, args) => run("git", cwd, args),
  gh: (cwd, args) => run("gh", cwd, args),
})

export interface FinishRequest {
  readonly createPr?: boolean
  readonly mergeBack?: boolean
  readonly title?: string
  readonly body?: string
}
export interface FinishOutcome {
  readonly prUrl?: string
  readonly mergedBack: boolean
  readonly warnings: readonly string[]
}
export interface WorkspaceFinisherShape {
  readonly finish: (workspaceId: string, request: FinishRequest) => Effect.Effect<FinishOutcome, unknown>
}
export class WorkspaceFinisher extends Context.Tag("WorkspaceFinisher")<WorkspaceFinisher, WorkspaceFinisherShape>() {}

export const WorkspaceFinisherLive = Layer.effect(
  WorkspaceFinisher,
  Effect.gen(function* () {
    const ops = yield* FinishOps
    const projects = yield* ProjectsRepo
    const workspaces = yield* WorkspacesRepo
    const events = yield* EventsRepo

    const clean = (cwd: string) => ops.git(cwd, ["status", "--porcelain"]).pipe(Effect.map((out) => out.trim() === ""))

    const finish: WorkspaceFinisherShape["finish"] = (workspaceId, request) => Effect.gen(function* () {
      if (request.createPr !== true && request.mergeBack !== true)
        return yield* new ValidationError({ message: "createPr 与 mergeBack 至少选择一个动作" })
      const ws = yield* workspaces.get(workspaceId)
      if (ws.status !== "active")
        return yield* new ConflictError({ message: `只能 finish active workspace（当前 ${ws.status}）` })
      const project = yield* projects.get(ws.projectId)
      const warnings: string[] = []
      const wsClean = yield* clean(ws.path)
      if (!wsClean && request.createPr === true)
        warnings.push("workspace 有未提交改动；PR 只包含已提交内容")

      // mergeBack 的所有守卫必须早于 push/PR 等外部副作用；两动作同时请求时也不能先创建 PR 再报 merge 不可行。
      if (request.mergeBack === true) {
        if (!wsClean)
          return yield* new ConflictError({ message: "mergeBack 前 workspace 必须 clean" })
        if (!(yield* clean(project.repoRoot)))
          return yield* new ConflictError({ message: "mergeBack 前主 checkout 必须 clean" })
        const current = (yield* ops.git(project.repoRoot, ["branch", "--show-current"])).trim()
        if (current !== ws.baseBranch)
          return yield* new ConflictError({ message: `主 checkout 当前 branch 必须是 ${ws.baseBranch}（实际 ${current || "detached"}）` })
      }

      let prUrl: string | undefined
      if (request.createPr === true) {
        const remotes = (yield* ops.git(ws.path, ["remote"])).split("\n").map((v) => v.trim())
        if (!remotes.includes("origin"))
          return yield* new ConflictError({ message: "无法创建 PR：仓库没有 origin remote" })
        yield* ops.git(ws.path, ["push", "-u", "origin", ws.branch])
        let body = request.body
        if (body === undefined) {
          const template = path.join(project.repoRoot, ".coolie", "pr-template.md")
          body = yield* Effect.sync(() => { try { return fs.readFileSync(template, "utf8") } catch { return "" } })
        }
        prUrl = (yield* ops.gh(ws.path, [
          "pr", "create", "--base", ws.baseBranch, "--head", ws.branch,
          "--title", request.title?.trim() || ws.branch, "--body", body,
        ])).trim()
      }

      if (request.mergeBack === true) {
        yield* ops.git(project.repoRoot, ["merge", "--no-ff", ws.branch]).pipe(
          Effect.mapError((error) => error.exitCode === 1
            ? new MergeConflictError({
              message: `merge ${ws.branch} 失败；冲突状态已保留，请手动处理（未自动 reset）`,
              stderr: error.stderr,
            })
            : error),
        )
      }

      const outcome: FinishOutcome = {
        ...(prUrl !== undefined ? { prUrl } : {}),
        mergedBack: request.mergeBack === true,
        warnings,
      }
      yield* events.append({
        workspaceId: ws.id, type: "workspace.finished",
        payload: { createPr: request.createPr === true, mergeBack: request.mergeBack === true, ...outcome },
      })
      return outcome
    })
    return { finish }
  }),
)
