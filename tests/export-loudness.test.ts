import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'
import {
  LOUDNESS_MODES,
  loudnessMode,
  loudnessTarget,
  lufsTarget,
  parseEbur128,
  parseSamplePeak,
  peakTarget,
  sanitizeExportSettings,
  targetGainDb,
  type ExportSettings,
  type LoudnessMeasure,
} from '../src/shared/export-settings'
import { isFastPath } from '../src/shared/export-plan'
import { applyProjectCommand } from '../src/shared/project-commands'
import { exportSettingsSchema, projectCommandSchema, projectFileSchema } from '../src/main/schemas'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const store = await import('../src/main/project-store')
const { encodeJob, planBatchExport } = await import('../src/main/export')
const { ffmpegStderr, runFfmpeg } = await import('../src/main/ffmpeg')

function take(id: string, relPath: string): Take {
  return {
    id,
    kind: 'tts',
    createdAt: 'now',
    file: { fileId: id, relPath, format: 'wav' },
    duration: 3,
    meta: {},
    edits: emptyEdits(),
  }
}

function project(settings: ExportSettings | undefined, relPath = '/tmp/none.wav'): Project {
  const t = take('t1', relPath)
  const cue: Cue = {
    id: 'c1',
    characterId: '',
    key: 'k1',
    fields: {},
    sourceText: '',
    text: 'line',
    status: 'generated',
    notes: '',
    referenceAudio: { fileId: 'r1', relPath: '/tmp/ref.wav', format: 'wav' },
    takes: [t],
    finalTakeId: t.id,
    output: { kind: 'take', takeId: t.id, revision: 1 },
  }
  return {
    id: 'p',
    schemaVersion: 1,
    createdAt: 'now',
    name: 'P',
    media: { referenceDir: '', referencePattern: '' },
    characters: [],
    cues: [cue],
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '{Key}.{ext}',
    ui: { filter: '', search: '' },
    ...(settings ? { export: settings } : {}),
  }
}

const stored = (p: Project): string => {
  const { ui: _ui, ...rest } = p
  return JSON.stringify(rest, null, 2)
}

describe('loudness targets in the model', () => {
  it('old settings sanitize to exactly themselves', () => {
    for (const old of [{ loudness: 'match' }, { loudness: 'off' }, { format: 'mp3-192', length: 'pad' }]) {
      expect(sanitizeExportSettings(old)).toEqual(old)
      expect(exportSettingsSchema.parse(old)).toEqual(old)
    }
  })

  it('an old project with export settings stays byte-identical through load and setExport', () => {
    const p = project({ outDir: 'D:/out', format: 'wav-48-24', loudness: 'match', length: 'pad' })
    const before = stored(p)
    expect(projectFileSchema.parse(JSON.parse(before))).toEqual(JSON.parse(before))
    applyProjectCommand(
      p,
      projectCommandSchema.parse({ type: 'project.setExport', settings: p.export }) as never
    )
    expect(stored(p)).toBe(before)
    expect(p.export).not.toHaveProperty('lufsTarget')
    expect(p.export).not.toHaveProperty('peakTarget')
  })

  it('absent targets mean −16 LUFS and −1 dBFS', () => {
    expect(lufsTarget(undefined)).toBe(-16)
    expect(peakTarget(undefined)).toBe(-1)
    expect(loudnessTarget(undefined)).toBeUndefined()
    expect(loudnessTarget({ loudness: 'match' })).toBeUndefined()
    expect(loudnessTarget({ loudness: 'off', lufsTarget: -20 })).toBeUndefined()
    expect(loudnessTarget({ loudness: 'lufs' })).toEqual({ mode: 'lufs', db: -16 })
    expect(loudnessTarget({ loudness: 'lufs', lufsTarget: -23 })).toEqual({ mode: 'lufs', db: -23 })
    expect(loudnessTarget({ loudness: 'peak' })).toEqual({ mode: 'peak', db: -1 })
    expect(loudnessTarget({ loudness: 'peak', peakTarget: -3 })).toEqual({ mode: 'peak', db: -3 })
  })

  it('sanitize snaps targets to their step and clamps them to range', () => {
    expect(sanitizeExportSettings({ loudness: 'lufs', lufsTarget: -14.4 })).toEqual({
      loudness: 'lufs',
      lufsTarget: -14,
    })
    expect(sanitizeExportSettings({ loudness: 'peak', peakTarget: -0.34 })).toEqual({
      loudness: 'peak',
      peakTarget: -0.3,
    })
    expect(sanitizeExportSettings({ lufsTarget: -50 })).toEqual({ lufsTarget: -35 })
    expect(sanitizeExportSettings({ lufsTarget: -2 })).toEqual({ lufsTarget: -10 })
    expect(sanitizeExportSettings({ peakTarget: 3 })).toEqual({ peakTarget: 0 })
    expect(sanitizeExportSettings({ peakTarget: -40 })).toEqual({ peakTarget: -12 })
    expect(sanitizeExportSettings({ lufsTarget: '-14', peakTarget: NaN })).toBeUndefined()
    expect(sanitizeExportSettings({ lufsTarget: Infinity, loudness: 'loud' })).toBeUndefined()
  })

  it('targets survive a mode switch so returning restores them', () => {
    expect(sanitizeExportSettings({ loudness: 'off', lufsTarget: -20, peakTarget: -2 })).toEqual({
      loudness: 'off',
      lufsTarget: -20,
      peakTarget: -2,
    })
  })

  it('the zod mirror keeps every mode and both targets and rejects out-of-range ones', () => {
    for (const m of LOUDNESS_MODES) {
      expect(exportSettingsSchema.parse({ loudness: m.id })).toEqual({ loudness: m.id })
    }
    const full = { loudness: 'lufs', lufsTarget: -23, peakTarget: -0.5 }
    expect(exportSettingsSchema.parse(full)).toEqual(full)
    expect(() => exportSettingsSchema.parse({ loudness: 'loud' })).toThrow()
    expect(() => exportSettingsSchema.parse({ lufsTarget: -36 })).toThrow()
    expect(() => exportSettingsSchema.parse({ peakTarget: 0.5 })).toThrow()
  })

  it('setExport roundtrips the new fields through save and load', () => {
    const p = project(undefined)
    applyProjectCommand(
      p,
      projectCommandSchema.parse({
        type: 'project.setExport',
        settings: { loudness: 'peak', lufsTarget: -18.2, peakTarget: -3 },
      }) as never
    )
    expect(p.export).toEqual({ loudness: 'peak', lufsTarget: -18, peakTarget: -3 })
    const reloaded = projectFileSchema.parse(JSON.parse(stored(p))) as Project
    expect(sanitizeExportSettings(reloaded.export)).toEqual(p.export)
    expect(loudnessMode(reloaded.export)).toBe('peak')
  })
})

