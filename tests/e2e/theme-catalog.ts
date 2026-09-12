/** Public names and skin identities expected in the integrated desktop reader. */
export const READING_THEMES = [
  ['白纸', 'paper'],
  ['琉璃', 'lucent'],
  ['星辰', 'astral'],
  ['朱砂书院', 'cinnabar'],
  ['玄青静观', 'nocturne'],
  ['星图漫游', 'cosmos'],
  ['先锋构成', 'manifesto'],
  ['苔庭', 'botanical'],
  ['晨雾', 'prism'],
  ['潮光', 'chaosheng']
] as const

export const READING_THEME_NAMES = READING_THEMES.map(([name]) => name)
