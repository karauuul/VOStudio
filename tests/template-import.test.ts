import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { serializeCell } from '../src/shared/csv'
import { sanitizeTerms, type Project } from '../src/shared/domain'
import { exportName } from '../src/shared/export-plan'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-template-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const { buildProjectBase, createProjectFromTemplate, relUnderAudio, toPreview, validateTemplate } =
  await import('../src/main/template-import')

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.vostudio-src')

const META = JSON.stringify({
  formatVersion: 1,
  name: 'Tmp Template',
  sourceLang: 'en',
  targetLang: 'uk',
})

const HEADER = 'cueId,character,sourceText,translation,refAudio,exportName,status,durationHint,note'

let seq = 0
async function makeTemplate(parts: { meta?: string | null; index?: string | null; terms?: string | null }): Promise<string> {
  const dir = path.join(H.root, `tpl-${seq++}`)
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true })
  if (parts.meta !== null) await fs.writeFile(path.join(dir, 'project-meta.json'), parts.meta ?? META)
  if (parts.index !== null) await fs.writeFile(path.join(dir, 'index.csv'), parts.index ?? '')
  if (parts.terms !== null) await fs.writeFile(path.join(dir, 'terms.csv'), parts.terms ?? 'term,translation,note\n')
  return dir
}

const rows = (...lines: string[]): string => [HEADER, ...lines, ''].join('\n')

const fatalReasons = async (index: string, meta?: string): Promise<string[]> =>
  (await validateTemplate(await makeTemplate({ index, meta }))).fatalErrors.map((e) => e.reason)

afterAll(async () => {
  await fs.rm(H.root, { recursive: true, force: true })
})

describe('template validation — fixture', () => {
  it('accepts the spec-conformant fixture with no fatal errors', async () => {
    const v = await validateTemplate(FIXTURE)
    expect(v.fatalErrors).toEqual([])
    expect(v.meta).toEqual({ formatVersion: 1, name: 'Sample Template', sourceLang: 'en', targetLang: 'uk' })
    expect(v.rows).toHaveLength(5)
    expect(v.characters).toEqual(['ADA', 'Alien'])
    expect(v.terms).toEqual([
      { term: 'Ferrofluid', translation: 'ферофлюїд', note: 'uncountable' },
      { term: 'pioneer', translation: 'піонер', note: 'player character' },
    ])
  })

  it('reports a missing refAudio as a warning, not a fatal error', async () => {
    const v = await validateTemplate(FIXTURE)
    expect(v.warnings.map((w) => w.reason)).toContainEqual(expect.stringContaining('vo/ada_002.wav'))
    expect(v.rows.find((r) => r.cueId === 'VO_ADA_002')?.missingAudio).toBe(true)
    expect(v.rows.find((r) => r.cueId === 'VO_ADA_001')?.missingAudio).toBe(false)
  })

  it('warns about an empty character and keeps an empty refAudio silent', async () => {
    const v = await validateTemplate(FIXTURE)
    const misc = v.rows.find((r) => r.cueId === 'VO_MISC_005')!
    expect(misc.character).toBe('')
    expect(misc.missingAudio).toBe(false)
    expect(v.warnings.filter((w) => w.row === 6).map((w) => w.reason)).toEqual([
      'character is empty — cue stays unassigned',
    ])
  })

  it('builds a preview without creating anything', async () => {
    const preview = toPreview(await validateTemplate(FIXTURE))
    expect(preview.totalCues).toBe(5)
    expect(preview.firstRows).toHaveLength(5)
    expect(preview.characters).toEqual(['ADA', 'Alien'])
    expect(preview.terms).toBe(2)
    expect(preview.fatalErrors).toEqual([])
    expect(await fs.readdir(FIXTURE)).toEqual(['audio', 'index.csv', 'project-meta.json', 'terms.csv'])
  })
})

