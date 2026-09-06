import { describe, expect, it } from 'vitest'
import {
  emptyEdits,
  sanitizeProjectSources,
  sourceLabel,
  type Cue,
  type Project,
  type ProjectSource,
  type Take,
} from '../src/shared/domain'
import {
  dropShort,
  groupByScene,
  mergeClose,
  mergeRegionCues,
  parseSilence,
  regionCues,
  regionTimecode,
  regionsBetween,
  renderChunks,
  sourceSegments,
  transcriptRegions,
  videoTimelinePlan,
} from '../src/shared/sources'
import {
  compPlanFor,
  mixesOriginal,
  originalLength,
  originalRef,
} from '../src/shared/export-plan'
import {
  DEFAULT_VIDEO_NAME,
  sanitizeExportSettings,
  videoMode,
  videoName,
} from '../src/shared/export-settings'
import { applyChangeSet } from '../src/shared/project-commands'
import { subtitleAt } from '../src/shared/subtitles'
import { exportSettingsSchema, projectFileSchema } from '../src/main/schemas'
import { parseProbe } from '../src/main/ffmpeg'

const source = (over: Partial<ProjectSource> = {}): ProjectSource => ({
  id: 's1',
  name: 'interview_cut_v3.mp4',
  kind: 'video',
  file: { fileId: 's1', relPath: 'E:/p/audio/sources/s1.wav', format: 'wav', channels: 1 },
  duration: 760,
  media: 'E:/p/media/interview_cut_v3.mp4',
  width: 1920,
  height: 1080,
  channels: 2,
  ...over,
})

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: id, relPath: `E:/p/${id}.wav`, format: 'wav' },
  duration: 3,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const cue = (id: string, over: Partial<Cue> = {}): Cue =>
  ({
    id,
    characterId: 'ada',
    key: id,
    fields: {},
    sourceText: 'Welcome to the facility. Please remain calm.',
    text: 'Вітаємо.',
    status: 'empty',
    notes: '',
    takes: [],
    ...over,
  }) as Cue

const SILENCE_STDERR = [
  'ffmpeg version n6.0 Copyright (c) 2000-2023 the FFmpeg developers',
  '[silencedetect @ 000001] silence_start: 4.02',
  '[silencedetect @ 000001] silence_end: 5.1 | silence_duration: 1.08',
  '[silencedetect @ 000001] silence_start: 9.5',
  '[silencedetect @ 000001] silence_end: 10.3 | silence_duration: 0.8',
  '[silencedetect @ 000001] silence_start: 14.0',
  'size=N/A time=00:00:20.00 bitrate=N/A speed= 120x',
].join('\n')

describe('project sources', () => {
  it('sanitizer keeps the new fields and drops junk', () => {
    const rows = sanitizeProjectSources([
      { ...source(), width: 0, channels: -2 },
      { id: 's2', file: { fileId: 'x', relPath: 'p', format: 'flac' } },
      { name: 'no id' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows![0]).toEqual({
      id: 's1',
      name: 'interview_cut_v3.mp4',
      kind: 'video',
      file: { fileId: 's1', relPath: 'E:/p/audio/sources/s1.wav', format: 'wav', channels: 1 },
      duration: 760,
      media: 'E:/p/media/interview_cut_v3.mp4',
      height: 1080,
    })
  })

  it('a source survives a serialization roundtrip', () => {
    const one = source()
    expect(sanitizeProjectSources(JSON.parse(JSON.stringify([one])))).toEqual([one])
  })

  it('a project written without sources reads back without the key', () => {
    const old = {
      id: 'p',
      schemaVersion: 3,
      name: 'old',
      media: { referenceDir: 'r', referencePattern: '{k}' },
      characters: [],
      cues: [],
      sessions: [],
      pronunciationRules: '',
      exportTemplate: '{Key}.wav',
    }
    const parsed = projectFileSchema.parse(structuredClone(old))
    expect(parsed).toEqual(old)
    expect('sources' in parsed).toBe(false)
  })

  it('the row label reads duration, picture height and channels', () => {
    expect(sourceLabel(source())).toBe('12:40 · 1080p · stereo')
    expect(sourceLabel(source({ kind: 'audio', height: 0, channels: 1, duration: 95 }))).toBe(
      '1:35 · mono'
    )
  })
})

describe('silence detection', () => {
  it('parses silencedetect stderr and ignores an unterminated span', () => {
    expect(parseSilence(SILENCE_STDERR)).toEqual([
      { start: 4.02, end: 5.1 },
      { start: 9.5, end: 10.3 },
    ])
  })

  it('regions are the gaps between silences longer than 0.6s', () => {
    const regions = regionsBetween(
      [
        { start: 4, end: 5 },
        { start: 9.5, end: 10.3 },
      ],
      20
    )
    expect(regions).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9.5 },
      { start: 10.3, end: 20 },
    ])
  })

  it('a silence shorter than 0.6s does not break a region', () => {
    expect(regionsBetween([{ start: 4, end: 4.3 }], 10)).toEqual([{ start: 0, end: 10 }])
  })

  it('gaps under 0.3s merge and regions under 0.8s are dropped', () => {
    expect(
      mergeClose([
        { start: 0, end: 1 },
        { start: 1.2, end: 2 },
        { start: 3, end: 4 },
      ])
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ])
    expect(
      dropShort([
        { start: 0, end: 0.5 },
        { start: 1, end: 2 },
      ])
    ).toEqual([{ start: 1, end: 2 }])
  })

  it('an empty source yields no regions', () => {
    expect(regionsBetween([], 0)).toEqual([])
  })
})

