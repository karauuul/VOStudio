import { compDuration, compEffectsTail, compHasPitch } from '@shared/comp'
import { emptyEdits } from '@shared/domain'
import { buildClipGraph, scheduleComp, type CompSource } from './clip-graph'
import type { ResolvedComp } from './comp-source'
import { Lru } from './lru'
import { ensurePitchModule } from './pitch-node'

export interface TransportState {
  clipId: string | null
  playing: boolean
  pos: number
  dur: number
}

export interface Clip {
  id: string
  url: string
}

export interface SequenceItem {
  id?: string
  url: string
  gapMs?: number
}

export interface SplitClip {
  id?: string
  url: string
}

export type SplitSide = SplitClip | { id?: string; comp: ResolvedComp }

const TAKE = 'take:'

export const clipId = {
  original: (relPath: string): string => 'orig:' + relPath,
  take: (takeId: string): string => TAKE + takeId,
  rec: (url: string): string => 'rec:' + url,
  reference: (url: string): string => 'ref:' + url,
  comp: (cueId: string): string => 'comp:' + cueId,
}

export function takeIdOf(id: string | null): string | null {
  return id && id.startsWith(TAKE) ? id.slice(TAKE.length) : null
}

const FADE_IN = 0.005
const FADE_OUT = 0.012
const LEAD_IN = 0.06
const END_EPS = 0.02
const SCRUB_SEEK_MS = 60

let ctx: AudioContext | null = null
let fx: GainNode | null = null
let master: GainNode | null = null

function ac(): AudioContext {
  if (ctx) return ctx
  const c = new AudioContext()
  const f = c.createGain()
  const m = c.createGain()
  f.connect(m)
  m.connect(c.destination)
  ctx = c
  fx = f
  master = m
  void ensurePitchModule(c).catch(() => {})
  const wake = (): void => {
    void c.resume().catch(() => {})
  }
  window.addEventListener('pointerdown', wake, true)
  window.addEventListener('keydown', wake, true)
  return c
}

const MAX_BUFFERS = 40
const MAX_BUFFER_BYTES = 300 * 1024 * 1024

const buffers = new Lru<AudioBuffer>({
  maxEntries: MAX_BUFFERS,
  maxCost: MAX_BUFFER_BYTES,
  cost: (b) => b.length * b.numberOfChannels * 4,
})
const inflight = new Map<string, Promise<AudioBuffer>>()

export function getBuffer(url: string): Promise<AudioBuffer> {
  const hit = buffers.get(url)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(url)
  if (running) return running

  const p = (async (): Promise<AudioBuffer> => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`audio ${res.status}: ${url}`)
    const raw = await res.arrayBuffer()
    const buf = await ac().decodeAudioData(raw)
    buffers.set(url, buf)
    return buf
  })()
  inflight.set(url, p)
  void p.then(
    () => {
      if (inflight.get(url) === p) inflight.delete(url)
    },
    () => {
      if (inflight.get(url) === p) inflight.delete(url)
    }
  )
  return p
}

export function release(url: string): void {
  buffers.delete(url)
  inflight.delete(url)
}

interface Voice {
  src: AudioBufferSourceNode
  g: GainNode
}

interface Loaded {
  id: string
  url: string
  buf: AudioBuffer | null
  dur: number
}

interface SeqItem {
  id: string
  url: string
  at: number
  dur: number
  voice: Voice
}

interface Bus {
  gain: GainNode
  sources: AudioBufferSourceNode[]
  nodes: AudioNode[]
}

interface SplitState {
  id: string
  at: number
  dur: number
  buses: Bus[]
}

interface CompState {
  id: string
  sources: CompSource[]
  dur: number
  from: number
  until: number
  at: number
  startPos: number
  bus: Bus | null
}

type Mode = 'idle' | 'clip' | 'seq' | 'split' | 'comp'

let mode: Mode = 'idle'
let cur: Loaded | null = null
let voice: Voice | null = null
let startOffset = 0
let startedAt = 0
let playing = false
let pausedPos = 0
let wantPlay = false
let gen = 0

let seq: SeqItem[] | null = null
let seqIndex = -1

let split: SplitState | null = null
let comp: CompState | null = null

let loopA = 0
let loopB: number | null = null

let lastScrubAt = 0
let raf = 0

