import { transport } from './audio/transport'

export interface PlaybackOps {
  toggle: () => void
  restart: () => void
  playClip: () => void
  goIn: () => void
  goOut: () => void
}

let ops: PlaybackOps | null = null

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
  stop(): void {
    transport.stop()
  },
}
