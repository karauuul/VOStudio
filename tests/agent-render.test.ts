import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { emptyEdits, serialQueue, type Cue, type Project, type Take } from '../src/shared/domain'
import { MAX_TIMER_MS, PLAN_JOB_TIMEOUT_MS, PLAN_TIMEOUT_MS, planTimeoutMs, renderFileName, transcriptMatch } from '../src/shared/agent-render'
import { edgeSilence, loudnessFilter, METRICS_FILTER, parseMetrics, silenceFilter } from '../src/shared/audio-metrics'
import { originalOnlyPlan, planBatch, planLine } from '../src/shared/export-plan'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const store = await import('../src/main/project-store')
const { encodeAnalysis, exportBusy, finishExport, lineJob, measureAudio, planBatchExport, releaseExports } = await import('../src/main/export')
const { ffmpegInfo, runFfmpeg } = await import('../src/main/ffmpeg')

function take(id: string, relPath: string): Take {
  return { id, kind: 'tts', createdAt: 'now', file: { fileId: id, relPath, format: 'wav' }, duration: 1, meta: {}, edits: emptyEdits() }
}

function cue(key: string, relPath?: string): Cue {
  const t = relPath ? take(`t-${key}`, relPath) : undefined
  return {
    id: `c-${key}`,
    characterId: '',
    key,
    fields: {},
    sourceText: 'orig',
    text: 'line',
    status: t ? 'generated' : 'translated',
    notes: '',
    takes: t ? [t] : [],
    ...(t ? { finalTakeId: t.id, output: { kind: 'take' as const, takeId: t.id, revision: 1 } } : {}),
  }
}

function project(cues: Cue[], settings?: Project['export']): Project {
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', media: { referenceDir: '', referencePattern: '' },
    characters: [], cues, sessions: [], pronunciationRules: '', exportTemplate: '{Key}.{ext}',
    ui: { filter: '', search: '' }, ...(settings ? { export: settings } : {}),
  }
}

describe('transcript match', () => {
  it('ignores case and punctuation and names missing and extra words', () => {
    expect(transcriptMatch('Hello, there General!', 'hello there general')).toEqual({ similarity: 1, missing: [], extra: [] })
    expect(transcriptMatch('One two three four', 'one three four five')).toEqual({ similarity: 0.75, missing: ['two'], extra: ['five'] })
    expect(transcriptMatch('Привіт, світе', 'привіт')).toEqual({ similarity: 0.667, missing: ['світе'], extra: [] })
    expect(transcriptMatch('', '')).toEqual({ similarity: 1, missing: [], extra: [] })
    expect(transcriptMatch('word', '')).toEqual({ similarity: 0, missing: ['word'], extra: [] })
  })
})

