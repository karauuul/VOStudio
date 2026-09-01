export interface DurationEntry {
  cueId: string
  takeId: string
  duration: number
}

export interface DurationQueueOptions {
  flush: (batch: DurationEntry[]) => Promise<unknown> | void
  debounceMs?: number
  maxWaitMs?: number
  maxBatch?: number
}

const DEFAULTS = { debounceMs: 2000, maxWaitMs: 8000, maxBatch: 60 }

export class DurationQueue {
  private readonly pending = new Map<string, DurationEntry>()
  private readonly sent = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstAt = 0

  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly maxBatch: number

  constructor(private readonly opts: DurationQueueOptions) {
    this.debounceMs = opts.debounceMs ?? DEFAULTS.debounceMs
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULTS.maxWaitMs
    this.maxBatch = opts.maxBatch ?? DEFAULTS.maxBatch
  }

  push(entry: DurationEntry): boolean {
    if (!Number.isFinite(entry.duration) || entry.duration <= 0) return false
    if (this.sent.has(entry.takeId)) return false
    this.sent.add(entry.takeId)
    this.pending.set(entry.takeId, entry)
    if (this.pending.size >= this.maxBatch) {
      void this.flushNow()
      return true
    }
    this.schedule()
    return true
  }

  flushNow(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.firstAt = 0
    if (this.pending.size === 0) return Promise.resolve()
    const batch = [...this.pending.values()]
    this.pending.clear()
    try {
      return Promise.resolve(this.opts.flush(batch)).then(
        () => undefined,
        () => this.forget(batch)
      )
    } catch {
      this.forget(batch)
      return Promise.resolve()
    }
  }

  get size(): number {
    return this.pending.size
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.firstAt = 0
  }

  reset(): void {
    this.dispose()
    this.sent.clear()
  }

  private schedule(): void {
    const now = Date.now()
    if (this.firstAt === 0) this.firstAt = now
    const due = Math.min(now + this.debounceMs, this.firstAt + this.maxWaitMs)
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flushNow(), Math.max(0, due - now))
  }

  private forget(batch: DurationEntry[]): void {
    for (const e of batch) this.sent.delete(e.takeId)
  }
}
