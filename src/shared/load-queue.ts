export interface LoadOptions {
  priority?: number
  signal?: AbortSignal
}

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

interface Entry<T> {
  key: string
  priority: number
  seq: number
  started: boolean
  waiters: Set<Waiter<T>>
}

export class LoadQueue<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private active = 0
  private seq = 0

  constructor(
    private readonly concurrency: number,
    private readonly run: (key: string, priority: number) => Promise<T>
  ) {}

  load(key: string, { priority = 0, signal }: LoadOptions = {}): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { key, priority, seq: ++this.seq, started: false, waiters: new Set() }
        this.entries.set(key, entry)
      } else if (!entry.started) {
        entry.priority = Math.max(entry.priority, priority)
      }
      const waiter: Waiter<T> = { resolve, reject }
      entry.waiters.add(waiter)
      const target = entry
      signal?.addEventListener('abort', () => this.abandon(target, waiter, signal.reason), { once: true })
      this.pump()
    })
  }

  private next(): Entry<T> | undefined {
    let best: Entry<T> | undefined
    for (const e of this.entries.values()) {
      if (e.started) continue
      if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq < best.seq)) best = e
    }
    return best
  }

  private abandon(entry: Entry<T>, waiter: Waiter<T>, reason: unknown): void {
    if (!entry.waiters.delete(waiter)) return
    waiter.reject(reason)
    if (!entry.started && entry.waiters.size === 0 && this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const entry = this.next()
      if (!entry) return
      entry.started = true
      this.active++
      let task: Promise<T>
      try {
        task = this.run(entry.key, entry.priority)
      } catch (e) {
        task = Promise.reject(e)
      }
      const settle = (notify: (w: Waiter<T>) => void): void => {
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
        this.active--
        const waiters = [...entry.waiters]
        entry.waiters.clear()
        for (const w of waiters) notify(w)
        this.pump()
      }
      void task.then(
        (value) => settle((w) => w.resolve(value)),
        (reason: unknown) => settle((w) => w.reject(reason))
      )
    }
  }
}
