import { describe, expect, it } from 'vitest'
import { applyChangeSet, applyProjectCommand, audioWithinRoots, commandAudioPaths, type ProjectCommand } from '../src/shared/project-commands'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'
import { cueSchema, projectCommandSchema } from '../src/main/schemas'
import { hasReference, isManualProject, newLineCue, nextLineNumber, replacesWholeText, showsAi, splitParagraphs } from '../src/shared/lines'
import { isInsideDir, uniqueProjectName } from '../src/shared/project-summary'
import { takeFileKind } from '../src/shared/take-import'
import { pickHistory } from '../src/shared/undo-route'
import { exportName, planBatch } from '../src/shared/export-plan'
import { approvalState, hasValidVoicedOutput } from '../src/shared/approval'
import { lineStepCommand, originalStateOf, outputStateIn, type LineEdit } from '../src/shared/line-history'
import { DECODE_BUDGET_BYTES, decodedBytes, importProblem, maxEditMinutes } from '../src/shared/take-import'

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts',
  createdAt: 'now',
  file: { fileId: id, relPath: `/p/${id}.wav`, format: 'wav' },
  duration: 2,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const cue = (id: string, over: Partial<Cue> = {}): Cue => ({
  id,
  characterId: '',
  key: id,
  fields: {},
  sourceText: '',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
  ...over,
})

function project(cues: Cue[] = [cue('a'), cue('b')]): Project {
  return {
    id: 'p',
    schemaVersion: 1,
    createdAt: 'now',
    name: 'P',
    media: { referenceDir: '', referencePattern: '' },
    characters: [],
    cues,
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '{EventName}.{ext}',
    ui: { filter: '', search: '' },
  }
}

function run(p: Project, command: ProjectCommand): Project {
  const before = structuredClone(p)
  const changes = applyProjectCommand(p, projectCommandSchema.parse(command) as ProjectCommand)
  const mirrored = applyChangeSet(before, changes)
  expect(mirrored.cues).toEqual(p.cues)
  return p
}

const ids = (p: Project): string[] => p.cues.map((c) => c.id)

describe('unique project name', () => {
  it('starts at Untitled and counts up past taken folders, ignoring case', () => {
    expect(uniqueProjectName([])).toBe('Untitled')
    expect(uniqueProjectName(['Other'])).toBe('Untitled')
    expect(uniqueProjectName(['untitled'])).toBe('Untitled 2')
    expect(uniqueProjectName(['Untitled', 'Untitled 2', 'UNTITLED 3'])).toBe('Untitled 4')
    expect(uniqueProjectName(['Untitled', 'Untitled 3'])).toBe('Untitled 2')
  })
})

describe('paragraph split', () => {
  it('splits on blank lines when the text has any, keeping single breaks inside', () => {
    expect(splitParagraphs('One\nstill one\n\nTwo\n \n\nThree')).toEqual(['One\nstill one', 'Two', 'Three'])
  })

  it('splits on single newlines otherwise', () => {
    expect(splitParagraphs('One\nTwo\r\nThree\n')).toEqual(['One', 'Two', 'Three'])
  })

  it('trims and drops empty paragraphs', () => {
    expect(splitParagraphs('  One  \n\n\n\n   \n\n Two ')).toEqual(['One', 'Two'])
    expect(splitParagraphs('Only one')).toEqual(['Only one'])
    expect(splitParagraphs(' \n \n')).toEqual([])
  })

  it('replaces the whole text only when the field is empty or fully selected', () => {
    expect(replacesWholeText('', 0, 0)).toBe(true)
    expect(replacesWholeText('  ', 1, 1)).toBe(true)
    expect(replacesWholeText('abc', 0, 3)).toBe(true)
    expect(replacesWholeText('abc', 0, 2)).toBe(false)
    expect(replacesWholeText('abc', 3, 3)).toBe(false)
  })
})