describe('template validation — fatal vs warning matrix', () => {
  it('duplicate cueId is fatal', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,,X1,,,', 'A,ADA,S,,,X2,,,'))
    expect(reasons).toEqual(['duplicate cueId "A" (first seen in row 2)'])
  })

  it('duplicate exportName is fatal', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,,X,,,', 'B,ADA,S,,,X,,,'))
    expect(reasons).toEqual(['duplicate exportName "X" (first seen in row 2)'])
  })

  it('a missing required column is fatal', async () => {
    const reasons = await fatalReasons('cueId,character,sourceText\nA,ADA,S\n')
    expect(reasons).toEqual(['index.csv is missing columns: refAudio, exportName'])
  })

  it('an empty cueId, exportName or sourceText is fatal', async () => {
    const reasons = await fatalReasons(rows(',ADA,,,,,,,'))
    expect(reasons).toEqual(['cueId is empty', 'exportName is empty', 'sourceText is empty'])
  })

  it('an unknown status is fatal', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,,X,approved,,'))
    expect(reasons).toEqual(['status "approved" is not allowed (empty or "excluded")'])
  })

  it('excluded status is accepted', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,,X,excluded,,'))
    expect(reasons).toEqual([])
  })

  it('an unsupported reference format is fatal', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,vo/a.flac,X,,,'))
    expect(reasons).toEqual(['refAudio "vo/a.flac" has an unsupported format (wav/mp3/ogg)'])
  })

  it('a refAudio escaping audio/ is fatal', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,../../secret.wav,X,,,'))
    expect(reasons).toEqual(['refAudio "../../secret.wav" points outside audio/'])
  })

  it('a non-numeric durationHint is a warning, not fatal', async () => {
    const v = await validateTemplate(await makeTemplate({ index: rows('A,ADA,S,,,X,,soon,') }))
    expect(v.fatalErrors).toEqual([])
    expect(v.warnings.map((w) => w.reason)).toEqual(['durationHint "soon" is not a number — ignored'])
  })

  it('an empty index.csv is fatal', async () => {
    const reasons = await fatalReasons(rows())
    expect(reasons).toEqual(['index.csv has no data rows'])
  })

  it('a missing index.csv is fatal', async () => {
    const v = await validateTemplate(await makeTemplate({ index: null }))
    expect(v.fatalErrors.map((e) => e.reason)).toEqual(['index.csv is missing'])
  })

  it('a missing or malformed project-meta.json is fatal', async () => {
    expect((await validateTemplate(await makeTemplate({ meta: null }))).fatalErrors[0].reason).toBe(
      'project-meta.json is missing'
    )
    expect((await validateTemplate(await makeTemplate({ meta: '{' }))).fatalErrors[0].reason).toBe(
      'project-meta.json is not valid JSON'
    )
    const wrongVersion = await validateTemplate(
      await makeTemplate({ meta: JSON.stringify({ formatVersion: 2, name: 'X', sourceLang: 'en', targetLang: 'uk' }) })
    )
    expect(wrongVersion.fatalErrors[0].reason).toContain('formatVersion')
    const noLang = await validateTemplate(
      await makeTemplate({ meta: JSON.stringify({ formatVersion: 1, name: 'X', sourceLang: 'en' }) })
    )
    expect(noLang.fatalErrors[0].reason).toContain('targetLang')
    const badName = await validateTemplate(
      await makeTemplate({ meta: JSON.stringify({ formatVersion: 1, name: '../evil', sourceLang: 'en', targetLang: 'uk' }) })
    )
    expect(badName.fatalErrors[0].reason).toContain('not a valid folder name')
  })

  it('a missing terms.csv is a warning and leaves the glossary absent', async () => {
    const v = await validateTemplate(await makeTemplate({ index: rows('A,ADA,S,,,X,,,'), terms: null }))
    expect(v.fatalErrors).toEqual([])
    expect(v.terms).toBeUndefined()
    expect(v.warnings.map((w) => w.reason)).toEqual(['terms.csv is missing — no glossary imported'])
  })

  it('accepts a BOM and quoted commas through the shared CSV parser', async () => {
    const v = await validateTemplate(
      await makeTemplate({ index: '﻿' + rows('A,ADA,"Hello, pioneer",,,X,,,') })
    )
    expect(v.fatalErrors).toEqual([])
    expect(v.rows[0].sourceText).toBe('Hello, pioneer')
  })
})

