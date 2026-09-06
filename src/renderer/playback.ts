import { transport } from './audio/transport'

export interface PlaybackOps {
  toggle: () => void
  restart: () => void
  playClip: () => void
  goIn: () => void
  goOut: () => void
  seek: (t: number) => void
  step: (dir: -1 | 1) => void
}

let ops: PlaybackOps | null = null
let pos = 0
const posSubs = new Set<(t: number) => void>()

const run = (fn: (o: PlaybackOps) => void): void => {
  if (ops) fn(ops)
}

export const playback = {
  setOps(next: PlaybackOps | null): void {
    ops = next
  },
  toggle(): void {
    run((o) => o.toggle())
  },
  restart(): void {
    run((o) => o.restart())
  },
  playClip(): void {
    run((o) => o.playClip())
  },
  goIn(): void {
    run((o) => o.goIn())
  },
  goOut(): void {
    run((o) => o.goOut())
  },
  seek(t: number): void {
    run((o) => o.seek(t))
  },
  step(dir: -1 | 1): void {
    run((o) => o.step(dir))
  },
  stop(): void {
    transport.stop()
  },
  setPos(t: number): void {
    const next = Math.round(Math.max(0, t) * 100) / 100
    if (next === pos) return
    pos = next
    for (const cb of [...posSubs]) cb(next)
  },
  getPos(): number {
    return pos
  },
  subscribePos(cb: (t: number) => void): () => void {
    posSubs.add(cb)
    return () => {
      posSubs.delete(cb)
    }
  },
}