describe('manual line identity', () => {
  it('numbers after the highest manual line', () => {
    expect(nextLineNumber([])).toBe(1)
    expect(nextLineNumber([cue('x', { key: 'line-004', fields: { EventName: 'Line 2' } })])).toBe(5)
    expect(nextLineNumber([cue('x', { key: 'k', fields: { EventName: 'Line 7' } }), cue('y', { key: 'VO_12' })])).toBe(8)
  })

  it('builds an empty, unassigned line', () => {
    expect(newLineCue('id', 3)).toEqual({
      id: 'id',
      characterId: '',
      key: 'line-003',
      fields: { EventName: 'Line 3' },
      sourceText: '',
      text: '',
      status: 'empty',
      notes: '',
      takes: [],
    })
    expect(newLineCue('id', 1, 'Hi').status).toBe('translated')
  })
})

describe('take file kinds', () => {
  it('keeps wav, mp3 and ogg, transcodes the rest of audio and refuses video', () => {
    expect(takeFileKind('C:\\a.b\\x.WAV')).toBe('keep')
    expect(takeFileKind('/a/x.mp3')).toBe('keep')
    expect(takeFileKind('/a/x.ogg')).toBe('keep')
    for (const ext of ['flac', 'm4a', 'aac', 'opus', 'webm']) expect(takeFileKind(`/a/x.${ext}`)).toBe('transcode')
    for (const ext of ['mp4', 'mov', 'mkv']) expect(takeFileKind(`/a/x.${ext}`)).toBe('video')
    expect(takeFileKind('/a.wav/readme')).toBe('unsupported')
    expect(takeFileKind('/a/x.txt')).toBe('unsupported')
  })
})

describe('decode budget for imports', () => {
  it('estimates decoded float bytes from the probe, assuming 48 kHz stereo when unknown', () => {
    expect(decodedBytes({ duration: 10, sampleRate: 44100, channels: 1 })).toBe(10 * 44100 * 4)
    expect(decodedBytes({ duration: 10 })).toBe(10 * 48000 * 2 * 4)
    expect(decodedBytes({ duration: 10, channels: 1 })).toBe(10 * 48000 * 4)
  })

  it('names the longest editable length in minutes', () => {
    expect(DECODE_BUDGET_BYTES).toBe(300 * 1024 * 1024)
    expect(maxEditMinutes({})).toBe(13)
    expect(maxEditMinutes({ sampleRate: 44100, channels: 1 })).toBe(29)
  })

  it('accepts audio within the budget and refuses longer or unmeasurable audio', () => {
    const limit = DECODE_BUDGET_BYTES / (48000 * 2 * 4)
    expect(importProblem({ duration: limit })).toBeNull()
    expect(importProblem({ duration: limit + 1 })).toBe('File too long to edit (max ~13 min)')
    expect(importProblem({ duration: 1200, sampleRate: 44100, channels: 1 })).toBeNull()
    expect(importProblem({ duration: 1800, sampleRate: 44100, channels: 1 })).toBe('File too long to edit (max ~29 min)')
    expect(importProblem({})).toBe('Audio length is unknown')
  })
})

describe('cue.create', () => {
  it('inserts a line right after the given one and mirrors the order in the renderer', () => {
    const p = run(project(), { type: 'cue.create', afterCueId: 'a', lines: [{ id: 'n1', text: '' }] })
    expect(ids(p)).toEqual(['a', 'n1', 'b'])
    expect(p.cues[1]).toEqual(newLineCue('n1', 1))
  })

  it('inserts several lines in order and numbers them consecutively', () => {
    const p = run(project(), {
      type: 'cue.create',
      afterCueId: 'a',
      lines: [
        { id: 'n1', text: 'Two' },
        { id: 'n2', text: 'Three' },
      ],
    })
    expect(ids(p)).toEqual(['a', 'n1', 'n2', 'b'])
    expect(p.cues.slice(1, 3).map((c) => [c.key, c.fields['EventName'], c.text])).toEqual([
      ['line-001', 'Line 1', 'Two'],
      ['line-002', 'Line 2', 'Three'],
    ])
    run(p, { type: 'cue.create', afterCueId: 'b', lines: [{ id: 'n3', text: '' }] })
    expect(p.cues[4].fields['EventName']).toBe('Line 3')
  })

  it('appends when there is no current line, including into an empty project', () => {
    const p = run(project([]), { type: 'cue.create', afterCueId: null, lines: [{ id: 'n1', text: '' }] })
    expect(ids(p)).toEqual(['n1'])
    run(p, { type: 'cue.create', afterCueId: null, lines: [{ id: 'n2', text: '' }] })
    expect(ids(p)).toEqual(['n1', 'n2'])
  })

  it('refuses used ids, an unknown anchor and an empty list', () => {
    expect(() => applyProjectCommand(project(), { type: 'cue.create', afterCueId: null, lines: [{ id: 'a', text: '' }] })).toThrow()
    expect(() =>
      applyProjectCommand(project(), {
        type: 'cue.create',
        afterCueId: null,
        lines: [
          { id: 'n', text: '' },
          { id: 'n', text: '' },
        ],
      })
    ).toThrow()
    expect(() => applyProjectCommand(project(), { type: 'cue.create', afterCueId: 'zz', lines: [{ id: 'n', text: '' }] })).toThrow('Cue not found')
    expect(() => projectCommandSchema.parse({ type: 'cue.create', afterCueId: null, lines: [] })).toThrow()
  })
})