describe('sample peak and target gain', () => {
  const log = [
    '[Parsed_ebur128_0] t: 2.9   TARGET:-23 LUFS    M: -51.8 S: -51.8     I: -51.8 LUFS       LRA:  18.2 LU  SPK: -48.1 dBFS',
    '[Parsed_ebur128_0] Summary:',
    '  Integrated loudness:',
    '    I:         -30.2 LUFS',
    '    Threshold: -40.2 LUFS',
    '  Sample peak:',
    '    Peak:      -26.4 dBFS',
  ].join('\n')

  it('reads the summary sample peak and ignores per-frame SPK values', () => {
    expect(parseSamplePeak(log)).toBe(-26.4)
    expect(parseEbur128(log)).toBe(-30.2)
    expect(parseSamplePeak('Peak:       -inf dBFS')).toBeNull()
    expect(parseSamplePeak('I: -20.0 LUFS')).toBeNull()
  })

  it('lufs mode moves integrated loudness onto the target', () => {
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -30, peak: -27 })).toBe(14)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -12, peak: -9 })).toBe(-4)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -20.333, peak: -18 })).toBe(4.33)
  })

  it('lufs mode never lifts the sample peak above −1 dBFS', () => {
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -30, peak: -10 })).toBe(9)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -20, peak: -0.5 })).toBe(-0.5)
  })

  it('peak mode moves the sample peak onto the target', () => {
    expect(targetGainDb({ mode: 'peak', db: -1 }, { lufs: -30, peak: -6 })).toBe(5)
    expect(targetGainDb({ mode: 'peak', db: -1 }, { lufs: null, peak: 2 })).toBe(-3)
    expect(targetGainDb({ mode: 'peak', db: -3 }, { lufs: -3, peak: -0.5 })).toBe(-2.5)
  })

  it('silent or unmeasurable renders get no gain', () => {
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -70, peak: -60 })).toBe(0)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: null, peak: -20 })).toBe(0)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -30, peak: null })).toBe(0)
    expect(targetGainDb({ mode: 'peak', db: -1 }, { lufs: -70, peak: null })).toBe(0)
    expect(targetGainDb({ mode: 'peak', db: -1 }, { lufs: null, peak: -Infinity })).toBe(0)
  })

  it('gain is clamped to ±30 dB after the peak ceiling', () => {
    expect(targetGainDb({ mode: 'lufs', db: -10 }, { lufs: -65, peak: -80 })).toBe(30)
    expect(targetGainDb({ mode: 'peak', db: 0 }, { lufs: -69, peak: -60 })).toBe(30)
    expect(targetGainDb({ mode: 'peak', db: -12 }, { lufs: -1, peak: 25 })).toBe(-30)
    expect(targetGainDb({ mode: 'lufs', db: -35 }, { lufs: -2, peak: 35 })).toBe(-30)
  })

  it('every non-off mode skips the byte-copy fast path', () => {
    const wav = take('t', 'E:/p/t.wav')
    expect(isFastPath(wav, 'a.wav', undefined, { loudness: 'off' })).toBe(true)
    expect(isFastPath(wav, 'a.wav', undefined, undefined)).toBe(true)
    expect(isFastPath(wav, 'a.wav', undefined, { loudness: 'match' })).toBe(false)
    expect(isFastPath(wav, 'a.wav', undefined, { loudness: 'lufs' })).toBe(false)
    expect(isFastPath(wav, 'a.wav', undefined, { loudness: 'peak' })).toBe(false)
  })
})

