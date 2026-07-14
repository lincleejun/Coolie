import { describe, expect, it, vi } from "vitest"
import {
  createSafeDeepLinkRouter,
  installDeepLinkHandlers,
  routeCoolieUrl,
} from "../src/deeplink.js"

const plugin = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}))
vi.mock("@tauri-apps/plugin-deep-link", () => plugin)

const actions = () => ({
  selectWs: vi.fn(),
  selectTab: vi.fn(),
  openProjectDispatch: vi.fn(),
})

describe("routeCoolieUrl", () => {
  it("routes workspace and tab targets", () => {
    const router = actions()
    expect(routeCoolieUrl("coolie://workspace/w1", router)).toBe(true)
    expect(routeCoolieUrl("coolie://workspace/w1/tab/t2", router)).toBe(true)
    expect(router.selectWs).toHaveBeenNthCalledWith(1, "w1")
    expect(router.selectWs).toHaveBeenNthCalledWith(2, "w1")
    expect(router.selectTab).toHaveBeenCalledWith("w1", "t2")
  })

  it("routes project targets into Dispatch", () => {
    const router = actions()
    expect(routeCoolieUrl("coolie://project/p3", router)).toBe(true)
    expect(router.openProjectDispatch).toHaveBeenCalledWith("p3")
  })

  it("rejects malformed links without dispatching", () => {
    const router = actions()
    expect(routeCoolieUrl("https://evil.example/?token=secret", router)).toBe(false)
    expect(router.selectWs).not.toHaveBeenCalled()
    expect(router.selectTab).not.toHaveBeenCalled()
    expect(router.openProjectDispatch).not.toHaveBeenCalled()
  })
})

describe("createSafeDeepLinkRouter", () => {
  it("silently ignores missing workspaces and tabs", () => {
    const target = actions()
    const router = createSafeDeepLinkRouter({
      hasWorkspace: (id) => id === "w1",
      hasTab: (wsId, tabId) => wsId === "w1" && tabId === "t1",
      hasProject: () => false,
    }, target)

    expect(() => routeCoolieUrl("coolie://workspace/missing/tab/nope", router)).not.toThrow()
    expect(() => routeCoolieUrl("coolie://workspace/w1/tab/missing", router)).not.toThrow()
    expect(target.selectWs).toHaveBeenCalledTimes(1)
    expect(target.selectWs).toHaveBeenCalledWith("w1")
    expect(target.selectTab).not.toHaveBeenCalled()
  })

  it("opens only an existing project in Dispatch", () => {
    const target = actions()
    const router = createSafeDeepLinkRouter({
      hasWorkspace: () => false,
      hasTab: () => false,
      hasProject: (id) => id === "p1",
    }, target)

    routeCoolieUrl("coolie://project/missing", router)
    routeCoolieUrl("coolie://project/p1", router)
    expect(target.openProjectDispatch).toHaveBeenCalledOnce()
    expect(target.openProjectDispatch).toHaveBeenCalledWith("p1")
  })
})

describe("installDeepLinkHandlers", () => {
  it("routes cold and running URLs and returns the plugin unlisten cleanup", async () => {
    const router = actions()
    const unlisten = vi.fn()
    let runningHandler: ((urls: string[]) => void) | undefined
    plugin.getCurrent.mockResolvedValueOnce(["coolie://workspace/cold"])
    plugin.onOpenUrl.mockImplementationOnce(async (handler: (urls: string[]) => void) => {
      runningHandler = handler
      return unlisten
    })

    const cleanup = await installDeepLinkHandlers(router)
    runningHandler?.(["coolie://project/hot"])
    expect(router.selectWs).toHaveBeenCalledWith("cold")
    expect(router.openProjectDispatch).toHaveBeenCalledWith("hot")
    cleanup()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it("silently degrades when the Tauri plugin is unavailable", async () => {
    const router = actions()
    plugin.getCurrent.mockRejectedValueOnce(new Error("not in Tauri"))
    plugin.onOpenUrl.mockRejectedValueOnce(new Error("not in Tauri"))
    const cleanup = await installDeepLinkHandlers(router)
    expect(() => cleanup()).not.toThrow()
    expect(router.selectWs).not.toHaveBeenCalled()
  })
})