describe('ordered insertion in change sets', () => {
  it('still appends unknown cues without an index, exactly as before', () => {
    const next = applyChangeSet(project(), { cues: [cue('z'), cue('a', { text: 'x' })] })
    expect(ids(next)).toEqual(['a', 'b', 'z'])
    expect(next.cues[0].text).toBe('x')
  })

  it('places indexed cues at their index in ascending order and clamps out-of-range indexes', () => {
    const next = applyChangeSet(project(), {
      cues: [cue('late'), cue('y'), cue('x'), cue('tail')],
      cueIndex: { x: 0, y: 2, late: 99 },
    })
    expect(ids(next)).toEqual(['x', 'a', 'y', 'b', 'late', 'tail'])
  })
})

describe('cue.delete and cue.restore', () => {
  const full = (): Cue =>
    cue('full', {
      characterId: 'ch',
      key: 'K1',
      fields: { EventName: 'E', exportName: 'X' },
      sourceText: 'src',
      text: 'txt',
      suggestedText: 'sugg',
      status: 'approved',
      notes: 'n',
      referenceAudio: { fileId: 'r', relPath: '/p/r.wav', format: 'wav', sampleRate: 48000, channels: 1 },
      referenceDuration: 1.5,
      original: { exportMode: 'on', duckDb: -12, previewMuted: true },
      stems: [{ id: 's', name: 'Voice', file: { fileId: 's', relPath: '/p/s.wav', format: 'wav' }, exportMode: 'off', duckDb: -6 }],
      region: { sourceId: 'src1', in: 1, out: 2 },
      takes: [
        take('t1', {
          kind: 'recording',
          meta: { text: 'txt', voiceSettings: { stability: 0.5, similarity: 0.5, style: 0, speed: 1, boost: true }, sourceTakeId: 'x', provider: 'elevenlabs', model: 'm' },
          edits: { ...emptyEdits(), timeStretch: 1.1, gainEnvelope: [{ t: 0, db: -3 }], effects: { reverb: { mix: 0.2, size: 0.5, decay: 1 } } },
          words: [{ text: 'txt', start: 0, end: 1 }],
          rating: 2,
          fragment: true,
          pinned: true,
        }),
        take('t2', { deletedAt: 'then' }),
      ],
      finalTakeId: 't2',
      comp: {
        clips: [{ id: 'c1', sourceTakeId: 't1', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits(), crossfade: 0.1, trackId: 'tr' }],
        region: { in: 0, out: 1 },
        tracks: [{ id: 'tr', name: 'A', gainDb: 0, muted: false, solo: false }],
        originalStart: 0.5,
      },
      output: { kind: 'comp', revision: 3 },
      textRevision: 2,
      approval: { textRevision: 2, outputRevision: 3, approvedAt: 'then' },
      voiceSettingsOverride: { speed: 1.1 },
    })

  it('validates a full cue without dropping any field', () => {
    const value = full()
    expect(cueSchema.parse(value)).toEqual(value)
    expect(cueSchema.parse(cue('bare'))).toEqual(cue('bare'))
    expect(() => cueSchema.parse({ ...value, status: 'nope' })).toThrow()
    expect(() => cueSchema.parse({ ...value, takes: [{ id: 'x' }] })).toThrow()
  })

  it('deletes a line and restores the exact cue at its old index', () => {
    const p = project([cue('a'), full(), cue('b')])
    const saved = structuredClone(p.cues[1])
    const changes = applyProjectCommand(p, { type: 'cue.delete', cueIds: ['full'] })
    expect(changes).toEqual({ removedCueIds: ['full'], removedCues: [{ cue: saved, index: 1 }] })
    expect(ids(p)).toEqual(['a', 'b'])
    run(p, { type: 'cue.restore', cues: changes.removedCues! })
    expect(p.cues).toEqual([cue('a'), saved, cue('b')])
  })

  it('deletes and restores several lines in one step, in their old places', () => {
    const p = project([cue('a'), cue('b'), cue('c'), cue('d'), cue('e')])
    const before = structuredClone(p.cues)
    const changes = applyProjectCommand(p, projectCommandSchema.parse({ type: 'cue.delete', cueIds: ['d', 'b'] }) as ProjectCommand)
    expect(applyChangeSet(project(structuredClone(before)), changes).cues).toEqual(p.cues)
    expect(ids(p)).toEqual(['a', 'c', 'e'])
    run(p, { type: 'cue.restore', cues: changes.removedCues! })
    expect(p.cues).toEqual(before)
  })

  it('changes nothing when any line of a batch cannot be deleted or restored', () => {
    const owner = cue('a', { takes: [take('t', { pinned: true })] })
    const user = cue('b', { comp: { clips: [{ id: 'c', sourceTakeId: 't', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }] } })
    const p = project([owner, user, cue('c')])
    const before = structuredClone(p)
    expect(() => applyProjectCommand(p, { type: 'cue.delete', cueIds: ['c', 'a'] })).toThrow('used on another line')
    expect(() => applyProjectCommand(p, { type: 'cue.delete', cueIds: ['c', 'zz'] })).toThrow('Cue not found')
    expect(() => applyProjectCommand(p, { type: 'cue.delete', cueIds: ['c', 'c'] })).toThrow()
    expect(() => applyProjectCommand(p, { type: 'cue.restore', cues: [{ cue: cue('n'), index: 0 }, { cue: cue('a'), index: 1 }] })).toThrow()
    expect(p).toEqual(before)
    applyProjectCommand(p, { type: 'cue.delete', cueIds: ['a', 'b'] })
    expect(ids(p)).toEqual(['c'])
  })
})