describe('export applies the loudness target with ffmpeg', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vostudio-loudness-'))
  afterAll(async () => {
    store.closeProject()
    await fs.rm(root, { recursive: true, force: true })
  })

  const measure = async (file: string): Promise<LoudnessMeasure> => {
    const log = await ffmpegStderr(['-i', file, '-af', 'ebur128=peak=sample', '-f', 'null', '-'])
    return { lufs: parseEbur128(log), peak: parseSamplePeak(log) }
  }

  const QUIET_TONE = 'sine=frequency=440:duration=3,volume=-8.2dB'
  const QUIET_TONE_WITH_CLICK = 'aevalsrc=0.02*sin(2*PI*440*t)+0.5*between(t\\,1\\,1.0005):d=3'

  const exportSignal = async (
    signal: string,
    settings: ExportSettings
  ): Promise<{ input: LoudnessMeasure; output: LoudnessMeasure }> => {
    const src = path.join(root, 'signal.wav')
    await runFfmpeg(['-f', 'lavfi', '-i', signal, '-c:a', 'pcm_f32le', src])
    const dir = path.join(root, 'P.vostudio')
    await fs.mkdir(dir, { recursive: true })
    store.adoptProject(project(settings, src), dir)
    const plan = await planBatchExport({ cueIds: ['c1'] })
    expect(plan.jobs).toHaveLength(1)
    const job = plan.jobs[0]
    expect(job.fastPath).toBe(false)
    expect(job.matchLoudnessRef).toBeUndefined()
    expect(job.loudnessTarget).toEqual(loudnessTarget(settings))
    await encodeJob(job.outPath, await fs.readFile(src))
    return { input: await measure(src), output: await measure(job.outPath) }
  }

  const near = (value: number | null, expected: number, tolerance: number): void => {
    expect(value).not.toBeNull()
    expect(Math.abs((value as number) - expected)).toBeLessThanOrEqual(tolerance)
  }

  it('a −30 LUFS tone exported at Target LUFS −16 measures −16', async () => {
    const { input, output } = await exportSignal(QUIET_TONE, { loudness: 'lufs' })
    near(input.lufs, -30, 0.5)
    near(output.lufs, -16, 0.5)
    expect(output.peak).toBeLessThanOrEqual(-1)
  })

  it('the same tone exported at Peak −1 peaks at −1 dBFS', async () => {
    const { output } = await exportSignal(QUIET_TONE, { loudness: 'peak', peakTarget: -1 })
    near(output.peak, -1, 0.2)
  })

  it('Target LUFS stops at a −1 dBFS sample peak instead of reaching the target', async () => {
    const { input, output } = await exportSignal(QUIET_TONE_WITH_CLICK, { loudness: 'lufs' })
    expect(input.peak).toBeGreaterThan(-8)
    near(output.peak, -1, 0.2)
    expect(output.lufs).toBeLessThan(-25)
  })
})

describe('lossy headroom', () => {
  it('keeps 1 dB of headroom below peak targets and the LUFS ceiling for lossy formats', () => {
    expect(targetGainDb({ mode: 'peak', db: -1 }, { lufs: -30, peak: -10 }, true)).toBeCloseTo(8)
    expect(targetGainDb({ mode: 'peak', db: -1 }, { lufs: -30, peak: -10 })).toBeCloseTo(9)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -30, peak: -3 }, true)).toBeCloseTo(1)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -30, peak: -3 })).toBeCloseTo(2)
    expect(targetGainDb({ mode: 'lufs', db: -16 }, { lufs: -30, peak: -20 }, true)).toBeCloseTo(14)
  })
})
