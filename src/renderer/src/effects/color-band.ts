import type { ReadingColorMark } from '../../../shared/reading-colors'
import type { readingPalette } from './reading-palette'
export interface ColorInk {
  name: string
  mark: ReadingColorMark
  born: number
  ranges: Range[]
  base: string
  palette: ReturnType<typeof readingPalette>
}
export interface ColorBand {
  key: string
  ink: ColorInk
  x: number
  y: number
  width: number
  height: number
}
export interface ColorLayer {
  id: string
  host: HTMLElement
  width: number
  height: number
  bands: ColorBand[]
}
