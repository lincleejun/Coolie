import { describe, it, expect, afterEach, vi } from "vitest"
import { makeApi, probeHealth, type ServerInfo } from "../src/api/client.js"

const info: ServerInfo = { port: 61234, token: "tok-abc/xyz", pid: 999 }
const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

type Captured = { url: string; init: RequestInit | undefined }
const stub = (status: number, body: unknown): Captured[] => {
  const calls: Captured[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const headers = status === 204 ? {} : { "content-type": "application/json" }
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers })
  }) as typeof fetch
  return calls
}
const hdr = (init: RequestInit | undefined, k: string) => (init?.headers as Record<string, string>)[k]

describe("req request shapes (mock fetch — T3 routes not live yet)", () => {
  it("POST /input：method/url/Bearer/JSON body 正确", async () => {
    const calls = stub(200, { ok: true })
    const api = makeApi(info)
    await api.req("POST", "/workspaces/W1/input", { text: "ping", mode: "send", skipStable: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`http://127.0.0.1:${info.port}/workspaces/W1/input`)
    expect(calls[0]!.init!.method).toBe("POST")
    expect(hdr(calls[0]!.init, "Authorization")).toBe(`Bearer ${info.token}`)
    expect(hdr(calls[0]!.init, "content-type")).toBe("application/json")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ text: "ping", mode: "send", skipStable: true })
  })
  it("POST /tabs {kind:shell}：body 正确并回传 json", async () => {
    const calls = stub(201, { id: "T9", kind: "shell" })
    const api = makeApi(info)
    const shell = await api.req("POST", "/workspaces/W1/tabs", { kind: "shell" })
    expect(shell.kind).toBe("shell")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ kind: "shell" })
  })
  it("DELETE /tabs/:id：无 body、无 content-type，204 → undefined", async () => {
    const calls = stub(204, null)
    const api = makeApi(info)
    const out = await api.req("DELETE", "/workspaces/W1/tabs/T9")
    expect(out).toBeUndefined()
    expect(calls[0]!.init!.method).toBe("DELETE")
    expect(calls[0]!.init!.body).toBeUndefined()
    expect(hdr(calls[0]!.init, "content-type")).toBeUndefined()
  })
  it("非 2xx → ApiError{code,message,status} 取自 json", async () => {
    stub(409, { code: "Conflict", message: "脏树" })
    const api = makeApi(info)
    await expect(api.req("POST", "/workspaces/W1/archive", {})).rejects.toMatchObject(
      { name: "ApiError", code: "Conflict", message: "脏树", status: 409 },
    )
  })
  it("probeHealth：ok→true，抛错→false", async () => {
    stub(200, {})
    expect(await probeHealth(info)).toBe(true)
    globalThis.fetch = (async () => { throw new Error("down") }) as typeof fetch
    expect(await probeHealth(info)).toBe(false)
  })
})