describe('exportName safety', () => {
  it('rejects path separators, traversal and reserved characters', async () => {
    const bad = ['a/b', 'a\\b', '..', 'a:b', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'name.']
    for (const name of bad) {
      const reasons = await fatalReasons(rows(`A,ADA,S,,,${serializeCell(name)},,,`))
      expect(reasons, name).toEqual([`exportName "${name}" is not a safe file name`])
    }
  })

  it('accepts ordinary export names', async () => {
    expect(await fatalReasons(rows('A,ADA,S,,,VO_ADA__123.take,,,'))).toEqual([])
  })

  it('treats exportName uniqueness case-insensitively', async () => {
    const reasons = await fatalReasons(rows('A,ADA,S,,,Line_01,,,', 'B,ADA,S,,,LINE_01,,,'))
    expect(reasons).toEqual(['duplicate exportName "LINE_01" (first seen in row 2)'])
  })

  it('keeps cueId uniqueness case-sensitive', async () => {
    expect(await fatalReasons(rows('a,ADA,S,,,X1,,,', 'A,ADA,S,,,X2,,,'))).toEqual([])
  })

  it('stores the trimmed exportName in the cue fields', async () => {
    const v = await validateTemplate(await makeTemplate({ index: rows('A,ADA,S,,,"  Padded  ",,,') }))
    expect(v.fatalErrors).toEqual([])
    expect(v.rows[0].exportName).toBe('Padded')
    expect(v.rows[0].fields['exportName']).toBe('Padded')
    const base = buildProjectBase(v, '/refs')
    expect(base.cues[0].fields['exportName']).toBe('Padded')
  })
})

describe('malformed CSV', () => {
  it('rejects an unterminated quoted field in index.csv', async () => {
    const reasons = await fatalReasons(HEADER + '\nA,ADA,"never closed,,,X,,,\n')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('index.csv is malformed')
    expect(reasons[0]).toContain('unterminated quoted field')
  })

  it('rejects a row whose cell count differs from the header', async () => {
    expect(await fatalReasons(rows('A,ADA,S,,,X,,'))).toEqual([
      'row has 8 cells, header has 9',
    ])
    expect(await fatalReasons(rows('A,ADA,S,,,X,,,,extra'))).toEqual([
      'row has 10 cells, header has 9',
    ])
  })

  it('degrades a malformed terms.csv to a warning', async () => {
    const v = await validateTemplate(
      await makeTemplate({ index: rows('A,ADA,S,,,X,,,'), terms: 'term,translation\n"open,x\n' })
    )
    expect(v.fatalErrors).toEqual([])
    expect(v.terms).toBeUndefined()
    expect(v.warnings[0].reason).toContain('terms.csv is malformed')
  })
})

