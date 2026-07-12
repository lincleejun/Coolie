import { describe, it, expect } from "vitest"
import {
  ROUTES, ClientRole, decodeClientsStatus, decodeHealOutcome, decodeCoolieEvent,
} from "../src/index.js"
import { Schema } from "effect"

describe("Plan 4 protocol vocabulary", () => {
  it("ROUTES 含 daemon 完善四路由", () => {
    const heads = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(heads).toContain("GET /clients")
    expect(heads).toContain("POST /hooks/engine-exit")
    expect(heads).toContain("POST /workspaces/:id/ensure")
    expect(heads).toContain("POST /workspaces/:id/tabs/:tabId/resume")
  })

  it("ClientRole 只接受 gui|terminal|cli", () => {
    const decode = Schema.decodeUnknownSync(ClientRole)
    expect(decode("gui")).toBe("gui")
    expect(decode("terminal")).toBe("terminal")
    expect(decode("cli")).toBe("cli")
    expect(() => decode("browser")).toThrow()
  })

  it("ClientsStatus 往返", () => {
    const s = decodeClientsStatus({
      clients: [{ id: "c1", role: "gui", label: null, connectedAt: 1720000000000 }],
      guiHolders: 1, lingerMs: 60000, idleExitArmed: false,
    })
    expect(s.clients[0]!.role).toBe("gui")
    expect(s.guiHolders).toBe(1)
  })

  it("HealOutcome 往返（none 时 tabId/sessionId 可 null）", () => {
    const h = decodeHealOutcome({ action: "none", resumed: false, sessionName: "coolie-w1", tabId: null, sessionId: null })
    expect(h.action).toBe("none")
    const h2 = decodeHealOutcome({ action: "recreated", resumed: true, sessionName: "coolie-w1", tabId: "t1", sessionId: "s1" })
    expect(h2.resumed).toBe(true)
    expect(() => decodeHealOutcome({ action: "rebooted", resumed: false, sessionName: "x", tabId: null, sessionId: null })).toThrow()
  })

  it("承接 branch 既有事件词汇（engine.session.started / prompt.delivery.degraded 已在分支上）", () => {
    // 这两个类型由并行 fixer 在本分支引入（app.ts /hooks/claude 端点 / bootstrap.ts），
    // 本计划不新增但依赖：keep-alive 的就绪门控消费 engine.session.started。此处钉住
    // CoolieEvent 解码器接受它们（type 是开放字符串，断言仅确认词汇未被收窄破坏）。
    for (const type of ["engine.session.started", "prompt.delivery.degraded"] as const) {
      const e = decodeCoolieEvent({ seq: 1, ts: 1720000000000, workspaceId: "w1", type, payload: {} })
      expect(e.type).toBe(type)
    }
  })
})
