/** 名池 provider：目录名生成后不变（rename 只改显示 label，M2）。M1 只内置 national-parks。 */
export interface NamePool {
  readonly id: string
  readonly names: ReadonlyArray<string>
}

export const NATIONAL_PARKS: NamePool = {
  id: "national-parks",
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

/** 未用名里随机取一个；全占用时找最小可用数字后缀（-2 起）。rand 可注入以便测试。 */
export const pickName = (
  taken: ReadonlySet<string>,
  pool: NamePool = NATIONAL_PARKS,
  rand: () => number = Math.random,
): string => {
  const free = pool.names.filter((n) => !taken.has(n))
  if (free.length > 0) return free[Math.floor(rand() * free.length)]!
  for (let i = 2; ; i++) {
    const cands = pool.names.filter((n) => !taken.has(`${n}-${i}`))
    if (cands.length > 0) return `${cands[Math.floor(rand() * cands.length)]!}-${i}`
  }
}

/** branch slug 消毒：小写、非字母数字折叠为 '-'、去首尾 '-'、限 60 字符。空结果由调用方判 Validation。 */
export const sanitizeSlug = (input: string): string =>
  input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