const subs = new Set<(s: TransportState) => void>()
let waiters: (() => void)[] = []
let state: TransportState = { clipId: null, playing: false, pos: 0, dur: 0 }
let pinnedUrls: string[] = []

function pin(urls: string[]): void {
  for (const u of pinnedUrls) buffers.unpin(u)
  pinnedUrls = urls
  for (const u of urls) buffers.pin(u)
}

function emit(next: TransportState): void {
  state = next
  for (const cb of [...subs]) cb(next)
}

export function subscribe(cb: (s: TransportState) => void): () => void {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

export function getState(): TransportState {
  return state
}

export function currentClipId(): string | null {
  return state.clipId
}

export function isAB(): boolean {
  return mode === 'seq' || mode === 'split'
}

export function sourceLabel(id: string | null): string {
  if (!id) return '—'
  if (id.startsWith('orig:')) return 'Original'
  if (id.startsWith(TAKE)) return 'Take'
  if (id.startsWith('rec:')) return 'Recording'
  if (id.startsWith('ref:')) return 'Reference'
  if (id.startsWith('comp:')) return 'Composition'
  return 'Clip'
}

function makeVoice(buf: AudioBuffer, when: number, offset: number, fade: boolean): Voice {
  const c = ac()
  const plan = buildClipGraph(c, buf, emptyEdits(), { when, seek: offset })
  const g = c.createGain()
  if (fade) {
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(1, when + FADE_IN)
  }
  plan.output.connect(g)
  g.connect(fx as GainNode)
  plan.source.start(when, plan.offset)
  return { src: plan.source, g }
}

function makeCompBus(sources: CompSource[], when: number, seek: number, until = Infinity): Bus {
  const c = ac()
  const gain = c.createGain()
  gain.gain.setValueAtTime(0, when)
  gain.gain.linearRampToValueAtTime(1, when + FADE_IN)
  gain.connect(fx as GainNode)
  const s = scheduleComp(c, sources, gain, { when, seek })
  const voices = s.voices.map((v) => v.source)
  if (Number.isFinite(until)) {
    const endAt = when + Math.max(0, until - seek)
    if (endAt > when + FADE_IN + FADE_OUT) {
      gain.gain.setValueAtTime(1, endAt - FADE_OUT)
      gain.gain.linearRampToValueAtTime(0, endAt)
    }
    for (const v of s.voices) {
      try {
        v.source.stop(Math.min(endAt, v.at + v.duration))
      } catch {
      }
    }
  }
  return { gain, sources: voices, nodes: [] }
}

function makeSplitBus(sources: CompSource[], when: number, pan: number): Bus {
  const c = ac()
  const mono = c.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'speakers'
  const panner = c.createStereoPanner()
  panner.pan.value = pan
  const gain = c.createGain()
  const s = scheduleComp(c, sources, mono, { when, seek: 0 })
  mono.connect(panner)
  panner.connect(gain)
  gain.connect(fx as GainNode)
  return { gain, sources: s.voices.map((v) => v.source), nodes: [mono, panner] }
}

function killBus(b: Bus): void {
  const c = ctx
  for (const s of b.sources) s.onended = null
  if (!c) return
  const now = c.currentTime
  try {
    b.gain.gain.cancelScheduledValues(now)
    b.gain.gain.setValueAtTime(b.gain.gain.value, now)
    b.gain.gain.linearRampToValueAtTime(0, now + FADE_OUT)
  } catch {
  }
  for (const s of b.sources) {
    try {
      s.stop(now + FADE_OUT)
    } catch {
    }
  }
  setTimeout(
    () => {
      for (const n of [...b.sources, ...b.nodes, b.gain]) {
        try {
          n.disconnect()
        } catch {
        }
      }
    },
    (FADE_OUT + 0.05) * 1000
  )
}

function killVoice(v: Voice): void {
  const c = ctx
  v.src.onended = null
  if (!c) return
  const now = c.currentTime
  try {
    v.g.gain.cancelScheduledValues(now)
    v.g.gain.setValueAtTime(v.g.gain.value, now)
    v.g.gain.linearRampToValueAtTime(0, now + FADE_OUT)
  } catch {
  }
  try {
    v.src.stop(now + FADE_OUT)
  } catch {
  }
  setTimeout(
    () => {
      try {
        v.src.disconnect()
      } catch {
      }
      try {
        v.g.disconnect()
      } catch {
      }
    },
    (FADE_OUT + 0.05) * 1000
  )
}

function resolveWaiters(): void {
  const w = waiters
  waiters = []
  for (const f of w) f()
}

function teardown(): void {
  stopTicking()
  if (voice) {
    killVoice(voice)
    voice = null
  }
  if (seq) {
    for (const it of seq) killVoice(it.voice)
    seq = null
    seqIndex = -1
  }
  if (split) {
    for (const b of split.buses) killBus(b)
    split = null
    mode = 'idle'
  }
  if (comp?.bus) {
    killBus(comp.bus)
    comp.bus = null
  }
  playing = false
  wantPlay = false
  resolveWaiters()
}

function dropComp(): void {
  if (!comp) return
  if (comp.bus) killBus(comp.bus)
  comp = null
}

function compPos(): number {
  if (!comp) return 0
  if (!playing || !comp.bus || !ctx) return pausedPos
  return Math.min(comp.dur, comp.startPos + Math.max(0, ctx.currentTime - comp.at))
}

function livePos(): number {
  if (!cur) return 0
  if (!playing || !ctx) return pausedPos
  const el = ctx.currentTime - startedAt
  if (loopB !== null && loopB > loopA) {
    const len = loopB - loopA
    const rel = startOffset - loopA + el
    return loopA + (((rel % len) + len) % len)
  }
  return Math.max(0, Math.min(cur.dur, startOffset + el))
}

function audible(): { id: string; pos: number; dur: number } | null {
  if (mode === 'comp' && comp) return { id: comp.id, pos: compPos(), dur: comp.dur }
  if (mode === 'split' && split) {
    const now = ctx ? ctx.currentTime : split.at
    return { id: split.id, pos: Math.max(0, Math.min(split.dur, now - split.at)), dur: split.dur }
  }
  if (mode === 'seq' && seq && seqIndex >= 0) {
    const it = seq[seqIndex]
    const now = ctx ? ctx.currentTime : it.at
    return { id: it.id, pos: Math.max(0, Math.min(it.dur, now - it.at)), dur: it.dur }
  }
  if (cur) return { id: cur.id, pos: livePos(), dur: cur.dur }
  return null
}

function halt(): void {
  const a = audible()
  const wasPlaying = playing || mode === 'seq'
  if (mode === 'seq') collapseSeq()
  teardown()
  if (a) {
    pausedPos = a.pos
    if (wasPlaying) emit({ clipId: a.id, playing: false, pos: a.pos, dur: a.dur })
  }
}

function collapseSeq(): boolean {
  if (mode !== 'seq' || !seq) return playing
  const i = Math.max(0, seqIndex)
  const it = seq[i]
  const now = ctx ? ctx.currentTime : it.at
  cur = { id: it.id, url: it.url, buf: buffers.peek(it.url) ?? null, dur: it.dur }
  pausedPos = Math.max(0, Math.min(it.dur, now - it.at))
  for (const s of seq) killVoice(s.voice)
  seq = null
  seqIndex = -1
  voice = null
  mode = 'clip'
  const was = playing
  playing = false
  pin([it.url])
  return was
}

export function load(clip: Clip): void {
  if (mode === 'clip' && cur && cur.id === clip.id && cur.url === clip.url) return
  halt()
  dropComp()
  const g = ++gen
  mode = 'clip'
  const cached = buffers.get(clip.url)
  cur = { id: clip.id, url: clip.url, buf: cached ?? null, dur: cached?.duration ?? 0 }
  pausedPos = 0
  pin([clip.url])
  emit({ clipId: cur.id, playing: false, pos: 0, dur: cur.dur })
  if (cached) return
  void getBuffer(clip.url).then(
    (b) => {
      if (g !== gen || !cur || cur.url !== clip.url) return
      cur.buf = b
      cur.dur = b.duration
      if (wantPlay) {
        wantPlay = false
        startClip(pausedPos, true)
      } else {
        emit({ clipId: cur.id, playing, pos: pausedPos, dur: cur.dur })
      }
    },
    () => {
      if (g !== gen) return
      wantPlay = false
      resolveWaiters()
    }
  )
}

function startClip(offset: number, rewindAtEnd: boolean): void {
  if (!cur?.buf) return
  const c = ac()
  void c.resume().catch(() => {})
  if (voice) {
    killVoice(voice)
    voice = null
  }
  const dur = cur.dur
  let off = Math.max(0, Math.min(dur, offset))
  if (rewindAtEnd && off >= dur - END_EPS) off = 0
  startOffset = off
  startedAt = c.currentTime
  const v = makeVoice(cur.buf, startedAt, off, true)
  if (loopB !== null && loopB > loopA) {
    v.src.loop = true
    v.src.loopStart = loopA
    v.src.loopEnd = loopB
  } else {
    v.src.onended = (): void => {
      if (voice !== v) return
      onClipEnded()
    }
  }
  voice = v
  playing = true
  pausedPos = off
  emit({ clipId: cur.id, playing: true, pos: off, dur })
  startTicking()
}

function onClipEnded(): void {
  const c = cur
  teardown()
  pausedPos = 0
  emit({ clipId: c?.id ?? null, playing: false, pos: 0, dur: c?.dur ?? 0 })
}

function startComp(pos: number, rewindAtEnd: boolean): void {
  const s = comp
  if (!s) return
  const c = ac()
  void c.resume().catch(() => {})
  if (s.bus) {
    killBus(s.bus)
    s.bus = null
  }
  let p = Math.max(0, Math.min(s.dur, pos))
  if (rewindAtEnd && p >= s.until - END_EPS) p = s.from
  const when = c.currentTime + LEAD_IN
  s.at = when
  s.startPos = p
  s.bus = makeCompBus(s.sources, when, p, p < s.until ? s.until : Infinity)
  playing = true
  pausedPos = p
  emit({ clipId: s.id, playing: true, pos: p, dur: s.dur })
  startTicking()
}

export async function loadCompSources(resolved: ResolvedComp): Promise<CompSource[]> {
  const out: CompSource[] = []
  for (const c of resolved.clips) {
    let buffer: AudioBuffer
    try {
      buffer = await getBuffer(c.url)
    } catch (e) {
      throw new Error(
        `Could not decode composition clip "${c.clip.id}": ${e instanceof Error ? e.message : String(e)}`
      )
    }
    out.push({ clip: c.clip, buffer })
  }
  return out
}

async function pitchReady(sources: CompSource[]): Promise<boolean> {
  if (!compHasPitch(sources.map((s) => s.clip))) return true
  try {
    await ensurePitchModule(ac())
  } catch (e) {
    console.error(e)
  }
  return true
}

function compUrls(resolved: ResolvedComp): string[] {
  return [...new Set(resolved.clips.map((c) => c.url))]
}

export async function playComp(
  resolved: ResolvedComp,
  opts: { id?: string; seek?: number } = {}
): Promise<void> {
  halt()
  dropComp()
  const g = ++gen
  if (resolved.clips.length === 0) return
  const urls = compUrls(resolved)
  pin(urls)
  let sources: CompSource[]
  try {
    sources = await loadCompSources(resolved)
  } catch (e) {
    console.error(e)
    return
  }
  if (g !== gen) return
  if (!(await pitchReady(sources))) return
  if (g !== gen) return

  const dur = compDuration({ clips: sources.map((s) => s.clip) })
  if (!(dur > 0)) return

  const r = resolved.region
  const from = r ? Math.min(Math.max(0, r.in), dur) : 0
  const until = r
    ? Math.min(Math.max(from, r.out), dur)
    : dur + compEffectsTail(sources.map((s) => s.clip))

  mode = 'comp'
  cur = null
  comp = {
    id: opts.id ?? 'comp:' + urls[0],
    sources,
    dur,
    from,
    until,
    at: 0,
    startPos: 0,
    bus: null,
  }
  const p = new Promise<void>((res) => waiters.push(res))
  startComp(opts.seek ?? from, true)
  return p
}

export function playRange(clip: Clip, from: number, to: number): Promise<void> {
  const a = Math.max(0, from)
  if (!(to > a)) return Promise.resolve()
  return playComp(
    {
      clips: [
        {
          clip: { id: 'range', sourceTakeId: '', srcIn: a, srcOut: to, start: a, edits: emptyEdits() },
          url: clip.url,
        },
      ],
    },
    { id: clip.id, seek: a }
  )
}

export async function playSplit(left: SplitSide, right: SplitSide): Promise<void> {
  halt()
  dropComp()
  const g = ++gen
  const sides = [left, right]
  const urls = [...new Set(sides.flatMap(sideUrls))]
  pin(urls)
  let prepared: CompSource[][]
  try {
    prepared = await Promise.all(sides.map(prepSide))
  } catch {
    return
  }
  if (g !== gen) return
  if (!(await pitchReady(prepared.flat()))) return
  if (g !== gen) return

  const c = ac()
  void c.resume().catch(() => {})
  const when = c.currentTime + LEAD_IN
  const buses = [makeSplitBus(prepared[0], when, -1), makeSplitBus(prepared[1], when, 1)]
  const durs = prepared.map((s) => {
    const clips = s.map((x) => x.clip)
    return compDuration({ clips }) + compEffectsTail(clips)
  })
  const longer = durs[0] >= durs[1] ? 0 : 1
  const id = sides[longer].id ?? 'split:' + (sideUrls(sides[longer])[0] ?? longer)

  mode = 'split'
  split = { id, at: when, dur: durs[longer], buses }
  cur = null
  playing = true
  const p = new Promise<void>((res) => waiters.push(res))
  emit({ clipId: id, playing: true, pos: 0, dur: split.dur })
  startTicking()
  return p
}

function sideUrls(side: SplitSide): string[] {
  return 'comp' in side ? side.comp.clips.map((c) => c.url) : [side.url]
}

async function prepSide(side: SplitSide): Promise<CompSource[]> {
  if ('comp' in side) return loadCompSources(side.comp)
  const buffer = await getBuffer(side.url)
  return [
    {
      clip: {
        id: 'ab',
        sourceTakeId: '',
        srcIn: 0,
        srcOut: buffer.duration,
        start: 0,
        edits: emptyEdits(),
      },
      buffer,
    },
  ]
}

export function play(): void {
  if (mode === 'split') {
    halt()
    return
  }
  if (mode === 'comp' && comp) {
    if (playing && comp.bus) return
    startComp(pausedPos, true)
    return
  }
  const wasPlaying = mode === 'seq' ? collapseSeq() : playing
  if (!cur) return
  if (wasPlaying && mode === 'clip' && voice) return
  if (cur.buf) startClip(pausedPos, true)
  else wantPlay = true
}

export function playClip(clip: Clip, offset = 0): Promise<void> {
  halt()
  load(clip)
  const p = new Promise<void>((res) => waiters.push(res))
  if (cur?.buf) {
    startClip(offset, true)
  } else {
    pausedPos = Math.max(0, offset)
    wantPlay = true
  }
  return p
}

export function pause(): void {
  wantPlay = false
  if (!playing && mode !== 'seq') {
    resolveWaiters()
    return
  }
  halt()
}

export function toggle(): void {
  if (playing) pause()
  else play()
}

export function stop(): void {
  const a = audible()
  if (mode === 'seq') collapseSeq()
  teardown()
  pausedPos = 0
  if (a || cur) emit({ clipId: a?.id ?? cur?.id ?? null, playing: false, pos: 0, dur: a?.dur ?? cur?.dur ?? 0 })
}

export function seek(t: number): void {
  if (mode === 'split') halt()
  if (mode === 'comp' && comp) {
    const was = playing && !!comp.bus
    const p = Math.max(0, Math.min(comp.dur, t))
    pausedPos = p
    lastScrubAt = performance.now()
    if (was) startComp(p, false)
    else emit({ clipId: comp.id, playing: false, pos: p, dur: comp.dur })
    return
  }
  const wasPlaying = mode === 'seq' ? collapseSeq() : playing
  if (!cur) return
  const p = Math.max(0, cur.dur > 0 ? Math.min(cur.dur, t) : t)
  pausedPos = p
  lastScrubAt = performance.now()
  if (wasPlaying && cur.buf) startClip(p, false)
  else emit({ clipId: cur.id, playing: false, pos: p, dur: cur.dur })
}

export function scrubTo(t: number): void {
  if (mode === 'split') halt()
  if (mode === 'comp' && comp) {
    const p = Math.max(0, Math.min(comp.dur, t))
    pausedPos = p
    if (!playing || !comp.bus) {
      emit({ clipId: comp.id, playing: false, pos: p, dur: comp.dur })
      return
    }
    const now = performance.now()
    if (now - lastScrubAt < SCRUB_SEEK_MS) return
    lastScrubAt = now
    startComp(p, false)
    return
  }
  const wasPlaying = mode === 'seq' ? collapseSeq() : playing
  if (!cur) return
  const p = Math.max(0, cur.dur > 0 ? Math.min(cur.dur, t) : t)
  pausedPos = p
  if (!wasPlaying || !cur.buf) {
    emit({ clipId: cur.id, playing: false, pos: p, dur: cur.dur })
    return
  }
  const now = performance.now()
  if (now - lastScrubAt < SCRUB_SEEK_MS) return
  lastScrubAt = now
  startClip(p, false)
}

export function setLoop(a: number, b: number | null): void {
  if (mode === 'comp') return
  loopA = Math.max(0, a)
  loopB = b
  if (!voice) return
  if (b !== null && b > loopA) {
    voice.src.loop = true
    voice.src.loopStart = loopA
    voice.src.loopEnd = b
  } else {
    voice.src.loop = false
  }
}

export async function playSequence(items: SequenceItem[]): Promise<void> {
  halt()
  dropComp()
  const g = ++gen
  if (items.length === 0) return
  const urls = items.map((i) => i.url)
  pin(urls)
  let bufs: AudioBuffer[]
  try {
    bufs = await Promise.all(urls.map((u) => getBuffer(u)))
  } catch {
    return
  }
  if (g !== gen) return

  const c = ac()
  void c.resume().catch(() => {})
  let at = c.currentTime + LEAD_IN
  const built: SeqItem[] = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) at += (items[i].gapMs ?? 0) / 1000
    const b = bufs[i]
    built.push({
      id: items[i].id ?? 'seq:' + urls[i],
      url: urls[i],
      at,
      dur: b.duration,
      voice: makeVoice(b, at, 0, false),
    })
    at += b.duration
  }

  mode = 'seq'
  seq = built
  seqIndex = 0
  cur = null
  playing = true
  const p = new Promise<void>((res) => waiters.push(res))
  emit({ clipId: built[0].id, playing: true, pos: 0, dur: built[0].dur })
  startTicking()
  return p
}

