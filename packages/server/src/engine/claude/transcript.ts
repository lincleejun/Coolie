import * as path from "node:path"

/** claude 转录目录编码：cwd 每个非字母数字字符折叠为 '-'（本机实测：/a/b_c.d → -a-b-c-d）。 */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-")

export const transcriptPath = (home: string, cwd: string, sessionId: string): string =>
  path.join(home, "projects", encodeCwd(cwd), `${sessionId}.jsonl`)

/** 派生标题：首条 type=user 的 message.content（string 或 text blocks），剥 <tag>…</tag>，60 字截断。 */
export const deriveTitle = (jsonl: string): string | null => {
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type !== "user") continue
    const content = obj?.message?.content
    let text = ""
    if (typeof content === "string") text = content
    else if (Array.isArray(content)) text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join(" ")
    text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (text === "") continue
    return text.length > 60 ? text.slice(0, 60) : text
  }
  return null
}

export const resumeArgs = (sessionId: string): string[] => ["--resume", sessionId]