describe('cue.useTakeAsOriginal', () => {
  it('points the original at the take file and length', () => {
    const p = project([cue('a', { takes: [take('t', { kind: 'imported', duration: 3.5 })] })])
    run(p, { type: 'cue.useTakeAsOriginal', cueId: 'a', takeId: 't' })
    expect(p.cues[0].referenceAudio).toEqual(p.cues[0].takes[0].file)
    expect(p.cues[0].referenceAudio).not.toBe(p.cues[0].takes[0].file)
    expect(p.cues[0].referenceDuration).toBe(3.5)
    expect(p.cues[0].takes).toHaveLength(1)
  })

  it('drops a stale length when the take length is unknown, and accepts a pinned source', () => {
    const p = project([
      cue('a', { referenceDuration: 9 }),
      cue('b', { takes: [take('t', { pinned: true, duration: 0 })] }),
    ])
    run(p, { type: 'cue.useTakeAsOriginal', cueId: 'a', takeId: 't' })
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/t.wav')
    expect(p.cues[0]).not.toHaveProperty('referenceDuration')
  })

  it('refuses unknown or deleted takes', () => {
    const p = project([cue('a', { takes: [take('gone', { deletedAt: 'x' })] })])
    expect(() => applyProjectCommand(p, { type: 'cue.useTakeAsOriginal', cueId: 'a', takeId: 'zz' })).toThrow()
    expect(() => applyProjectCommand(p, { type: 'cue.useTakeAsOriginal', cueId: 'a', takeId: 'gone' })).toThrow()
  })
})

