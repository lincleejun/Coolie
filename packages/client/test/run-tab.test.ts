import { describe, expect, it, vi } from "vitest"
import { openRunTab } from "../src/terminal/run"

describe("openRunTab", () => {
  it("POSTs kind=run and selects the returned singleton tab", async () => {
    const req = vi.fn().mockResolvedValue({ id: "run-1", kind: "run" })
    const select = vi.fn()

    const tab = await openRunTab({ req }, "ws-1", select)

    expect(req).toHaveBeenCalledWith("POST", "/workspaces/ws-1/tabs", { kind: "run" })
    expect(select).toHaveBeenCalledWith("ws-1", "run-1")
    expect(tab.id).toBe("run-1")
  })
})