describe('refAudio resolution', () => {
  it('normalizes a path that re-enters audio/ from above', async () => {
    expect(relUnderAudio('/tpl/audio', '../audio/vo/x.wav')).toBe('vo/x.wav')
    expect(relUnderAudio('/tpl/audio', 'vo/../vo/x.wav')).toBe('vo/x.wav')
    expect(relUnderAudio('/tpl/audio', 'vo\\x.wav')).toBe('vo/x.wav')
    expect(relUnderAudio('/tpl/audio', '../secret.wav')).toBeNull()
    expect(relUnderAudio('/tpl/audio', '.')).toBeNull()
    expect(relUnderAudio('/tpl/audio', '')).toBeNull()
  })

  it('resolves a re-entering refAudio against the copied reference root', async () => {
    const dir = await makeTemplate({ index: rows('A,ADA,S,,../audio/vo/a.wav,X,,,') })
    await fs.mkdir(path.join(dir, 'audio', 'vo'), { recursive: true })
    await fs.writeFile(path.join(dir, 'audio', 'vo', 'a.wav'), 'RIFFstub')
    const v = await validateTemplate(dir)
    expect(v.fatalErrors).toEqual([])
    expect(v.rows[0].refRel).toBe('vo/a.wav')
    const base = buildProjectBase(v, path.join('/refs'))
    expect(base.cues[0].referenceAudio?.relPath).toBe(path.join('/refs', 'vo/a.wav'))
  })

  it('warns once when audio/ is missing entirely', async () => {
    const dir = path.join(H.root, `noaudio-${seq++}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'project-meta.json'), META)
    await fs.writeFile(path.join(dir, 'terms.csv'), 'term,translation,note\n')
    await fs.writeFile(path.join(dir, 'index.csv'), rows('A,ADA,S,,vo/a.wav,X,,,'))
    const v = await validateTemplate(dir)
    expect(v.fatalErrors).toEqual([])
    expect(v.warnings.filter((w) => w.reason === 'audio/ directory is missing')).toHaveLength(1)
    expect(v.rows[0].missingAudio).toBe(true)
  })

  it('rejects a refAudio that resolves through a directory link out of audio/', async () => {
    const dir = await makeTemplate({ index: rows('A,ADA,S,,vo/a.wav,X,,,') })
    const outside = path.join(H.root, `outside-${seq++}`)
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, 'a.wav'), 'RIFFstub')
    try {
      await fs.symlink(outside, path.join(dir, 'audio', 'vo'), 'junction')
    } catch {
      return
    }
    const v = await validateTemplate(dir)
    expect(v.fatalErrors.map((e) => e.reason)).toEqual([
      'refAudio "vo/a.wav" resolves through a link outside audio/',
    ])
  })

  it('accepts a link that stays inside audio/', async () => {
    const dir = await makeTemplate({ index: rows('A,ADA,S,,link/a.wav,X,,,') })
    await fs.mkdir(path.join(dir, 'audio', 'real'), { recursive: true })
    await fs.writeFile(path.join(dir, 'audio', 'real', 'a.wav'), 'RIFFstub')
    try {
      await fs.symlink(path.join(dir, 'audio', 'real'), path.join(dir, 'audio', 'link'), 'junction')
    } catch {
      return
    }
    const v = await validateTemplate(dir)
    expect(v.fatalErrors).toEqual([])
    expect(v.rows[0].missingAudio).toBe(false)
  })
})

describe('CSV row → cue mapping', () => {
  it('maps every spec column onto the cue model', async () => {
    const base = buildProjectBase(await validateTemplate(FIXTURE), '/refs')
    expect(base.name).toBe('Sample Template')
    expect(base.exportTemplate).toBe('{exportName}.{ext}')
    expect(base.characters.map((c) => c.id)).toEqual(['ADA', 'Alien'])
    expect(base.characters.every((c) => c.provider.voiceId === '')).toBe(true)

    const byKey = new Map(base.cues.map((c) => [c.key, c]))
    const first = byKey.get('VO_ADA_001')!
    expect(first.characterId).toBe('ADA')
    expect(first.sourceText).toBe('Welcome back, pioneer.')
    expect(first.text).toBe('З поверненням, піонере.')
    expect(first.status).toBe('translated')
    expect(first.referenceDuration).toBe(2.4)
    expect(first.referenceAudio).toEqual({
      fileId: 'VO_ADA_001',
      relPath: path.join('/refs', 'vo/ada_001.wav'),
      format: 'wav',
    })
    expect(first.fields['exportName']).toBe('VO_ADA_001')

    const untranslated = byKey.get('VO_ADA_002')!
    expect(untranslated.status).toBe('empty')
    expect(untranslated.referenceAudio).toBeUndefined()
    expect(untranslated.notes).toBe('Missing reference audio: vo/ada_002.wav\nneeds a warmer read')

    const ogg = byKey.get('VO_ADA_004')!
    expect(ogg.referenceAudio?.format).toBe('ogg')

    const excluded = byKey.get('VO_MISC_005')!
    expect(excluded.status).toBe('excluded')
    expect(excluded.characterId).toBe('')
    expect(excluded.referenceAudio).toBeUndefined()
  })

  it('exportTemplate resolves to the exportName column', async () => {
    const base = buildProjectBase(await validateTemplate(FIXTURE), '/refs')
    const project = { ...base, id: 'p', schemaVersion: 1, createdAt: '' } as Project
    const cue = project.cues[0]
    const take = { file: { format: 'mp3' } } as Parameters<typeof exportName>[2]
    expect(exportName(project, cue, take)).toBe('VO_ADA_001.mp3')
  })
})

describe('terms', () => {
  it('sanitizes rows and drops incomplete ones', () => {
    expect(
      sanitizeTerms([
        { term: ' Ferrofluid ', translation: ' ферофлюїд ', note: ' uncountable ' },
        { term: 'only-term', translation: '' },
        { term: '', translation: 'only-translation' },
        { term: 'pioneer', translation: 'піонер', note: '' },
        'nonsense',
        null,
      ])
    ).toEqual([
      { term: 'Ferrofluid', translation: 'ферофлюїд', note: 'uncountable' },
      { term: 'pioneer', translation: 'піонер' },
    ])
  })

  it('is absent until used', () => {
    expect(sanitizeTerms([])).toBeUndefined()
    expect(sanitizeTerms(undefined)).toBeUndefined()
    expect(sanitizeTerms([{ term: '', translation: '' }])).toBeUndefined()
  })

  it('survives a serialization roundtrip', async () => {
    const base = buildProjectBase(await validateTemplate(FIXTURE), '/refs')
    const roundtripped = JSON.parse(JSON.stringify(base)) as typeof base
    expect(roundtripped.terms).toEqual(base.terms)
    expect(sanitizeTerms(roundtripped.terms)).toEqual(base.terms)
  })

  it('leaves old data untouched — no terms key without a glossary', async () => {
    const dir = await makeTemplate({ index: rows('A,ADA,S,,,X,,,'), terms: null })
    const base = buildProjectBase(await validateTemplate(dir), '/refs')
    expect('terms' in base).toBe(false)
    expect(JSON.stringify(base)).not.toContain('terms')
  })
})

describe('createProjectFromTemplate', () => {
  it('creates a self-contained project and copies reference audio into it', async () => {
    const project = await createProjectFromTemplate(await validateTemplate(FIXTURE))
    const dir = path.join(H.root, 'VOStudio', 'Sample Template.vostudio')
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf-8')) as Project

    expect(project.name).toBe('Sample Template')
    expect(saved.cues).toHaveLength(5)
    expect(saved.terms).toHaveLength(2)
    expect(saved.media.referenceDir).toBe(path.join(dir, 'audio', 'reference'))
    expect(await fs.readdir(path.join(dir, 'audio', 'reference', 'vo'))).toEqual([
      'ada_001.wav',
      'ada_004.ogg',
      'alien_003.mp3',
    ])
    for (const cue of saved.cues) {
      if (cue.referenceAudio) expect(cue.referenceAudio.relPath.startsWith(dir)).toBe(true)
    }
  })

  it('reports an existing project folder as fatal at validation', async () => {
    const v = await validateTemplate(FIXTURE)
    expect(v.fatalErrors.map((e) => e.reason)).toContain('Project "Sample Template" already exists')
    expect(toPreview(v).fatalErrors.length).toBeGreaterThan(0)
    await expect(createProjectFromTemplate(v)).rejects.toThrow('import blocked')
  })

  it('sanitizes terms on open and leaves a project without them byte-identical', async () => {
    const store = await import('../src/main/project-store')
    const dir = path.join(H.root, 'VOStudio', 'Sample Template.vostudio')
    const file = path.join(dir, 'project.json')
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
    raw['terms'] = [{ term: ' Ferrofluid ', translation: 'ферофлюїд' }, { term: '', translation: 'x' }]
    await fs.writeFile(file, JSON.stringify(raw, null, 2))
    expect((await store.openProjectDir(dir)).terms).toEqual([
      { term: 'Ferrofluid', translation: 'ферофлюїд' },
    ])

    delete raw['terms']
    const byteIdentical = JSON.stringify(raw, null, 2)
    await fs.writeFile(file, byteIdentical)
    const reopened = await store.openProjectDir(dir)
    expect('terms' in reopened).toBe(false)
    expect(await fs.readFile(file, 'utf-8')).toBe(byteIdentical)
  })

  it('refuses a template with fatal errors', async () => {
    const dir = await makeTemplate({ index: rows('A,ADA,S,,,X,,,', 'A,ADA,S,,,Y,,,') })
    await expect(createProjectFromTemplate(await validateTemplate(dir))).rejects.toThrow('import blocked')
  })
})