describe('undo routing with lines', () => {
  it('picks the newest side on undo and the oldest on redo', () => {
    expect(pickHistory({ comp: 1, fx: 2, line: 3 }, 'undo')).toBe('line')
    expect(pickHistory({ comp: 5, fx: 2, line: 3 }, 'undo')).toBe('comp')
    expect(pickHistory({ comp: null, fx: null, line: 3 }, 'undo')).toBe('line')
    expect(pickHistory({ comp: 4, fx: 5, line: 3 }, 'redo')).toBe('line')
    expect(pickHistory({ comp: 3, fx: null, line: 3 }, 'redo')).toBe('comp')
    expect(pickHistory({ comp: null, fx: null, line: null }, 'undo')).toBe(null)
  })
})

describe('quick session export', () => {
  it('exports a line whose only audio is a recording placed on the timeline, named after the line', () => {
    const line = newLineCue('n1', 1)
    const recorded: Cue = {
      ...line,
      takes: [take('rec', { kind: 'recording', duration: 1.2 })],
      comp: { clips: [{ id: 'c', sourceTakeId: 'rec', srcIn: 0, srcOut: 1.2, start: 0, edits: emptyEdits() }] },
      output: { kind: 'comp', revision: 1 },
    }
    const p = project([recorded])
    expect(hasValidVoicedOutput(recorded, p)).toBe(true)
    const planned = planBatch(p)
    expect(planned.map((x) => x.name)).toEqual(['Line 1.wav'])
    expect(exportName(p, recorded, recorded.takes[0])).toBe('Line 1.wav')
  })
})

