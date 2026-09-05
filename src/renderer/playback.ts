import { useSyncExternalStore } from 'react'
import { transport } from './audio/transport'

export type Side = 'orig' | 'active'

export interface SideInfo {
  id: string | null
  label: string
}

export interface PlaybackOps {
  toggle: (side: Side) => void
  restart: (side: Side) => void
  compare: () => void
  cancelCompare: () => void
}

export interface PlaybackState {
  target: Side
  orig: SideInfo
  active: SideInfo
}

const NO_SIDE: SideInfo = { id: null, label: '—' }
const EMPTY: PlaybackState = { target: 'active', orig: NO_SIDE, active: NO_SIDE }

let state: PlaybackState = EMPTY
let ops: PlaybackOps | null = null
const subs = new Set<() => void>()

function emit(next: PlaybackState): void {
  state = next
  for (const cb of [...subs]) cb()
}

function sameSide(a: SideInfo, b: SideInfo): boolean {
  return a.id === b.id && a.label === b.label
}

function available(side: Side): boolean {
  return state[side].id !== null
}

function getState(): PlaybackState {
  return state
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

function setTarget(side: Side): void {
  if (state.target !== side) emit({ ...state, target: side })
}

function toggle(side: Side): void {
  if (!available(side)) return
  setTarget(side)
  ops?.cancelCompare()
  ops?.toggle(side)
}

export const playback = {
  getState,
  subscribe,
  setOps(next: PlaybackOps | null): void {
    ops = next
  },
  setSides(orig: SideInfo, active: SideInfo): void {
    if (sameSide(state.orig, orig) && sameSide(state.active, active)) return
    emit({ ...state, orig, active })
  },
  reset(): void {
    emit(EMPTY)
  },
  setTarget,
  toggle,
  toggleTarget(): void {
    toggle(available(state.target) ? state.target : state.target === 'orig' ? 'active' : 'orig')
  },
  restart(side: Side): void {
    if (!available(side)) return
    setTarget(side)
    ops?.cancelCompare()
    ops?.restart(side)
  },
  compare(): void {
    ops?.compare()
  },
  cancelCompare(): void {
    ops?.cancelCompare()
  },
  stop(): void {
    ops?.cancelCompare()
    transport.stop()
  },
}

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(subscribe, getState)
}
