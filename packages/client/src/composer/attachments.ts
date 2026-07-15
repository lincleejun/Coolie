import type { Api } from "../api/client"

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const SUPPORTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const

type SupportedImageMime = typeof SUPPORTED_IMAGE_MIMES[number]
const SUPPORTED = new Set<string>(SUPPORTED_IMAGE_MIMES)

/** Structural subset of File, kept injectable so Node tests do not need FileReader or DOM files. */
export interface AttachmentFile {
  readonly name: string
  readonly type: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface AttachmentUploadApi {
  req(
    method: "POST",
    path: string,
    body: { name: string; mime: string; dataBase64: string },
  ): Promise<{ path: string; mime: string; size: number }>
}

export interface AttachmentUploadError {
  readonly name: string
  readonly code: "unsupported" | "too-large" | "read" | "upload"
  readonly message: string
}

export interface AttachmentUploadResult {
  readonly paths: string[]
  readonly errors: AttachmentUploadError[]
}

export interface AttachmentReference {
  readonly label: string
  readonly path: string
}

export const isSupportedImage = (file: Pick<AttachmentFile, "type">): file is AttachmentFile & { type: SupportedImageMime } =>
  SUPPORTED.has(file.type)

export const collectSupportedImages = <T extends AttachmentFile>(files: Iterable<T>): T[] =>
  Array.from(files).filter(isSupportedImage)

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return btoa(binary)
}

/**
 * Uploads one image at a time. Sequential awaiting preserves clipboard/drop order
 * and checking size before arrayBuffer() guarantees oversized files are never read.
 */
export const uploadImageFiles = async (
  api: AttachmentUploadApi | Pick<Api, "req">,
  workspaceId: string,
  files: readonly AttachmentFile[],
  options: { onProgress?: (done: number, total: number, name: string) => void; staging?: boolean } = {},
): Promise<AttachmentUploadResult> => {
  const paths: string[] = []
  const errors: AttachmentUploadError[] = []
  const total = files.length
  if (total > 0) options.onProgress?.(0, total, files[0]!.name)

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    if (!isSupportedImage(file)) {
      errors.push({ name: file.name, code: "unsupported", message: `unsupported image type: ${file.type || "(empty)"}` })
      options.onProgress?.(index + 1, total, file.name)
      continue
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES) {
      errors.push({ name: file.name, code: "too-large", message: `image exceeds ${MAX_ATTACHMENT_BYTES} bytes` })
      options.onProgress?.(index + 1, total, file.name)
      continue
    }

    let dataBase64: string
    try {
      const data = await file.arrayBuffer()
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        errors.push({ name: file.name, code: "too-large", message: `image exceeds ${MAX_ATTACHMENT_BYTES} bytes` })
        options.onProgress?.(index + 1, total, file.name)
        continue
      }
      dataBase64 = bytesToBase64(new Uint8Array(data))
    } catch (error) {
      errors.push({ name: file.name, code: "read", message: error instanceof Error ? error.message : String(error) })
      options.onProgress?.(index + 1, total, file.name)
      continue
    }

    try {
      const endpoint = options.staging
        ? "/attachments"
        : `/workspaces/${encodeURIComponent(workspaceId)}/attachments`
      const uploaded = await api.req("POST", endpoint, {
        name: file.name,
        mime: file.type,
        dataBase64,
      })
      if (typeof uploaded.path !== "string" || uploaded.path === "") throw new Error("attachment response has no path")
      paths.push(uploaded.path)
    } catch (error) {
      errors.push({ name: file.name, code: "upload", message: error instanceof Error ? error.message : String(error) })
    }
    options.onProgress?.(index + 1, total, file.name)
  }
  return { paths, errors }
}

const insertTokens = (
  text: string,
  selectionStart: number,
  selectionEnd: number,
  tokens: readonly string[],
): { text: string; caret: number } => {
  if (tokens.length === 0) return { text, caret: selectionEnd }
  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))
  const insertion = tokens.join(" ")
  const prefix = text.slice(0, start)
  const suffix = text.slice(end)
  const before = prefix !== "" && !/\s$/.test(prefix) ? " " : ""
  const after = suffix !== "" && !/^\s/.test(suffix) ? " " : ""
  const next = `${prefix}${before}${insertion}${after}${suffix}`
  return { text: next, caret: prefix.length + before.length + insertion.length }
}

export const insertAttachmentPaths = (
  text: string,
  selectionStart: number,
  selectionEnd: number,
  paths: readonly string[],
): { text: string; caret: number } =>
  insertTokens(text, selectionStart, selectionEnd, paths.map((attachmentPath) => `@${attachmentPath}`))

export const makeAttachmentReferences = (
  paths: readonly string[],
  offset = 0,
  label = (index: number): string => `[图片 ${index}]`,
): AttachmentReference[] =>
  paths.map((attachmentPath, index) => ({ label: label(offset + index + 1), path: attachmentPath }))

export const insertAttachmentReferences = (
  text: string,
  selectionStart: number,
  selectionEnd: number,
  references: readonly AttachmentReference[],
): { text: string; caret: number } =>
  insertTokens(text, selectionStart, selectionEnd, references.map((reference) => reference.label))

/** Keep the composer readable, then expand labels to engine-readable absolute file references at submit time. */
export const translateAttachmentReferences = (
  text: string,
  references: readonly AttachmentReference[],
): string =>
  references.reduce(
    (prompt, reference) => prompt.split(reference.label).join(`${reference.label} @${reference.path}`),
    text,
  )
