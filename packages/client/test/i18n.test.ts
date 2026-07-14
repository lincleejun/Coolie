import { describe, expect, it } from "vitest"
import { DICT } from "../src/i18n/dict.js"
import { t } from "../src/i18n/index.js"

describe("i18n", () => {
  it("translates typed keys by language", () => {
    expect(t("dispatch.title", "zh")).toBe("新 Workspace")
    expect(t("dispatch.title", "en")).toBe("New Workspace")
  })

  it("falls back to zh and then the key", () => {
    expect(t("dispatch.title", "unknown" as never)).toBe("新 Workspace")
    expect(t("nonexistent.key" as never, "en")).toBe("nonexistent.key")
  })

  it("keeps zh and en key sets identical", () => {
    expect(Object.keys(DICT.en).sort()).toEqual(Object.keys(DICT.zh).sort())
  })
})
