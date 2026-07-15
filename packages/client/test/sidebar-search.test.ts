import { describe, expect, it } from "vitest"
import { matchesSidebarSearch } from "../src/sidebar/Sidebar.js"

describe("matchesSidebarSearch", () => {
  it("matches workspace names and branches without case sensitivity", () => {
    expect(matchesSidebarSearch("MAG", "mag-fix", "coolie/other")).toBe(true)
    expect(matchesSidebarSearch("mag", "other", "coolie/MAG-42")).toBe(true)
  })

  it("matches project names without case sensitivity", () => {
    expect(matchesSidebarSearch("MAG", "unrelated task", "coolie/task", "Magento")).toBe(true)
  })

  it("trims the query and preserves empty-query behavior", () => {
    expect(matchesSidebarSearch("  mag  ", "Magento")).toBe(true)
    expect(matchesSidebarSearch("   ", "anything")).toBe(true)
  })

  it("rejects unrelated values", () => {
    expect(matchesSidebarSearch("MAG", "task", "coolie/task", "Coolie")).toBe(false)
  })
})
