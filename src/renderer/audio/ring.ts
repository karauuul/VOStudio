export const RING_SECONDS = 390

export const PREROLL_SECONDS = 0.25

export const MAX_GAP_SECONDS = 1

export interface Ring {
  buf: Float32Array
  capacity: number
  base: number
  end: number
}

export function createRing(capacity: number): Ring {
  const n = Math.max(1, Math.floor(capacity))
  return { buf: new Float32Array(n), capacity: n, base: -1, end: -1 }
}

export function createRingForRate(sampleRate: number, seconds = RING_SECONDS): Ring {
  return createRing(Math.ceil(seconds * sampleRate))
}

export function ringFirstFrame(r: Ring): number {
  if (r.end < 0) return -1
  return Math.max(r.base, r.end - r.capacity)
}

export function ringLength(r: Ring): number {
  if (r.end < 0) return 0
  return r.end - ringFirstFrame(r)
}

function put(r: Ring, chunk: Float32Array, from: number, len: number): void {
  if (len <= 0) return
  let off = from
  let n = len
  if (n >= r.capacity) {
    off = from + n - r.capacity
    r.end += n - r.capacity
    n = r.capacity
  }
  const w = ((r.end % r.capacity) + r.capacity) % r.capacity
  const first = Math.min(n, r.capacity - w)
  r.buf.set(chunk.subarray(off, off + first), w)
  if (first < n) r.buf.set(chunk.subarray(off + first, off + n), 0)
  r.end += n
}

const silence = (n: number): Float32Array => new Float32Array(n)

export function ringWrite(r: Ring, chunk: Float32Array, atFrame: number, maxGap = 0): boolean {
  const frame = Math.round(atFrame)
  if (r.end < 0) {
    r.base = frame
    r.end = frame
    put(r, chunk, 0, chunk.length)
    return false
  }
  if (frame === r.end) {
    put(r, chunk, 0, chunk.length)
    return false
  }
  if (frame > r.end) {
    const gap = frame - r.end
    if (gap <= maxGap) {
      put(r, silence(gap), 0, gap)
      put(r, chunk, 0, chunk.length)
      return true
    }
    r.base = frame
    r.end = frame
    put(r, chunk, 0, chunk.length)
    return true
  }
  const skip = r.end - frame
  if (skip >= chunk.length) return true
  put(r, chunk, skip, chunk.length - skip)
  return true
}

export function ringSlice(r: Ring, from: number, to: number): Float32Array {
  if (r.end < 0) return new Float32Array(0)
  const lo = Math.max(Math.round(from), ringFirstFrame(r))
  const hi = Math.min(Math.round(to), r.end)
  if (hi <= lo) return new Float32Array(0)

  const out = new Float32Array(hi - lo)
  const start = ((lo % r.capacity) + r.capacity) % r.capacity
  const first = Math.min(out.length, r.capacity - start)
  out.set(r.buf.subarray(start, start + first), 0)
  if (first < out.length) out.set(r.buf.subarray(0, out.length - first), first)
  return out
}

export interface Marks {
  start: number
  stop: number
}

export function takeWindow(r: Ring, m: Marks, prerollFrames: number): { from: number; to: number } {
  const first = ringFirstFrame(r)
  if (first < 0) return { from: 0, to: 0 }
  const from = Math.max(Math.round(m.start) - Math.max(0, Math.round(prerollFrames)), first)
  const to = Math.min(Math.round(m.stop), r.end)
  return to > from ? { from, to } : { from, to: from }
}

export function sliceTake(r: Ring, m: Marks, prerollFrames: number): Float32Array {
  const w = takeWindow(r, m, prerollFrames)
  return ringSlice(r, w.from, w.to)
}
