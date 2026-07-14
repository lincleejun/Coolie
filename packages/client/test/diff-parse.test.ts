import { describe, expect, it } from "vitest"
import { parseUnifiedDiff } from "../src/rightpanel/diff.js"

describe("parseUnifiedDiff", () => {
  const sample =
    "diff --git a/a.txt b/a.txt\n" +
    "index 111..222 100644\n" +
    "--- a/a.txt\n" +
    "+++ b/a.txt\n" +
    "@@ -1,3 +1,3 @@\n" +
    " one\n" +
    "-two\n" +
    "+TWO\n" +
    " three\n"

  it("classifies content and calculates old/new line numbers", () => {
    const lines = parseUnifiedDiff(sample)
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "ctx"])
    expect(lines[5]).toMatchObject({ text: "one", oldNo: 1, newNo: 1 })
    expect(lines[6]).toMatchObject({ kind: "del", text: "two", oldNo: 2, newNo: null })
    expect(lines[7]).toMatchObject({ kind: "add", text: "TWO", oldNo: null, newNo: 2 })
    expect(lines[8]).toMatchObject({ text: "three", oldNo: 3, newNo: 3 })
  })

  it("handles empty input and resets counters for multiple hunks", () => {
    expect(parseUnifiedDiff("")).toEqual([])
    const lines = parseUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n+A\n@@ -10,1 +10,1 @@\n-b\n+B\n")
    expect(lines.find((line) => line.text === "b")?.oldNo).toBe(10)
  })

  it("treats no-newline markers as metadata without advancing counters", () => {
    const lines = parseUnifiedDiff("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+A\n")
    expect(lines.find((line) => line.text.startsWith("\\"))?.kind).toBe("meta")
    expect(lines.find((line) => line.kind === "add")?.newNo).toBe(1)
  })

  it("safely degrades binary, rename, copy, and mode headers to metadata", () => {
    const headers = [
      "diff --git a/logo.png b/logo.png\nindex 111..222 100644\nBinary files a/logo.png b/logo.png differ\n",
      "diff --git a/old.ts b/new.ts\nsimilarity index 92%\nrename from old.ts\nrename to new.ts\n",
      "diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\ncopy from src/a.ts\ncopy to src/b.ts\n",
      "diff --git a/x.ts b/x.ts\nold mode 100644\nnew mode 100755\n",
    ]
    for (const unified of headers)
      expect(parseUnifiedDiff(unified).every((line) => line.kind === "meta")).toBe(true)
  })

  it("parses new and deleted files while keeping their headers metadata", () => {
    const added = parseUnifiedDiff(
      "diff --git a/x.ts b/x.ts\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1 @@\n+hello\n",
    )
    expect(added.slice(0, 5).every((line) => line.kind === "meta")).toBe(true)
    expect(added.find((line) => line.kind === "add")).toMatchObject({ text: "hello", newNo: 1 })

    const deleted = parseUnifiedDiff(
      "diff --git a/y.ts b/y.ts\ndeleted file mode 100644\nindex 111..000\n--- a/y.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
    )
    expect(deleted.find((line) => line.kind === "del")).toMatchObject({ text: "bye", oldNo: 1 })
  })
})
