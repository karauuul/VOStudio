export interface LruOptions<V> {
  maxEntries: number
  maxCost?: number
  cost?: (value: V) => number
}

export class Lru<V> {
  private readonly map = new Map<string, V>()
  private readonly costs = new Map<string, number>()
  private readonly pinnedKeys = new Set<string>()
  private total = 0

  constructor(private readonly opts: LruOptions<V>) {}

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined
    const v = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  peek(key: string): V | undefined {
    return this.map.get(key)
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.delete(key)
    const c = this.opts.cost ? this.opts.cost(value) : 0
    this.map.set(key, value)
    this.costs.set(key, c)
    this.total += c
    this.evict(key)
  }

  delete(key: string): boolean {
    if (!this.map.has(key)) return false
    this.total -= this.costs.get(key) ?? 0
    this.costs.delete(key)
    this.map.delete(key)
    this.pinnedKeys.delete(key)
    return true
  }

  clear(): void {
    this.map.clear()
    this.costs.clear()
    this.pinnedKeys.clear()
    this.total = 0
  }

  pin(key: string): void {
    this.pinnedKeys.add(key)
  }

  unpin(key: string): void {
    this.pinnedKeys.delete(key)
  }

  get size(): number {
    return this.map.size
  }

  get cost(): number {
    return this.total
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  private evict(keep: string): void {
    const maxCost = this.opts.maxCost
    const over = (): boolean =>
      this.map.size > this.opts.maxEntries || (maxCost !== undefined && this.total > maxCost)
    if (!over()) return
    for (const key of [...this.map.keys()]) {
      if (!over()) return
      if (key === keep || this.pinnedKeys.has(key)) continue
      this.delete(key)
    }
  }
}
