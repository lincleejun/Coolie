import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { Project, Workspace } from "@coolie/protocol"
import { ProjectsRepo } from "../src/repo/projects.js"
import { WorkspacesRepo } from "../src/repo/workspaces.js"
import { EventsRepo } from "../src/repo/events.js"
import { FinishOps, type FinishRequest, WorkspaceFinisher, WorkspaceFinisherLive } from "../src/workspace/finish.js"

const workspace = new Workspace({
  id: "ws1", projectId: "p1", name: "feature", path: "/repo-wt", branch: "feature/x",
  baseBranch: "main", baseRef: "abc", status: "active", pinned: false,
  createdAt: 1, archivedAt: null, portBase: 40000,
})
const project = new Project({ id: "p1", name: "repo", repoRoot: "/repo", defaultBaseBranch: "main", createdAt: 1 })

const run = async (
  outputs: Record<string, string>,
  request: FinishRequest = { createPr: true },
  selectedWorkspace: Workspace = workspace,
) => {
  const calls: Array<{ tool: string; cwd: string; args: readonly string[] }> = []
  const ops = {
    git: (cwd: string, args: readonly string[]) => Effect.sync(() => {
      calls.push({ tool: "git", cwd, args })
      return outputs[`git:${cwd}:${args.join(" ")}`] ?? ""
    }),
    gh: (cwd: string, args: readonly string[]) => Effect.sync(() => {
      calls.push({ tool: "gh", cwd, args })
      return outputs[`gh:${cwd}:${args.join(" ")}`] ?? "https://example.test/pr/1\n"
    }),
  }
  const events: any[] = []
  const layer = WorkspaceFinisherLive.pipe(Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(FinishOps, ops),
    Layer.succeed(ProjectsRepo, { add: null as any, get: () => Effect.succeed(project), list: null as any, remove: null as any }),
    Layer.succeed(WorkspacesRepo, { get: () => Effect.succeed(selectedWorkspace) } as any),
    Layer.succeed(EventsRepo, {
      append: (event: any) => Effect.sync(() => { events.push(event); return events.length }),
      listAfter: null as any,
    }),
  )))
  const finish = Effect.gen(function* () { return yield* (yield* WorkspaceFinisher).finish("ws1", request) })
  return { exit: await Effect.runPromiseExit(Effect.provide(finish, layer)), calls, events }
}

describe("WorkspaceFinisher", () => {
  it("creates PR with argv-only push/gh calls and warns for dirty files", async () => {
    const { exit, calls, events } = await run({
      "git:/repo-wt:status --porcelain": " M local.txt\n",
      "git:/repo-wt:remote": "origin\n",
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.prUrl).toBe("https://example.test/pr/1")
      expect(exit.value.warnings).toEqual(["workspace 有未提交改动；PR 只包含已提交内容"])
    }
    expect(calls.some((call) => call.tool === "git" && call.args.join(" ") === "push -u origin feature/x")).toBe(true)
    expect(calls.some((call) => call.tool === "gh" && call.args.slice(0, 2).join(" ") === "pr create")).toBe(true)
    expect(events[0].type).toBe("workspace.finished")
  })

  it("rejects an empty action set before invoking tools", async () => {
    const layer = WorkspaceFinisherLive.pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(FinishOps, { git: () => Effect.die("unexpected"), gh: () => Effect.die("unexpected") }),
      Layer.succeed(ProjectsRepo, {} as any), Layer.succeed(WorkspacesRepo, {} as any), Layer.succeed(EventsRepo, {} as any),
    )))
    const effect = Effect.gen(function* () { return yield* (yield* WorkspaceFinisher).finish("ws1", {}) })
    expect(Exit.isFailure(await Effect.runPromiseExit(Effect.provide(effect, layer)))).toBe(true)
  })

  it("checks merge cleanliness before any push or PR side effect", async () => {
    const { exit, calls } = await run({
      "git:/repo-wt:status --porcelain": " M local.txt\n",
      "git:/repo-wt:remote": "origin\n",
    }, { createPr: true, mergeBack: true })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.some((call) => call.args[0] === "push" || call.tool === "gh")).toBe(false)
  })

  it("rejects the main task before invoking git or gh", async () => {
    const main = new Workspace({
      ...workspace,
      id: "main-1",
      name: "repo",
      path: "/repo",
      branch: "main",
      kind: "main",
      portBase: 0,
    })
    const { exit, calls, events } = await run({}, { createPr: true, mergeBack: true }, main)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
    expect(events).toEqual([])
  })
})