describe('render file names', () => {
  it('keeps keys readable, tags the cue id and never escapes the renders folder', () => {
    expect(renderFileName('Line 1', 'c-Line 1')).toBe('Line 1-c-Line_1.wav')
    expect(renderFileName('vo/a:b', '3fa85f64-5717', '.original')).toBe('vo_a_b-3fa85f64.original.wav')
    expect(renderFileName('../..', '../../x')).toBe('.._-______x.wav')
    expect(renderFileName('..', 'abc')).toBe('line-abc.wav')
    expect(renderFileName('x'.repeat(300), 'id')).toBe(`${'x'.repeat(120)}-id.wav`)
  })

  it('gives distinct files to lines whose keys collide', () => {
    const names = [
      renderFileName('dup', '11111111-a'),
      renderFileName('dup', '22222222-a'),
      renderFileName('a/b', '33333333'),
      renderFileName('a:b', '44444444'),
      renderFileName(`${'k'.repeat(300)}1`, '55555555'),
      renderFileName(`${'k'.repeat(300)}2`, '66666666'),
    ]
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('export plan deadline', () => {
  it('grows per job but never exceeds the largest timer Node honours', () => {
    expect(planTimeoutMs(0)).toBe(PLAN_TIMEOUT_MS)
    expect(planTimeoutMs(1)).toBe(PLAN_TIMEOUT_MS + PLAN_JOB_TIMEOUT_MS)
    expect(planTimeoutMs(35_790)).toBeLessThan(MAX_TIMER_MS)
    expect(planTimeoutMs(35_791)).toBe(MAX_TIMER_MS)
    expect(planTimeoutMs(1_000_000)).toBe(MAX_TIMER_MS)
  })
})

describe('serial queue', () => {
  it('starts the next task only after the previous one settles, even when it fails', async () => {
    const serial = serialQueue()
    const log: string[] = []
    let failFirst!: (error: Error) => void
    const first = serial(() => {
      log.push('first')
      return new Promise<string>((_, reject) => {
        failFirst = reject
      })
    })
    const second = serial(async () => {
      log.push('second')
      return 'done'
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['first'])
    failFirst(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('done')
    expect(log).toEqual(['first', 'second'])
  })
})

describe('single line planning', () => {
  it('plans one line exactly as the batch plans it', () => {
    const excluded = { ...cue('ex', '/a/ex.wav'), status: 'excluded' as const }
    const p = project([cue('a', '/a/a.wav'), cue('b'), excluded])
    expect(p.cues.map((c) => planLine(p, c))).toEqual([planBatch(p)[0], undefined, undefined])
    expect(planBatch(p).map((x) => x.name)).toEqual(['a.wav'])
  })

  it('an original-only plan mixes just the original at unity gain', () => {
    const c = { ...cue('o'), referenceAudio: { fileId: 'r', relPath: '/a/ref.wav', format: 'wav' as const }, referenceDuration: 1.5 }
    expect(originalOnlyPlan(c, undefined)).toEqual({ clips: [], originals: [{ srcPath: '/a/ref.wav', offset: 0, duration: 1.5, gainDb: 0 }] })
    expect(originalOnlyPlan(cue('none'), undefined)).toBeUndefined()
    const region = { ...cue('r'), region: { sourceId: 's', in: 2, out: 3.5 } }
    const sources = [{ id: 's', name: 'v.mp4', kind: 'video' as const, file: { fileId: 's', relPath: '/a/s.wav', format: 'wav' as const }, duration: 10 }]
    expect(originalOnlyPlan(region, sources)?.originals).toEqual([{ srcPath: '/a/s.wav', offset: 2, duration: 1.5, gainDb: 0 }])
  })
})

describe('audio metrics parsing', () => {
  const stderr = [
    '  Duration: 00:00:01.80, bitrate: 1536 kb/s',
    '  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, mono, flt, 1536 kb/s',
    '[silencedetect @ 0x1] silence_start: 0',
    '[silencedetect @ 0x1] silence_end: 0.300042 | silence_duration: 0.300042',
    '[silencedetect @ 0x1] silence_start: 1.3',
    '[Parsed_ebur128_0 @ 0x2] t: 1.7 TARGET:-23 LUFS M: -30.0 S: -40.0 I: -25.0 LUFS LRA: 0.0 LU SPK: -18.1 dBFS TPK: -17.9 dBFS',
    '[Parsed_ebur128_0 @ 0x2] Summary:',
    '  Integrated loudness:',
    '    I:         -22.9 LUFS',
    '    Threshold: -33.3 LUFS',
    '  Sample peak:',
    '    Peak:      -18.1 dBFS',
    '  True peak:',
    '    Peak:      -17.9 dBFS',
    '[silencedetect @ 0x1] silence_end: 1.8 | silence_duration: 0.5',
    '[Parsed_astats_1 @ 0x3] Overall',
    '[Parsed_astats_1 @ 0x3] Peak level dB: -18.061800',
    '[Parsed_astats_1 @ 0x3] RMS level dB: -23.667755',
    '[Parsed_astats_1 @ 0x3] Number of samples: 86400',
  ].join('\n')

  it('reads loudness, peaks, RMS, edge silence and the exact duration', () => {
    expect(parseMetrics(stderr, { duration: 1.8, sampleRate: 48000 })).toEqual({
      duration: 1.8,
      lufs: -22.9,
      truePeakDb: -17.9,
      samplePeakDb: -18.06,
      rmsDb: -23.67,
      leadingSilence: 0.3,
      trailingSilence: 0.5,
      clipped: false,
    })
  })

  it('flags full-scale peaks and keeps silent audio null instead of -inf', () => {
    const loud = parseMetrics('[Parsed_astats_1 @ 0x3] Peak level dB: 0.000000\n[Parsed_astats_1 @ 0x3] Number of samples: 441', { sampleRate: 44100 })
    expect(loud).toMatchObject({ clipped: true, samplePeakDb: 0, duration: 0.01 })
    const silent = parseMetrics('    Peak:      -inf dBFS\n[Parsed_astats_1 @ 0x3] Peak level dB: -inf\nRMS level dB: -inf', { duration: 2 })
    expect(silent).toMatchObject({ samplePeakDb: null, truePeakDb: null, rmsDb: null, lufs: null, clipped: false, duration: 2 })
  })

  it('edge silence needs a span touching each edge', () => {
    expect(edgeSilence([], 2)).toEqual({ leading: 0, trailing: 0 })
    expect(edgeSilence([{ start: 0.5, end: 0.9 }], 2)).toEqual({ leading: 0, trailing: 0 })
    expect(edgeSilence([{ start: 0, end: 2 }], 2)).toEqual({ leading: 2, trailing: 2 })
    expect(edgeSilence([{ start: 0.01, end: 0.2 }, { start: 1.7, end: 1.99 }], 2)).toEqual({ leading: 0.2, trailing: 0.3 })
  })

  it('export and detection keep their exact filter strings', () => {
    expect(loudnessFilter()).toBe('ebur128=peak=sample,astats=measure_perchannel=none')
    expect(loudnessFilter(48000)).toBe('aresample=48000,ebur128=peak=sample,astats=measure_perchannel=none')
    expect(silenceFilter(-35, 0.6)).toBe('silencedetect=noise=-35dB:d=0.6')
    expect(METRICS_FILTER).toBe('ebur128=peak=sample+true,astats=measure_perchannel=none,silencedetect=noise=-50dB:d=0.05')
  })
})

describe('analysis renders and export state in main', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vostudio-agent-render-'))
  afterAll(async () => {
    store.closeProject()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('encodes a rendered WAV as float with the export loudness and measures it', async () => {
    const rendered = path.join(root, 'rendered.wav')
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.3',
      '-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.5',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'pcm_f32le', rendered,
    ])
    const p = project([cue('a', rendered)], { format: 'wav-44-16', loudness: 'peak', peakTarget: -3 })
    const out = path.join(root, 'agent', 'renders', 'a.wav')
    const job = lineJob(p, p.cues[0], out, 'output')
    expect(job).toMatchObject({ outPath: out, name: 'a.wav', sampleRate: 44100, loudnessTarget: { mode: 'peak', db: -3 } })
    await fs.mkdir(path.dirname(out), { recursive: true })
    await encodeAnalysis(job!, await fs.readFile(rendered))
    expect(await ffmpegInfo(out)).toMatch(/pcm_f32le.*44100 Hz/)
    const m = await measureAudio(out)
    expect(m.duration).toBeCloseTo(1.8, 2)
    expect(m.samplePeakDb).toBeCloseTo(-3, 1)
    expect(m.leadingSilence).toBeCloseTo(0.3, 1)
    expect(m.trailingSilence).toBeCloseTo(0.5, 1)
    expect(m.lufs).toBeLessThan(-3)
    expect(m.clipped).toBe(false)
    expect(lineJob(p, p.cues[0], out, 'original')).toBeNull()
  })

  it('a batch running for one window refuses plans from another until it finishes or is released', async () => {
    const p = project([cue('a', '/tmp/a.wav'), cue('b')])
    store.adoptProject(p, path.join(root, 'B.vostudio'))
    const empty = await planBatchExport({ cueIds: ['c-b'] }, 1)
    expect(empty.jobs).toEqual([])
    expect(exportBusy()).toBe(false)
    const plan = await planBatchExport({ cueIds: ['c-a'] }, 7)
    expect(exportBusy()).toBe(true)
    await expect(planBatchExport({ cueIds: ['c-a'] }, 1)).rejects.toThrow('Another export is running')
    const replaced = await planBatchExport({ cueIds: ['c-a'] }, 7)
    expect(replaced.token).not.toBe(plan.token)
    releaseExports(1)
    releaseExports(7, plan.token)
    expect(exportBusy()).toBe(true)
    releaseExports(7)
    expect(exportBusy()).toBe(false)
    const again = await planBatchExport({ cueIds: ['c-a'] }, 7)
    await expect(finishExport(again.token, { exported: [], failed: [] }, async () => { throw new Error('stamp failed') })).rejects.toThrow('stamp failed')
    expect(exportBusy()).toBe(false)
    expect(plan.token).not.toBe(again.token)
  })
})
