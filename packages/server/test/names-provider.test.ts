import { describe, expect, it } from "vitest"
import {
  CUSTOM_NAMES_MAX,
  NAME_POOLS,
  NamePoolExhaustedError,
  customNamePool,
  getNamePool,
  pickName,
} from "../src/workspace/names.js"

describe("workspace name providers", () => {
  it("exposes the built-in pools and defaults to national parks", () => {
    expect(NAME_POOLS.map(({ id }) => id)).toEqual(["national-parks", "cities", "animals"])
    expect(getNamePool(undefined).id).toBe("national-parks")
    expect(getNamePool("cities").names.length).toBeGreaterThan(20)
    expect(getNamePool("animals").names.length).toBeGreaterThan(20)
  })

  it("picks an available safe slug and reports exhausted pools clearly", () => {
    const pool = { id: "tiny", displayName: "Tiny", names: ["safe-one", "safe-two"] }
    expect(pickName(new Set(["safe-one"]), pool, () => 0)).toBe("safe-two")
    expect(() => pickName(new Set(pool.names), pool)).toThrow(NamePoolExhaustedError)
    expect(() => pickName(new Set(pool.names), pool)).toThrow("tiny")
  })

  it("sanitizes, removes empty values, and deduplicates custom names", () => {
    expect(customNamePool([" Hello World ", "hello-world", "!!!", "Second_City"]).names)
      .toEqual(["hello-world", "second-city"])
  })

  it("rejects empty, oversized, and overlong custom pools", () => {
    expect(() => customNamePool(["!!!"])).toThrow("empty")
    expect(() => customNamePool(Array.from({ length: CUSTOM_NAMES_MAX + 1 }, (_, i) => `n-${i}`)))
      .toThrow(String(CUSTOM_NAMES_MAX))
    expect(() => customNamePool(["x".repeat(61)])).toThrow("60")
  })
})
