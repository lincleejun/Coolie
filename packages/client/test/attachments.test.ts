import { describe, expect, it, vi } from "vitest"
import {
  MAX_ATTACHMENT_BYTES,
  collectSupportedImages,
  insertAttachmentPaths,
  uploadImageFiles,
  type AttachmentFile,
  type AttachmentUploadApi,
} from "../src/composer/attachments.js"

const png = (name: string, size = 8): AttachmentFile => ({
  name,
  type: "image/png",
  size,
  arrayBuffer: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
})

describe("composer attachments", () => {
  it("collects only supported images without reading file contents", () => {
    const read = vi.fn(async () => new ArrayBuffer(0))
    const files: AttachmentFile[] = [
      png("a.png"),
      { name: "svg.svg", type: "image/svg+xml", size: 10, arrayBuffer: read },
      { name: "text.txt", type: "text/plain", size: 10, arrayBuffer: read },
    ]
    expect(collectSupportedImages(files).map((file) => file.name)).toEqual(["a.png"])
    expect(read).not.toHaveBeenCalled()
  })

  it("uploads multiple images sequentially in stable order with JSON metadata", async () => {
    const calls: Array<{ path: string; body: any }> = []
    const api: AttachmentUploadApi = {
      req: vi.fn(async (_method, path, body) => {
        calls.push({ path, body })
        return { path: `/safe/${body.name}`, mime: body.mime, size: 8 }
      }),
    }
    const progress: Array<[number, number, string]> = []
    const result = await uploadImageFiles(api, "ws id", [png("first.png"), png("second.png")], {
      onProgress: (done, total, name) => progress.push([done, total, name]),
    })

    expect(calls.map((call) => call.path)).toEqual([
      "/workspaces/ws%20id/attachments",
      "/workspaces/ws%20id/attachments",
    ])
    expect(calls.map((call) => call.body.name)).toEqual(["first.png", "second.png"])
    expect(calls.every((call) => call.body.mime === "image/png")).toBe(true)
    expect(calls.every((call) => call.body.dataBase64 === "iVBORw0KGgo=")).toBe(true)
    expect(result).toEqual({ paths: ["/safe/first.png", "/safe/second.png"], errors: [] })
    expect(progress).toEqual([[0, 2, "first.png"], [1, 2, "first.png"], [2, 2, "second.png"]])
  })

  it("does not read or upload files over the decoded limit and reports the error", async () => {
    const read = vi.fn(async () => new ArrayBuffer(0))
    const api: AttachmentUploadApi = { req: vi.fn() }
    const tooLarge: AttachmentFile = {
      name: "huge.webp",
      type: "image/webp",
      size: MAX_ATTACHMENT_BYTES + 1,
      arrayBuffer: read,
    }
    const result = await uploadImageFiles(api, "w1", [tooLarge])
    expect(read).not.toHaveBeenCalled()
    expect(api.req).not.toHaveBeenCalled()
    expect(result.paths).toEqual([])
    expect(result.errors[0]).toMatchObject({ name: "huge.webp", code: "too-large" })
  })

  it("continues after one upload failure and preserves successful order", async () => {
    const api: AttachmentUploadApi = {
      req: vi.fn(async (_method, _path, body) => {
        if (body.name === "bad.png") throw new Error("network down")
        return { path: `/safe/${body.name}`, mime: body.mime, size: 8 }
      }),
    }
    const result = await uploadImageFiles(api, "w1", [png("one.png"), png("bad.png"), png("three.png")])
    expect(result.paths).toEqual(["/safe/one.png", "/safe/three.png"])
    expect(result.errors).toEqual([{ name: "bad.png", code: "upload", message: "network down" }])
  })

  it("inserts returned paths at the selection and places the caret after them", () => {
    expect(insertAttachmentPaths("hello world", 6, 11, ["/a one.png", "/b.png"])).toEqual({
      text: "hello @/a one.png @/b.png",
      caret: 25,
    })
    expect(insertAttachmentPaths("", 0, 0, ["/a.png"])).toEqual({ text: "@/a.png", caret: 7 })
  })
})