describe('undoing Use as original', () => {
  function useAsOriginal(p: Project, cueId: string, takeId: string): ProjectCommand {
    const before = originalStateOf(p.cues.find((c) => c.id === cueId)!)
    const changes = applyProjectCommand(p, { type: 'cue.useTakeAsOriginal', cueId, takeId })
    const edit: LineEdit = { kind: 'original', cueId, takeId, before, after: outputStateIn(changes, cueId), at: 1 }
    return lineStepCommand(edit, 'undo')
  }

  it('restores the previous original file and length', () => {
    const before = cue('a', {
      referenceAudio: { fileId: 'r', relPath: '/p/r.wav', format: 'wav', sampleRate: 48000 },
      referenceDuration: 4,
      takes: [take('t', { duration: 1 })],
    })
    const p = project([structuredClone(before)])
    const undo = useAsOriginal(p, 'a', 't')
    expect(p.cues[0].referenceDuration).toBe(1)
    run(p, undo)
    expect(p.cues[0]).toEqual(before)
  })

  it('restores the absence of an original', () => {
    const before = cue('a', { takes: [take('t')] })
    const p = project([structuredClone(before)])
    run(p, useAsOriginal(p, 'a', 't'))
    expect(p.cues[0]).toEqual(before)
    expect(p.cues[0]).not.toHaveProperty('referenceAudio')
    expect(p.cues[0]).not.toHaveProperty('referenceDuration')
  })

  const approvedMixing = (): Cue =>
    cue('a', {
      text: 'T',
      status: 'approved',
      referenceAudio: { fileId: 'r', relPath: '/p/r.wav', format: 'wav' },
      referenceDuration: 4,
      original: { exportMode: 'on', duckDb: -12 },
      takes: [take('v'), take('t', { kind: 'imported', duration: 1 })],
      finalTakeId: 'v',
      output: { kind: 'take', takeId: 'v', revision: 2 },
      textRevision: 1,
      approval: { textRevision: 1, outputRevision: 2, approvedAt: 'then' },
    })

  it('brings an approved line that mixes its original back exactly, approval included', () => {
    const before = approvedMixing()
    const p = project([structuredClone(before)])
    expect(approvalState(p.cues[0], p)).toBe('approved')
    const undo = useAsOriginal(p, 'a', 't')
    expect(approvalState(p.cues[0], p)).toBe('stale')
    expect(p.cues[0].status).toBe('generated')
    run(p, undo)
    expect(p.cues[0]).toEqual(before)
    expect(approvalState(p.cues[0], p)).toBe('approved')
  })

  it('does not revive an approval when the output changed after the action', () => {
    const p = project([approvedMixing()])
    const undo = useAsOriginal(p, 'a', 't')
    run(p, { type: 'cue.setFinalTake', cueId: 'a', takeId: 'v' })
    run(p, { type: 'cue.setTakeEffects', cueId: 'a', takeId: 'v', effects: { reverb: { mix: 0.2, size: 0.5, decay: 1 } } })
    run(p, undo)
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/r.wav')
    expect(approvalState(p.cues[0], p)).toBe('stale')
    expect(p.cues[0].status).not.toBe('approved')
  })

  const approvedPlain = (): Cue => ({ ...approvedMixing(), original: { exportMode: 'off', duckDb: -12 } })

  it('keeps a line excluded after the action excluded when undone', () => {
    for (const make of [approvedMixing, approvedPlain]) {
      const p = project([make()])
      const undo = useAsOriginal(p, 'a', 't')
      run(p, { type: 'cue.setExcluded', cueId: 'a', excluded: true })
      run(p, undo)
      expect(p.cues[0].referenceAudio?.relPath).toBe('/p/r.wav')
      expect(p.cues[0].referenceDuration).toBe(4)
      expect(p.cues[0].status).toBe('excluded')
      expect(planBatch(p)).toEqual([])
    }
  })

  it('keeps an approval removed after the action when undone', () => {
    const p = project([approvedMixing()])
    const undo = useAsOriginal(p, 'a', 't')
    run(p, { type: 'cue.approve', cueId: 'a', approved: false })
    run(p, undo)
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/r.wav')
    expect(p.cues[0]).not.toHaveProperty('approval')
    expect(p.cues[0].status).toBe('generated')
  })

  it('keeps an approval given after the action when undone', () => {
    const p = project([approvedPlain()])
    const undo = useAsOriginal(p, 'a', 't')
    run(p, { type: 'cue.approve', cueId: 'a', approved: true, approvedAt: 'later' })
    run(p, undo)
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/r.wav')
    expect(p.cues[0].approval?.approvedAt).toBe('later')
    expect(approvalState(p.cues[0], p)).toBe('approved')
  })

  it('matches the state produced by the action regardless of key order', () => {
    const before: Cue = {
      ...approvedMixing(),
      output: { revision: 2, takeId: 'v', kind: 'take' },
      approval: { approvedAt: 'then', outputRevision: 2, textRevision: 1 },
    }
    const p = project([structuredClone(before)])
    run(p, useAsOriginal(p, 'a', 't'))
    expect(p.cues[0]).toEqual(before)
  })

  it('carries the state to compare through the command schema and refuses a command without it', () => {
    const p = project([approvedMixing()])
    const undo = useAsOriginal(p, 'a', 't')
    expect(projectCommandSchema.parse(undo)).toEqual(undo)
    const { whenState: _dropped, ...legacy } = undo as Extract<ProjectCommand, { type: 'cue.restoreOriginal' }>
    expect(projectCommandSchema.safeParse(legacy).success).toBe(false)
  })
})

describe('restore stays inside the open project', () => {
  it('matches only files under the project folder', () => {
    expect(isInsideDir('/root/A.vostudio/audio/takes/c/t.wav', '/root/A.vostudio')).toBe(true)
    expect(isInsideDir('C:\\P\\A.vostudio\\audio\\t.wav', 'c:/p/a.vostudio/')).toBe(true)
    expect(isInsideDir('/root/B.vostudio/audio/t.wav', '/root/A.vostudio')).toBe(false)
    expect(isInsideDir('/root/A.vostudio2/t.wav', '/root/A.vostudio')).toBe(false)
    expect(isInsideDir('/root/A.vostudio/../B.vostudio/t.wav', '/root/A.vostudio')).toBe(false)
    expect(isInsideDir('/root/A.vostudio', '/root/A.vostudio')).toBe(false)
    expect(isInsideDir('/x/t.wav', '')).toBe(false)
  })

  it('lists every audio file a restoring command would bring in', () => {
    const restored = cue('a', {
      takes: [take('t1'), take('t2')],
      referenceAudio: { fileId: 'r', relPath: '/p/r.wav', format: 'wav' },
      stems: [{ id: 's', name: 'Voice', file: { fileId: 's', relPath: '/p/s.wav', format: 'wav' }, exportMode: 'off' }],
    })
    expect(commandAudioPaths({ type: 'cue.restore', cues: [{ cue: restored, index: 0 }] })).toEqual(['/p/t1.wav', '/p/t2.wav', '/p/r.wav', '/p/s.wav'])
    expect(commandAudioPaths({ type: 'cue.restoreOriginal', cueId: 'a', referenceAudio: restored.referenceAudio!, referenceDuration: 1 })).toEqual(['/p/r.wav'])
    expect(commandAudioPaths({ type: 'cue.restoreOriginal', cueId: 'a', referenceAudio: null, referenceDuration: null })).toEqual([])
    expect(commandAudioPaths({ type: 'cue.delete', cueIds: ['a'] })).toEqual([])
  })
})

