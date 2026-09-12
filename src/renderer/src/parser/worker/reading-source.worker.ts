import {
  resolveReadingInsertion,
  type ReadingSelectionAddress,
  type ReadingInsertion
} from '../reading-source'

export interface ReadingSourceRequest {
  source: string
  address: ReadingSelectionAddress
  startAddress?: ReadingSelectionAddress
  levelCap: number
}
export type ReadingSourceResponse = { insertion: ReadingInsertion } | { error: string }
const ctx = self as unknown as {
  onmessage: (event: MessageEvent<ReadingSourceRequest>) => void
  postMessage(response: ReadingSourceResponse): void
}
ctx.onmessage = ({ data }) => {
  try {
    const insertion = resolveReadingInsertion(data.source, data.address, data.levelCap)
    if (data.startAddress)
      insertion.start = resolveReadingInsertion(
        data.source,
        data.startAddress,
        data.levelCap
      ).position
    if (insertion.start !== undefined && insertion.start > insertion.position)
      throw Error('选区起止顺序不一致。')
    ctx.postMessage({ insertion })
  } catch (error) {
    ctx.postMessage({ error: error instanceof Error ? error.message : '暂时无法定位这处选区。' })
  }
}
