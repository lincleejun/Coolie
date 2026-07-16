import * as fs from "node:fs"
import * as path from "node:path"
import { Data } from "effect"
import type { FilesToCopySource } from "./include.js"
import {
  resolveFilesToCopyRules,
  selectIncludedPaths,
} from "./include.js"
import {
  listCopyManifest,
  replaceCopyManifest,
  type CopyManifestEntry,
} from "../repo/copy-manifest.js"

export const COPY_MAX_FILES = 1_000
export const COPY_MAX_TOTAL_BYTES = 100 * 1024 * 1024
export const COPY_MAX_FILE_BYTES = 20 * 1024 * 1024

export class CopyError extends Data.TaggedError("CopyError")<{
  readonly code:
    | "invalid-path"
    | "escape-path"
    | "symlink"
    | "special-file"
    | "limit-exceeded"
    | "apply-failed"
  readonly message: string
}> {}

export interface CopyPlanEntry {
  readonly relativePath: string
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
}

export interface CopyPlan {
  readonly source: FilesToCopySource
  readonly entries: readonly CopyPlanEntry[]
  readonly totalBytes: number
}

export interface CopyResult {
  readonly copied: readonly string[]
  readonly totalBytes: number
}

const normalizeRelPath = (rel: string): string => rel.replace(/\\/g, "/")

const assertInsideRoot = (root: string, target: string, opts?: { requireExists?: boolean }): void => {
  const normalizedRoot = fs.realpathSync(path.resolve(root))
  const normalizedTarget = opts?.requireExists === false
    ? path.resolve(target)
    : fs.realpathSync(path.resolve(target))
  const rootPrefix = normalizedRoot + path.sep
  if (!normalizedTarget.startsWith(rootPrefix) && normalizedTarget !== normalizedRoot)
    throw new CopyError({ code: "escape-path", message: `path escapes root: ${target}` })
}

export const inspectCopyCandidate = (
  repoRoot: string,
  relativePath: string,
): CopyPlanEntry => {
  const rel = normalizeRelPath(relativePath)
  if (rel === "" || rel.startsWith("/") || rel.includes(".."))
    throw new CopyError({ code: "invalid-path", message: `invalid relative path: ${relativePath}` })

  const repoReal = fs.realpathSync(path.resolve(repoRoot))
  const src = path.resolve(repoRoot, rel)
  if (!fs.existsSync(src))
    throw new CopyError({ code: "invalid-path", message: `missing file: ${relativePath}` })

  const lstat = fs.lstatSync(src)
  if (lstat.isSymbolicLink())
    throw new CopyError({ code: "symlink", message: `symlink rejected: ${relativePath}` })
  if (!lstat.isFile())
    throw new CopyError({ code: "special-file", message: `non-regular file rejected: ${relativePath}` })

  assertInsideRoot(repoReal, src)
  const stat = fs.statSync(src)
  if (stat.size > COPY_MAX_FILE_BYTES)
    throw new CopyError({ code: "limit-exceeded", message: `file exceeds max size: ${relativePath}` })

  return {
    relativePath: rel,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
  }
}

export const buildCopyPlan = (
  repoRoot: string,
  candidates: readonly string[],
  projectPatterns?: readonly string[],
): CopyPlan => {
  const { source, patterns } = resolveFilesToCopyRules(repoRoot, projectPatterns)
  const selected = selectIncludedPaths(candidates, patterns)
  const entries: CopyPlanEntry[] = []
  let totalBytes = 0
  for (const rel of selected) {
    const entry = inspectCopyCandidate(repoRoot, rel)
    totalBytes += entry.size
    if (entries.length + 1 > COPY_MAX_FILES || totalBytes > COPY_MAX_TOTAL_BYTES)
      throw new CopyError({ code: "limit-exceeded", message: "copy limits exceeded" })
    entries.push(entry)
  }
  return { source, entries, totalBytes }
}

const atomicCopyFile = (src: string, dst: string, mode: number): void => {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.coolie-copy-${process.pid}-${Date.now()}.tmp`
  fs.copyFileSync(src, tmp)
  fs.chmodSync(tmp, mode & 0o777)
  fs.renameSync(tmp, dst)
}

export const applyCopyPlan = (
  repoRoot: string,
  worktreePath: string,
  plan: CopyPlan,
  opts: {
    readonly workspaceId: string
    readonly db?: import("better-sqlite3").Database
    readonly now?: number
  },
): CopyResult => {
  const normalizedRepoRoot = fs.realpathSync(path.resolve(repoRoot))
  const normalizedWorktreePath = path.resolve(worktreePath)
  const staged: Array<{ src: string; dst: string; entry: CopyPlanEntry }> = []

  for (const entry of plan.entries) {
    const src = path.resolve(normalizedRepoRoot, entry.relativePath)
    const dst = path.resolve(normalizedWorktreePath, entry.relativePath)
    assertInsideRoot(normalizedRepoRoot, src)
    assertInsideRoot(normalizedWorktreePath, dst, { requireExists: false })
    staged.push({ src, dst, entry })
  }

  const copied: string[] = []
  try {
    for (const item of staged) {
      atomicCopyFile(item.src, item.dst, item.entry.mode)
      copied.push(item.entry.relativePath)
    }
  } catch (error) {
    for (const rel of copied) {
      const dst = path.resolve(normalizedWorktreePath, rel)
      try { fs.unlinkSync(dst) } catch { /* best-effort rollback */ }
    }
    throw new CopyError({
      code: "apply-failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (opts.db) {
    const now = opts.now ?? Date.now()
    const manifest: CopyManifestEntry[] = plan.entries.map((entry) => ({
      workspaceId: opts.workspaceId,
      relativePath: entry.relativePath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      mode: entry.mode,
      ruleSource: plan.source,
      copiedAt: now,
    }))
    replaceCopyManifest(opts.db, opts.workspaceId, manifest)
  }

  return { copied, totalBytes: plan.totalBytes }
}

export const previewWorktreeEnvironment = (
  repoRoot: string,
  candidates: readonly string[],
  projectPatterns?: readonly string[],
): CopyPlan => buildCopyPlan(repoRoot, candidates, projectPatterns)

export const listWorktreeCopyManifest = (
  db: import("better-sqlite3").Database,
  workspaceId: string,
): CopyManifestEntry[] => listCopyManifest(db, workspaceId)
