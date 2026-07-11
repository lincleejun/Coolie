import { randomBytes, timingSafeEqual } from "node:crypto"

export const newToken = (): string => randomBytes(32).toString("hex")

export const tokenEquals = (a: string, b: string): boolean => {
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