describe('trusted audio roots for restoring', () => {
  const roots = ['/root/P.vostudio', '/data/reference', '/data/generated']
  const restore = (over: Partial<Cue>): ProjectCommand => ({ type: 'cue.restore', cues: [{ cue: cue('a', over), index: 0 }] })

  it('accepts a line whose original lives under the reference root and takes under project or generated roots', () => {
    expect(
      audioWithinRoots(
        restore({
          referenceAudio: { fileId: 'r', relPath: '/data/reference/vo/r.wav', format: 'wav' },
          takes: [take('t1', { file: { fileId: 't1', relPath: '/root/P.vostudio/audio/takes/a/t1.wav', format: 'wav' } }), take('t2', { file: { fileId: 't2', relPath: '/data/generated/t2.mp3', format: 'mp3' } })],
        }),
        roots
      )
    ).toBe(true)
    expect(audioWithinRoots({ type: 'cue.restoreOriginal', cueId: 'a', referenceAudio: { fileId: 'r', relPath: '/data/reference/r.wav', format: 'wav' }, referenceDuration: 1 }, roots)).toBe(true)
  })

  it('rejects any file outside every trusted root', () => {
    expect(audioWithinRoots(restore({ referenceAudio: { fileId: 'r', relPath: '/elsewhere/r.wav', format: 'wav' } }), roots)).toBe(false)
    expect(audioWithinRoots(restore({ takes: [take('t', { file: { fileId: 't', relPath: '/root/Other.vostudio/t.wav', format: 'wav' } })] }), roots)).toBe(false)
    expect(audioWithinRoots(restore({ referenceAudio: { fileId: 'r', relPath: '/data/reference/r.wav', format: 'wav' } }), ['/root/P.vostudio'])).toBe(false)
    expect(audioWithinRoots({ type: 'cue.delete', cueIds: ['a'] }, [])).toBe(true)
  })
})

describe('restore revalidates sources from other lines', () => {
  const clip = { id: 'c', sourceTakeId: 't', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }

  function deletedUser(pinned: Partial<Take>): { p: Project; removed: NonNullable<ReturnType<typeof applyProjectCommand>['removedCues']> } {
    const p = project([cue('owner', { takes: [take('t', { pinned: true })] }), cue('user', { comp: { clips: [clip] } })])
    const removed = applyProjectCommand(p, { type: 'cue.delete', cueIds: ['user'] }).removedCues!
    Object.assign(p.cues[0].takes[0], pinned)
    if (pinned.pinned === undefined) delete p.cues[0].takes[0].pinned
    return { p, removed }
  }

  it('rejects the whole restore when a clip source was unpinned or deleted meanwhile', () => {
    for (const change of [{}, { pinned: true as const, deletedAt: 'then' }]) {
      const { p, removed } = deletedUser(change)
      const before = structuredClone(p)
      expect(() => applyProjectCommand(p, { type: 'cue.restore', cues: [...removed, { cue: cue('other'), index: 0 }] })).toThrow('no longer available')
      expect(p).toEqual(before)
      expect(p.cues[0].takes[0].pinned).toBe(change.pinned)
    }
  })

  it('restores when the pinned source is still there', () => {
    const { p, removed } = deletedUser({ pinned: true })
    run(p, { type: 'cue.restore', cues: removed })
    expect(ids(p)).toEqual(['owner', 'user'])
  })

  it('restores a line whose own pinned take is used elsewhere, and sources within the same batch', () => {
    const p = project([cue('owner', { takes: [take('t', { pinned: true })] }), cue('user', { comp: { clips: [clip] } })])
    const removed = applyProjectCommand(p, { type: 'cue.delete', cueIds: ['owner', 'user'] }).removedCues!
    run(p, { type: 'cue.restore', cues: removed })
    expect(ids(p)).toEqual(['owner', 'user'])
    expect(p.cues[0].takes[0].pinned).toBe(true)
  })
})

