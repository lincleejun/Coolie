import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Exit } from "effect"
import { Workspace } from "@coolie/protocol"
import { buildWorkspaceEnv } from "../src/workspace/env.js"
import { SetupRunner, SetupRunnerLive } from "../src/workspace/setup.js"

const baseWorkspace = (overrides: Partial<Workspace> = {}): Workspace =>
  new Workspace({
    id: "ws-task",
    projectId: "p1",
    name: "yosemite",
    path: "/tmp/coolie/workspaces/demo/yosemite",
    branch: "coolie/demo",
    baseBranch: "main",
    baseRef: "abc123",
    status: "active",
    pinned: false,
    createdAt: 1,
    archivedAt: null,
    portBase: 40_020,
    kind: "task",
    ownership: "managed",
    ...overrides,
  })

describe("buildWorkspaceEnv", () => {
  it("exposes the PRD contract with COOLIE_PORT aligned to COOLIE_PORT_0", () => {
    const env = buildWorkspaceEnv({ workspace: baseWorkspace(), repoRoot: "/repo/main" })
    expect(env.COOLIE_PORT).toBe("40020")
    expect(env.COOLIE_PORT_0).toBe("40020")
    expect(env.COOLIE_PORT_9).toBe("40029")
    expect(env.COOLIE_WORKSPACE).toBe("ws-task")
    expect(env.COOLIE_WORKSPACE_NAME).toBe("yosemite")
    expect(env.COOLIE_WORKSPACE_PATH).toBe("/tmp/coolie/workspaces/demo/yosemite")
    expect(env.COOLIE_ROOT_PATH).toBe("/repo/main")
    expect(env.COOLIE_ROOT).toBe("/repo/main")
    expect(env.COOLIE_DEFAULT_BRANCH).toBe("main")
    expect(env.COOLIE_IS_LOCAL).toBe("1")
    expect(env.COOLIE_WORKSPACE_KIND).toBe("task")
    expect(env.COOLIE_WORKSPACE_OWNERSHIP).toBe("managed")
    expect(env).not.toHaveProperty("Authorization")
    expect(JSON.stringify(env)).not.toMatch(/bearer|token/i)
  })

  it("reflects main and adopted workspace kinds", () => {
    const main = buildWorkspaceEnv({
      workspace: baseWorkspace({
        id: "ws-main",
        kind: "main",
        path: "/repo/main",
        branch: "main",
        baseRef: "HEAD",
      }),
      repoRoot: "/repo/main",
    })
    expect(main.COOLIE_WORKSPACE_KIND).toBe("main")
    expect(main.COOLIE_WORKSPACE_PATH).toBe("/repo/main")

    const adopted = buildWorkspaceEnv({
      workspace: baseWorkspace({ ownership: "adopted", name: "adopted-tree" }),
      repoRoot: "/repo/main",
    })
    expect(adopted.COOLIE_WORKSPACE_OWNERSHIP).toBe("adopted")
    expect(adopted.COOLIE_WORKSPACE_NAME).toBe("adopted-tree")
  })
})

describe("setup runner env contract", () => {
  it("dumps the unified workspace env without leaking bearer tokens", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "coolie-env-wt-"))
    const script = path.join(wt, "dump-env.sh")
    fs.writeFileSync(script, `#!/bin/bash
printf 'workspace=%s\\n' "$COOLIE_WORKSPACE"
printf 'name=%s\\n' "$COOLIE_WORKSPACE_NAME"
printf 'path=%s\\n' "$COOLIE_WORKSPACE_PATH"
printf 'root=%s\\n' "$COOLIE_ROOT_PATH"
printf 'branch=%s\\n' "$COOLIE_DEFAULT_BRANCH"
printf 'port=%s\\n' "$COOLIE_PORT"
printf 'port0=%s\\n' "$COOLIE_PORT_0"
printf 'kind=%s\\n' "$COOLIE_WORKSPACE_KIND"
printf 'ownership=%s\\n' "$COOLIE_WORKSPACE_OWNERSHIP"
printf 'local=%s\\n' "$COOLIE_IS_LOCAL"
`)
    const env = buildWorkspaceEnv({ workspace: baseWorkspace(), repoRoot: "/repo/main" })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* SetupRunner
        return yield* runner.run({ worktreePath: wt, scripts: [script], env })
      }).pipe(Effect.provide(SetupRunnerLive)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    const tail = exit.value[0]!.outputTail
    expect(tail).toContain("workspace=ws-task")
    expect(tail).toContain("name=yosemite")
    expect(tail).toContain("port=40020")
    expect(tail).toContain("port0=40020")
    expect(tail).toContain("kind=task")
    expect(tail).toContain("ownership=managed")
    expect(tail).toContain("local=1")
    expect(tail).not.toMatch(/bearer|token/i)
  })
})
