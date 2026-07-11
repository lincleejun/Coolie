import { describe, it, expect } from "vitest"
import { NATIONAL_PARKS, pickName, sanitizeSlug } from "../src/workspace/names.js"
import { PORT_BLOCK_SIZE, PORT_BASE_START, allocatePortBase, portEnv } from "../src/workspace/ports.js"

// Import PORT_BASE_MAX for exhaustion test (it's private so we calculate it)
const PORT_BASE_MAX = 64_990

describe("name pool", () => {
  it("national-parks pool has >=40 unique country-park slugs", () => {
    expect(NATIONAL_PARKS.id).toBe("national-parks")
    expect(NATIONAL_PARKS.names.length).toBeGreaterThanOrEqual(40)
    expect(new Set(NATIONAL_PARKS.names).size).toBe(NATIONAL_PARKS.names.length)
    for (const n of NATIONAL_PARKS.names) expect(n).toMatch(/^[a-z]+-[a-z0-9]+$/)
  })
  it("pickName avoids taken names (deterministic with rand=0)", () => {
    const first = NATIONAL_PARKS.names[0]!
    expect(pickName(new Set(), NATIONAL_PARKS, () => 0)).toBe(first)
    expect(pickName(new Set([first]), NATIONAL_PARKS, () => 0)).toBe(NATIONAL_PARKS.names[1]!)
  })
  it("pickName suffixes when the whole pool is taken", () => {
    const taken = new Set(NATIONAL_PARKS.names)
    expect(pickName(taken, NATIONAL_PARKS, () => 0)).toBe(`${NATIONAL_PARKS.names[0]!}-2`)
    const taken2 = new Set([...NATIONAL_PARKS.names, ...NATIONAL_PARKS.names.map((n) => `${n}-2`)])
    expect(pickName(taken2, NATIONAL_PARKS, () => 0)).toBe(`${NATIONAL_PARKS.names[0]!}-3`)
  })
  it("sanitizeSlug normalizes arbitrary input", () => {
    expect(sanitizeSlug("Fix Login!!")).toBe("fix-login")
    expect(sanitizeSlug("--weird__Case--")).toBe("weird-case")
    expect(sanitizeSlug("!!!")).toBe("")
  })
  it("sanitizeSlug does not emit trailing hyphen after slice", () => {
    // 59 a's + "-tail" = 65 chars total
    // slice(0, 60) would give 59 a's + "-" without the fix
    expect(sanitizeSlug("a".repeat(59) + "-tail")).toBe("a".repeat(59))
  })
  it("sanitizeSlug enforces 60-char limit", () => {
    expect(sanitizeSlug("x".repeat(100)).length).toBe(60)
  })
})

describe("port block allocation", () => {
  it("starts at 40000, steps by 10, reuses freed blocks", () => {
    expect(PORT_BLOCK_SIZE).toBe(10)
    expect(PORT_BASE_START).toBe(40000)
    expect(allocatePortBase([])).toBe(40000)
    expect(allocatePortBase([40000])).toBe(40010)
    expect(allocatePortBase([40000, 40010])).toBe(40020)
    expect(allocatePortBase([40010])).toBe(40000) // 已删 workspace 的段可复用
  })
  it("portEnv exposes COOLIE_PORT_0..9", () => {
    const env = portEnv(40020)
    expect(env.COOLIE_PORT_0).toBe("40020")
    expect(env.COOLIE_PORT_9).toBe("40029")
    expect(Object.keys(env)).toHaveLength(10)
  })
  it("allocatePortBase throws when all blocks are exhausted", () => {
    // Build array of all allocated blocks from PORT_BASE_START to PORT_BASE_MAX
    const allBlocks: number[] = []
    for (let base = PORT_BASE_START; base <= PORT_BASE_MAX; base += PORT_BLOCK_SIZE) {
      allBlocks.push(base)
    }
    expect(() => allocatePortBase(allBlocks)).toThrow("端口段耗尽")
  })
})