describe('transcript regions', () => {
  const words = [
    { text: 'Welcome', start: 1, end: 1.4, type: 'word', speaker: 'speaker_0' },
    { text: ' ', start: 1.4, end: 1.5, type: 'spacing', speaker: 'speaker_0' },
    { text: 'here.', start: 1.5, end: 2, type: 'word', speaker: 'speaker_0' },
    { text: 'Thanks', start: 3, end: 3.6, type: 'word', speaker: 'speaker_1' },
    { text: 'a', start: 3.6, end: 3.7, type: 'word', speaker: 'speaker_1' },
    { text: 'lot', start: 3.7, end: 4.2, type: 'word', speaker: 'speaker_1' },
  ]

  it('splits on sentence ends and on a speaker change', () => {
    expect(transcriptRegions(words)).toEqual([
      { in: 1, out: 2, text: 'Welcome here.', speaker: 'speaker_0' },
      { in: 3, out: 4.2, text: 'Thanks a lot', speaker: 'speaker_1' },
    ])
  })

  it('regions become keyed seeds with the speaker as a character', () => {
    const seeds = regionCues('interview', transcriptRegions(words), (s) => s ?? '')
    expect(seeds.map((s) => s.key)).toEqual(['interview_001', 'interview_002'])
    expect(seeds[1]).toMatchObject({ characterId: 'speaker_1', sourceText: 'Thanks a lot' })
  })
})

describe('re-detecting on the same source', () => {
  it('keeps the lines that carry work and removes the bare ones', () => {
    const cues = [
      cue('a', { region: { sourceId: 's1', in: 0, out: 2 }, takes: [take('t1')] }),
      cue('b', { region: { sourceId: 's1', in: 3, out: 5 } }),
      cue('c', { region: { sourceId: 's2', in: 0, out: 1 } }),
      cue('d'),
    ]
    const merge = mergeRegionCues(cues, 's1')
    expect(merge.keep.map((c) => c.id)).toEqual(['a'])
    expect(merge.removedIds).toEqual(['b'])
    expect(merge.startIndex).toBe(1)
  })
})

describe('scene grouping', () => {
  it('a gap over 3s starts a new scene named after the first words', () => {
    const cues = [
      cue('b', { region: { sourceId: 's1', in: 10, out: 12 }, sourceText: 'Second scene opens now' }),
      cue('a', { region: { sourceId: 's1', in: 0, out: 2 }, sourceText: 'Welcome to the facility. Please remain calm.' }),
      cue('a2', { region: { sourceId: 's1', in: 3, out: 5 }, sourceText: 'Still here' }),
    ]
    const grouped = groupByScene(cues)
    expect(grouped.cues.map((c) => c.id)).toEqual(['a', 'a2', 'b'])
    expect(grouped.groups).toEqual([
      { name: 'Scene 1 · Welcome to the facility.', count: 2 },
      { name: 'Scene 2 · Second scene opens now', count: 1 },
    ])
  })

  it('the row timecode is mono minutes and tenths', () => {
    expect(regionTimecode(72.44)).toBe('01:12.4')
    expect(regionTimecode(0)).toBe('00:00.0')
  })
})

