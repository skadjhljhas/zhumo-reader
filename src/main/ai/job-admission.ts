import { AUTOMATIC_SYNTAX_CONCURRENCY, type AiRequest } from '../../shared/ai-types'

export interface AiJob {
  readonly abort: AbortController
  readonly sender: number
  readonly lane: AiRequest['lane']
  readonly id: string
  readonly automatic: boolean
  readonly annotationMode: 'follow' | 'document'
}

/** Synchronous admission happens before credentials, cache or network awaits. */
export class AiJobAdmission {
  private readonly jobs = new Map<string, AiJob>()

  reserve(
    sender: number,
    request: Pick<AiRequest, 'id' | 'lane' | 'automatic' | 'annotationMode'>
  ): AiJob {
    const key = `${sender}:${request.id}`
    if (this.jobs.has(key)) throw Error('请求编号重复。')
    const automatic = request.automatic === true
    const annotationMode = request.annotationMode ?? 'follow'
    if (automatic) {
      for (const job of this.jobs.values())
        if (
          job.sender === sender &&
          job.automatic &&
          (annotationMode === 'document' || job.annotationMode === 'document')
        )
          job.abort.abort()
      let running = 0
      for (const job of this.jobs.values())
        if (job.sender === sender && job.automatic && !job.abort.signal.aborted) running++
      if (running >= AUTOMATIC_SYNTAX_CONCURRENCY)
        throw Error(`已有 ${AUTOMATIC_SYNTAX_CONCURRENCY} 句正在自动分析，请稍后重试。`)
    } else {
      // Replacing a deliberate selection must not cancel sentences still becoming visible.
      for (const job of this.jobs.values())
        if (job.sender === sender && job.lane === request.lane && !job.automatic) job.abort.abort()
    }
    const job: AiJob = {
      abort: new AbortController(),
      sender,
      lane: request.lane,
      id: request.id,
      automatic,
      annotationMode
    }
    this.jobs.set(key, job)
    return job
  }

  cancel(sender: number, id: string): void {
    this.jobs.get(`${sender}:${id}`)?.abort.abort()
  }

  release(job: AiJob): void {
    const key = `${job.sender}:${job.id}`
    // A destroyed window's late finally cannot release a subsequently admitted job.
    if (this.jobs.get(key) === job) this.jobs.delete(key)
  }

  destroy(sender: number): void {
    for (const [key, job] of this.jobs)
      if (job.sender === sender) {
        job.abort.abort()
        this.jobs.delete(key)
      }
  }

  abortAll(): void {
    for (const job of this.jobs.values()) job.abort.abort()
  }
}
