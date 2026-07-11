/**
 * Prompt 消毒（Superset sanitizePromptForPty 同语义，独立实现）：
 * 裸 CR 会提前提交、ESC 序列会触发 keybinding、tab 会触发补全。
 * 顺序敏感：先剥成型的 OSC/CSI（否则通用控制符剥掉 ESC 后残留序列体），再剥孤立 ESC，再剥控制符，最后展开 tab。
 *
 * 实现说明：ESC/BEL/C0/C1 等控制字符一律通过 String.fromCharCode 构造，
 * 源码中不出现字面控制字节，避免与可打印文本混淆。
 */
const ch = (code: number): string => String.fromCharCode(code)
const ESC = ch(0x1b)
const BEL = ch(0x07)

// OSC: ESC ] … 直到遇到 BEL 或下一个 ESC（终止符本身留给后续步骤清理；未终止的整段剥掉）
const oscRe = new RegExp(`${ESC}\\][^${BEL}${ESC}]*`, "g")
// CSI: ESC [ 参数字节* 终止字节
const csiRe = new RegExp(`${ESC}\\[[0-9;?:!"'#$%&*+,\\-./<=>]*[A-Za-z@^_\`{|}~]`, "g")
// 其余两字节 ESC 序列（含 OSC 的 ESC\ 终止符）
const twoByteEscRe = new RegExp(`${ESC}.`, "g")
// 孤立 ESC
const strayEscRe = new RegExp(ESC, "g")

// C0（保留 \n \t）、DEL、C1
const controlRanges: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x80, 0x9f],
]
const controlClass = controlRanges.map(([a, b]) => `${ch(a)}-${ch(b)}`).join("")
const controlRe = new RegExp(`[${controlClass}]`, "g")

export const sanitizePromptForPty = (input: string): string =>
  input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(oscRe, "")
    .replace(csiRe, "")
    .replace(twoByteEscRe, "")
    .replace(strayEscRe, "")
    .replace(controlRe, "")
    .replace(/\t/g, "  ")
