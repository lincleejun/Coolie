/** subsequence 模糊匹配：连续命中 +3/字符、词首（/ . - _ 后）+2、其余 +1；未全命中 = 淘汰 */
const score = (item: string, query: string): number => {
  const s = item.toLowerCase()
  const q = query.toLowerCase()
  let si = 0, total = 0, streak = 0
  for (const ch of q) {
    const at = s.indexOf(ch, si)
    if (at === -1) return -1
    const wordStart = at === 0 || "/._-".includes(s[at - 1]!)
    streak = at === si ? streak + 1 : 1
    total += streak >= 2 ? 3 : wordStart ? 2 : 1
    si = at + 1
  }
  return total - item.length * 0.01 // 等分时短路径优先
}

export const fuzzyFilter = (items: readonly string[], query: string, limit = 12): string[] => {
  if (query === "") return items.slice(0, limit)
  return items
    .map((item) => ({ item, sc: score(item, query) }))
    .filter((x) => x.sc >= 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .map((x) => x.item)
}

export interface TokenHit { kind: "file" | "command"; query: string; start: number }

/** caret 前的当前 token：@… 任意词起始处 = file；/… 仅行首 = command */
export const detectToken = (text: string, caret: number): TokenHit | null => {
  const upto = text.slice(0, caret)
  const wordStart = Math.max(upto.lastIndexOf(" "), upto.lastIndexOf("\n")) + 1
  const token = upto.slice(wordStart)
  if (token.startsWith("@") && token.length >= 1)
    return { kind: "file", query: token.slice(1), start: wordStart }
  if (token.startsWith("/") && wordStart === 0)
    return { kind: "command", query: token.slice(1), start: 0 }
  return null
}