function startTicking(): void {
  if (raf) return
  raf = requestAnimationFrame(tick)
}

function stopTicking(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function tick(): void {
  raf = 0
  if (!playing || !ctx) return
  const now = ctx.currentTime

  if (mode === 'comp' && comp) {
    const s = comp
    const stopAt = s.startPos < s.until ? s.until : s.dur
    if (now >= s.at + (stopAt - s.startPos)) {
      teardown()
      pausedPos = stopAt >= s.dur ? s.from : stopAt
      emit({ clipId: s.id, playing: false, pos: pausedPos, dur: s.dur })
      return
    }
    emit({ clipId: s.id, playing: true, pos: compPos(), dur: s.dur })
  } else if (mode === 'split' && split) {
    const s = split
    if (now >= s.at + s.dur) {
      teardown()
      emit({ clipId: s.id, playing: false, pos: 0, dur: s.dur })
      return
    }
    emit({
      clipId: s.id,
      playing: true,
      pos: Math.max(0, Math.min(s.dur, now - s.at)),
      dur: s.dur,
    })
  } else if (mode === 'seq' && seq) {
    let i = seqIndex
    while (i + 1 < seq.length && now >= seq[i].at + seq[i].dur) i++
    if (i !== seqIndex) {
      const prev = seq[seqIndex]
      emit({ clipId: prev.id, playing: false, pos: 0, dur: prev.dur })
      seqIndex = i
    }
    const it = seq[i]
    if (now >= it.at + it.dur) {
      teardown()
      mode = 'idle'
      emit({ clipId: it.id, playing: false, pos: 0, dur: it.dur })
      return
    }
    emit({
      clipId: it.id,
      playing: true,
      pos: Math.max(0, Math.min(it.dur, now - it.at)),
      dur: it.dur,
    })
  } else if (cur) {
    emit({ clipId: cur.id, playing: true, pos: livePos(), dur: cur.dur })
  }

  raf = requestAnimationFrame(tick)
}

export const transport = {
  load,
  play,
  playClip,
  pause,
  toggle,
  stop,
  seek,
  scrubTo,
  setLoop,
  playSequence,
  playSplit,
  playComp,
  playRange,
  subscribe,
  getState,
  currentClipId,
  isAB,
  sourceLabel,
  getBuffer,
  release,
}