describe('region lines and the original', () => {
  const project = (cues: Cue[]): Project =>
    ({ cues, sources: [source()], exportTemplate: '{Key}.wav' }) as Project

  it('the original of a region line points at the source wav with an offset', () => {
    const c = cue('a', { region: { sourceId: 's1', in: 72.4, out: 80.6 } })
    expect(originalRef(c, [source()])).toEqual({
      srcPath: 'E:/p/audio/sources/s1.wav',
      offset: 72.4,
      duration: 80.6 - 72.4,
    })
    expect(originalLength(c)).toBeCloseTo(8.2, 6)
  })

  it('a region line with no source in the project resolves to nothing', () => {
    expect(originalRef(cue('a', { region: { sourceId: 'gone', in: 1, out: 2 } }), [])).toBeUndefined()
  })

  it('a region line mixes the original and carries the offset into the comp plan', () => {
    const t = take('t1')
    const c = cue('a', {
      region: { sourceId: 's1', in: 72.4, out: 80.6 },
      original: { exportMode: 'on', duckDb: -12 },
      takes: [t],
      finalTakeId: t.id,
      output: { kind: 'take', takeId: t.id, revision: 1 },
    })
    expect(mixesOriginal(c)).toBe(true)
    const plan = compPlanFor(c, t, project([c]))
    expect(plan?.original).toEqual({
      srcPath: 'E:/p/audio/sources/s1.wav',
      gainDb: -12,
      offset: 72.4,
      duration: 80.6 - 72.4,
    })
  })

  it('a plain file line still mixes its whole reference from zero', () => {
    const t = take('t1')
    const c = cue('a', {
      referenceAudio: { fileId: 'r', relPath: 'E:/orig/a.wav', format: 'wav' },
      referenceDuration: 3.5,
      original: { exportMode: 'on', duckDb: -6 },
      takes: [t],
      finalTakeId: t.id,
      output: { kind: 'take', takeId: t.id, revision: 1 },
    })
    expect(compPlanFor(c, t, project([c]))?.original).toEqual({
      srcPath: 'E:/orig/a.wav',
      gainDb: -6,
      offset: 0,
      duration: 3.5,
    })
  })

  it('subtitles of a region line are looked up in the region length', () => {
    const c = cue('a', { sourceText: 'First one. Second one.', text: 'Перше. Друге.' })
    expect(subtitleAt(c.sourceText, c.text, 0.5, 8.2)?.original).toBe('First one.')
    expect(subtitleAt(c.sourceText, c.text, 7, 8.2)?.original).toBe('Second one.')
  })
})

describe('the long video timeline', () => {
  const lines = [
    {
      cueId: 'c1',
      in: 10,
      out: 14,
      clips: [
        { srcPath: 'E:/p/t1.wav', srcIn: 0, srcOut: 4, start: 0, edits: emptyEdits(), trackId: 'tr1' },
      ],
      tracks: [
        { id: 'tr1', name: 'Track 1', gainDb: 0, muted: false, solo: true },
        { id: 'tr2', name: 'Track 2', gainDb: 0, muted: false, solo: false },
      ],
      originalMode: 'off' as const,
      duckDb: -12,
    },
    {
      cueId: 'c2',
      in: 30,
      out: 33,
      clips: [{ srcPath: 'E:/p/t2.wav', srcIn: 0, srcOut: 3, start: 0, edits: emptyEdits() }],
      originalMode: 'on' as const,
      duckDb: -12,
    },
  ]

  it('source audio plays untouched outside regions, ducks on and goes silent off', () => {
    expect(
      sourceSegments('E:/src.wav', 40, [
        { in: 10, out: 14, originalMode: 'off', duckDb: -12 },
        { in: 30, out: 33, originalMode: 'on', duckDb: -12 },
      ]).map((c) => [c.srcIn, c.srcOut, c.edits.gainDb])
    ).toEqual([
      [0, 10, 0],
      [14, 30, 0],
      [30, 33, -12],
      [33, 40, 0],
    ])
  })

  it('each line lands at its in on its own namespaced track', () => {
    const plan = videoTimelinePlan('E:/src.wav', 40, lines)
    const voices = plan.clips.filter((c) => c.trackId !== 'source')
    expect(voices.map((c) => [c.start, c.trackId])).toEqual([
      [10, 'c1:tr1'],
      [30, 'c2:track'],
    ])
    expect(plan.tracks.map((t) => t.id)).toEqual(['source', 'c1:tr1', 'c1:tr2', 'c2:track'])
  })

  it('a per-line solo becomes a mute on its siblings so tracks never solo globally', () => {
    const plan = videoTimelinePlan('E:/src.wav', 40, lines)
    expect(plan.tracks.some((t) => t.solo)).toBe(false)
    expect(plan.tracks.find((t) => t.id === 'c1:tr2')?.muted).toBe(true)
    expect(plan.tracks.find((t) => t.id === 'c1:tr1')?.muted).toBe(false)
  })

  it('chunks cover the whole source and never cut inside a line', () => {
    const chunks = renderChunks(150, 60, [
      { start: 55, end: 70 },
      { start: 118, end: 121 },
    ])
    expect(chunks[0]).toEqual({ start: 0, end: 70 })
    expect(chunks[chunks.length - 1].end).toBe(150)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end)
    for (const c of chunks) {
      expect(c.end).toBeGreaterThan(c.start)
      expect([55, 118].some((s) => c.end > s && c.end < (s === 55 ? 70 : 121))).toBe(false)
    }
  })
})

