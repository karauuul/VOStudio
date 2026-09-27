export type KeyedQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>

export function keyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

export function queuedMethods<T extends object, K extends keyof T>(
  target: T,
  methods: readonly K[],
  queue: KeyedQueue,
  key: string
): T {
  const wrapped = { ...target }
  for (const name of methods) {
    const call = (...args: unknown[]): Promise<unknown> =>
      queue(key, () => (target[name] as unknown as (...a: unknown[]) => Promise<unknown>)(...args))
    wrapped[name] = call as T[K]
  }
  return wrapped
}
