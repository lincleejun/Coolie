import { useSettings, type Lang } from "../settings/settings"
import { DICT, type MsgKey } from "./dict"

export const t = (key: MsgKey, lang?: Lang): string => {
  const selected = lang ?? useSettings.getState().lang
  const dictionary = DICT[selected as keyof typeof DICT]
  return dictionary?.[key] ?? DICT.zh[key] ?? key
}

export const useT = (): ((key: MsgKey) => string) => {
  const lang = useSettings((state) => state.lang)
  return (key) => t(key, lang)
}

export type { MsgKey }