describe('AI sections visibility', () => {
  const ref = { fileId: 'r', relPath: '/r.wav', format: 'wav' as const }
  const ada = {
    id: 'ada',
    name: 'ADA',
    color: '#fff',
    provider: { providerId: 'elevenlabs' as const, voiceId: 'v', ttsModel: 't', stsModel: 's' },
    voiceSettings: { stability: 0.5, similarity: 0.5, style: 0, speed: 1, boost: false },
  }

  it('hides for a manual line recorded or imported by the user', () => {
    const p = project([])
    expect(showsAi(newLineCue('n', 1), p)).toBe(false)
    expect(showsAi(newLineCue('n', 1, 'my text'), p)).toBe(false)
    const own = cue('m', { takes: [take('r', { kind: 'recording' }), take('i', { kind: 'imported' }), take('c', { kind: 'composite' })] })
    expect(showsAi(own, p)).toBe(false)
  })

  it('shows for template, table, audio-import and source lines', () => {
    const p = project([])
    expect(showsAi(cue('t', { sourceText: 'Hi', referenceAudio: ref, referenceDuration: 1, characterId: 'ada' }), { ...p, characters: [ada] })).toBe(true)
    expect(showsAi(cue('s', { sourceText: 'Hi' }), p)).toBe(true)
    expect(showsAi(cue('a', { referenceAudio: ref }), p)).toBe(true)
    expect(showsAi(cue('d', { referenceDuration: 2 }), p)).toBe(true)
    expect(showsAi(cue('g', { region: { sourceId: 'src', in: 0, out: 1 } }), p)).toBe(true)
    expect(showsAi(cue('c', { characterId: 'ada' }), p)).toBe(true)
  })

  it('shows once AI was used on the line or configured in the project', () => {
    const p = project([])
    expect(showsAi(cue('g', { takes: [take('t')] }), p)).toBe(true)
    expect(showsAi(cue('v', { takes: [take('s', { kind: 'sts' })] }), p)).toBe(true)
    expect(showsAi(cue('m'), { ...p, characters: [ada] })).toBe(true)
    expect(showsAi(cue('m'), { ...p, provider: { tts: { model: 'eleven_v3' } } })).toBe(true)
  })

  it('a project is manual while none of its lines shows AI', () => {
    expect(isManualProject(project([]))).toBe(true)
    const own = cue('m', { takes: [take('i', { kind: 'imported' })] })
    expect(isManualProject(project([newLineCue('n', 1, 'my text'), own]))).toBe(true)
    expect(isManualProject(project([newLineCue('n', 1), cue('s', { sourceText: 'Hi' })]))).toBe(false)
    expect(isManualProject(project([cue('g', { region: { sourceId: 'src', in: 0, out: 1 } })]))).toBe(false)
    expect(isManualProject({ ...project([newLineCue('n', 1)]), characters: [ada] })).toBe(false)
    expect(isManualProject({ ...project([newLineCue('n', 1)]), provider: { tts: { model: 'eleven_v3' } } })).toBe(false)
  })

  it('has reference audio only with an original, a source region or stems', () => {
    expect(hasReference(newLineCue('n', 1))).toBe(false)
    expect(hasReference(newLineCue('n', 1, 'my text'))).toBe(false)
    expect(hasReference(cue('m', { takes: [take('r', { kind: 'recording' })], referenceDuration: 2 }))).toBe(false)
    expect(hasReference(cue('a', { referenceAudio: ref }))).toBe(true)
    expect(hasReference(cue('g', { region: { sourceId: 'src', in: 0, out: 1 } }))).toBe(true)
    expect(hasReference(cue('s', { stems: [{ id: 'v', name: 'Voice', file: ref, exportMode: 'off' }] }))).toBe(true)
  })
})
