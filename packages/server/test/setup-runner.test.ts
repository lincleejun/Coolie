import { describe, it, expect } from "vitest"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import {
  SetupRunner, SetupRunnerLive, resolveSetupScripts, SetupScriptError,
} from "../src/workspace/setup.js"

const mkdir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const writeScript = (file: string, body: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`)
  return file
}
const run = <A, E>(eff: Effect.Effect<A, E, SetupRunner>) =>
  Effect.runPromiseExit(Effect.provide(eff, SetupRunnerLive))

describe("resolveSetupScripts", () => {
  it("returns the three layers in order, skipping missing", () => {
    const worktreePath = mkdir("coolie-setup-wt-")
    const repoRoot = mkdir("coolie-setup-repo-")
    const home = mkdir("coolie-setup-home-")
    const l1 = writeScript(path.join(worktreePath, ".coolie", "setup.sh"), "echo repo")
    const l3 = writeScript(path.join(repoRoot, ".coolie", "setup.local.sh"), "echo local")
    expect(resolveSetupScripts({ worktreePath, repoRoot, projectId: "p1", home })).toEqual([l1, l3])
    const l2 = writeScript(path.join(home, "projects", "p1", "setup.sh"), "echo machine")
    expect(resolveSetupScripts({ worktreePath, repoRoot, projectId: "p1", home })).toEqual([l1, l2, l3])
  })
})

describe("SetupRunner", () => {
  it("runs scripts with injected env, captures outputTail", async () => {
    const wt = mkdir("coolie-run-wt-")
    const script = writeScript(path.join(wt, ".coolie", "setup.sh"),
      'echo "port=$COOLIE_PORT_0 root=$COOLIE_ROOT"\necho "$COOLIE_PORT_0" > port.txt')
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({
        worktreePath: wt, scripts: [script],
        env: { COOLIE_ROOT: "/main/checkout", COOLIE_PORT_0: "40000" },
      })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toHaveLength(1)
      expect(exit.value[0]!.exitCode).toBe(0)
      expect(exit.value[0]!.outputTail).toContain("port=40000 root=/main/checkout")
    }
    expect(fs.readFileSync(path.join(wt, "port.txt"), "utf8").trim()).toBe("40000")
  })
  it("non-zero exit -> SetupScriptError with exitCode and outputTail; later scripts not run", async () => {
    const wt = mkdir("coolie-fail-wt-")
    const bad = writeScript(path.join(wt, "bad.sh"), 'echo "boom happened" >&2\nexit 3')
    const never = writeScript(path.join(wt, "never.sh"), "touch never-ran.txt")
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({ worktreePath: wt, scripts: [bad, never], env: {} })
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause)
      const e = Option.isSome(f) ? (f.value as SetupScriptError) : undefined
      expect(e?._tag).toBe("SetupScriptError")
      expect(e?.exitCode).toBe(3)
      expect(e?.outputTail).toContain("boom happened")
    }
    expect(fs.existsSync(path.join(wt, "never-ran.txt"))).toBe(false)
  })
  it("empty script list resolves to []", async () => {
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({ worktreePath: mkdir("coolie-empty-wt-"), scripts: [], env: {} })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([])
  })
  it("timeout kills the script and fails typed", async () => {
    const wt = mkdir("coolie-to-wt-")
    // 两行脚本：防 bash 对单命令做 exec 优化（那样 bash 自己就变成 sleep，进程组击杀就测不到了）
    const slow = writeScript(path.join(wt, "slow.sh"), "sleep 30\necho never-reached")
    const exit = await run(Effect.gen(function* () {
      const runner = yield* SetupRunner
      return yield* runner.run({ worktreePath: wt, scripts: [slow], env: {}, timeoutMs: 300 })
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause)
      expect(Option.isSome(f) && (f.value as any)._tag).toBe("SetupScriptError")
      expect(Option.isSome(f) && (f.value as any).message).toContain("超时")
    }
  })
})
