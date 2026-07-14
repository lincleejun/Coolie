/** Name providers are server-owned so every client gets the same safe slugs. */
export interface NamePool {
  readonly id: string
  readonly displayName: string
  readonly names: ReadonlyArray<string>
}

export const NATIONAL_PARKS: NamePool = {
  id: "national-parks",
  displayName: "National Parks",
  names: [
    "usa-yellowstone", "usa-yosemite", "usa-zion", "usa-glacier", "usa-denali",
    "usa-acadia", "usa-olympic", "usa-sequoia", "usa-arches", "usa-badlands",
    "usa-everglades", "usa-shenandoah", "usa-redwood", "usa-bigbend",
    "canada-banff", "canada-jasper", "canada-yoho", "canada-kootenay", "canada-fundy", "canada-grosmorne",
    "china-zhangjiajie", "china-jiuzhaigou", "china-huangshan", "china-sanqingshan", "china-potatso", "china-shennongjia",
    "japan-fuji", "japan-shiretoko", "japan-nikko", "japan-daisetsuzan",
    "australia-kakadu", "australia-uluru", "australia-daintree",
    "newzealand-fiordland", "newzealand-tongariro",
    "chile-torres", "argentina-iguazu", "argentina-glaciares", "peru-manu", "ecuador-galapagos", "brazil-chapada",
    "tanzania-serengeti", "kenya-amboseli", "southafrica-kruger", "namibia-etosha", "botswana-chobe",
    "iceland-vatnajokull", "norway-jotunheimen", "sweden-sarek", "finland-oulanka",
    "spain-ordesa", "france-vanoise", "italy-gransasso", "croatia-plitvice",
  ],
}

export const CITIES: NamePool = {
  id: "cities",
  displayName: "Cities",
  names: [
    "amsterdam", "athens", "auckland", "barcelona", "berlin", "boston",
    "brisbane", "copenhagen", "dublin", "edinburgh", "florence", "geneva",
    "helsinki", "kyoto", "lisbon", "london", "melbourne", "montreal",
    "osaka", "oslo", "paris", "prague", "reykjavik", "seattle",
    "seoul", "singapore", "stockholm", "sydney", "taipei", "tokyo",
    "toronto", "vienna", "warsaw", "wellington", "zurich",
  ],
}

export const ANIMALS: NamePool = {
  id: "animals",
  displayName: "Animals",
  names: [
    "albatross", "badger", "beaver", "bison", "caracal", "chamois",
    "cheetah", "condor", "dolphin", "falcon", "fennec", "gecko",
    "heron", "ibex", "jaguar", "kingfisher", "koala", "lemur",
    "lynx", "manatee", "marmot", "narwhal", "ocelot", "otter",
    "panda", "pangolin", "pelican", "penguin", "puffin", "quokka",
    "raven", "red-panda", "serval", "tapir", "turtle", "wombat",
  ],
}

export const NAME_POOLS = [NATIONAL_PARKS, CITIES, ANIMALS] as const
export type BuiltinNamePoolId = typeof NAME_POOLS[number]["id"]
export const DEFAULT_NAME_POOL_ID: BuiltinNamePoolId = "national-parks"
export const CUSTOM_NAMES_MAX = 100
export const NAME_MAX_LENGTH = 60

export class NamePoolExhaustedError extends Error {
  constructor(poolId: string) {
    super(`name pool '${poolId}' is exhausted; choose another pool or provide an explicit name`)
    this.name = "NamePoolExhaustedError"
  }
}

export class InvalidNamePoolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidNamePoolError"
  }
}

export const getNamePool = (id: string | undefined): NamePool => {
  const wanted = id ?? DEFAULT_NAME_POOL_ID
  const pool = NAME_POOLS.find((candidate) => candidate.id === wanted)
  if (!pool) throw new InvalidNamePoolError(`unknown name pool '${wanted}'`)
  return pool
}

export const customNamePool = (rawNames: readonly string[]): NamePool => {
  if (rawNames.length > CUSTOM_NAMES_MAX)
    throw new InvalidNamePoolError(`custom names may contain at most ${CUSTOM_NAMES_MAX} items`)
  for (const value of rawNames) {
    if (value.length > NAME_MAX_LENGTH)
      throw new InvalidNamePoolError(`each custom name may contain at most ${NAME_MAX_LENGTH} characters`)
  }
  const names = [...new Set(rawNames.map(sanitizeSlug).filter(Boolean))]
  if (names.length === 0) throw new InvalidNamePoolError("custom name pool is empty after sanitization")
  return { id: "custom", displayName: "Custom", names }
}

/** Pick an unused name. Exhaustion is explicit: silently inventing suffixes defeats a curated/custom pool. */
export const pickName = (
  taken: ReadonlySet<string>,
  pool: NamePool = NATIONAL_PARKS,
  rand: () => number = Math.random,
): string => {
  const free = pool.names.filter((n) => !taken.has(n))
  if (free.length > 0) return free[Math.floor(rand() * free.length)]!
  throw new NamePoolExhaustedError(pool.id)
}

/** branch slug 消毒：小写、非字母数字折叠为 '-'、去首尾 '-'、限 60 字符。空结果由调用方判 Validation。 */
export const sanitizeSlug = (input: string): string =>
  input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX_LENGTH).replace(/-+$/, "")