describe('video export settings', () => {
  it('the sanitizer and the zod mirror keep the video fields', () => {
    expect(sanitizeExportSettings({ video: 'audio', videoName: '  {name}.mkv ' })).toEqual({
      video: 'audio',
      videoName: '{name}.mkv',
    })
    expect(sanitizeExportSettings({ video: 'mux' })).toBeUndefined()
    expect(exportSettingsSchema.parse({ video: 'copy', videoName: '{name}_{lang}.mp4' })).toEqual({
      video: 'copy',
      videoName: '{name}_{lang}.mp4',
    })
    expect(() => exportSettingsSchema.parse({ video: 'mux' })).toThrow()
  })

  it('the name pattern fills in the source name and the target language', () => {
    expect(videoMode(undefined)).toBe('copy')
    expect(DEFAULT_VIDEO_NAME).toBe('{name}_{lang}.mp4')
    expect(videoName(undefined, 'interview_cut_v3.mp4', 'UK', 'copy')).toBe(
      'interview_cut_v3_UK.mp4'
    )
    expect(videoName(undefined, 'interview_cut_v3.mp4', 'UK', 'audio')).toBe(
      'interview_cut_v3_UK.wav'
    )
    expect(videoName({ videoName: '{name}-dub' }, 'a.mov', 'uk', 'copy')).toBe('a-dub.mp4')
    expect(videoName(undefined, 'a.mov', '', 'copy')).toBe('a.mp4')
  })
})

describe('the change set carries sources and removals', () => {
  it('applies sources and drops removed cues', () => {
    const base = {
      cues: [cue('a'), cue('b')],
      characters: [],
    } as unknown as Project
    const next = applyChangeSet(base, {
      sources: [source()],
      removedCueIds: ['b'],
      cues: [cue('c', { region: { sourceId: 's1', in: 0, out: 1 } })],
    })
    expect(next.cues.map((c) => c.id)).toEqual(['a', 'c'])
    expect(next.sources).toEqual([source()])
    expect(base.cues.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('the ffmpeg probe', () => {
  const stderr = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'interview_cut_v3.mp4':",
    '  Duration: 00:12:40.02, start: 0.000000, bitrate: 1443 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1305 kb/s, 30 fps, 30 tbr, 15360 tbn',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s',
  ].join('\n')

  it('reads duration, picture size and channel count', () => {
    expect(parseProbe(stderr)).toEqual({
      duration: 760.02,
      width: 1920,
      height: 1080,
      channels: 2,
      hasVideo: true,
      hasAudio: true,
    })
  })

  it('cover art in an audio file is not a video stream', () => {
    const mp3 = [
      '  Duration: 00:01:30.05, start: 0.025057, bitrate: 129 kb/s',
      '  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s',
      '  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 600x600 [SAR 1:1 DAR 1:1], 90k tbr (attached pic)',
    ].join('\n')
    const probe = parseProbe(mp3)
    expect(probe.hasVideo).toBe(false)
    expect(probe.channels).toBe(1)
    expect(probe.duration).toBeCloseTo(90.05, 2)
  })
})
