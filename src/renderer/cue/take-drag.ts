export interface TakeDrag {
  takeId: string
  duration: number
  label: string
  x: number
  y: number
  dropped: boolean
}

type Sub = (d: TakeDrag | null) => void

let current: TakeDrag | null = null
const subs = new Set<Sub>()

function emit(d: TakeDrag | null): void {
  current = d && !d.dropped ? d : null
  for (const cb of [...subs]) cb(d)
}

export const takeDrag = {
  subscribe(cb: Sub): () => void {
    subs.add(cb)
    return () => {
      subs.delete(cb)
    }
  },
  get(): TakeDrag | null {
    return current
  },
  start(d: Omit<TakeDrag, 'dropped'>): void {
    emit({ ...d, dropped: false })
  },
  move(x: number, y: number): void {
    if (current) emit({ ...current, x, y })
  },
  drop(x: number, y: number): void {
    if (current) emit({ ...current, x, y, dropped: true })
  },
  cancel(): void {
    if (current) emit(null)
  },
}
