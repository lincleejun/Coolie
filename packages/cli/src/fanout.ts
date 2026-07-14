export { MAX_FANOUT } from "@coolie/protocol"
import { MAX_FANOUT } from "@coolie/protocol"

export interface AgentSpec {
  readonly engineId: string
  readonly count: number
}

export const parseAgentsSpec = (raw: string): AgentSpec[] => {
  if (raw.trim() === "") throw new Error("--agents 不能为空（示例：claude:2,codex:1）")
  const segments = raw.split(",")
  if (segments.some((segment) => segment.trim() === ""))
    throw new Error("--agents 段格式错误（应为 engine:count，如 claude:2）")

  const specs = segments.map((segment): AgentSpec => {
    const value = segment.trim()
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):([0-9]+)$/.exec(value)
    if (!match) throw new Error(`--agents 段格式错误：'${value}'（应为 engine:count）`)
    const count = Number.parseInt(match[2]!, 10)
    if (count < 1) throw new Error(`--agents 段 '${value}' 的 count 必须 ≥ 1`)
    return { engineId: match[1]!.toLowerCase(), count }
  })

  const total = specs.reduce((sum, spec) => sum + spec.count, 0)
  if (total > MAX_FANOUT) throw new Error(`fan-out 实例数 ${total} 超上限 ${MAX_FANOUT}`)
  return specs
}

export const expandAgents = (specs: readonly AgentSpec[]): string[] =>
  specs.flatMap((spec) => Array.from({ length: spec.count }, () => spec.engineId))
