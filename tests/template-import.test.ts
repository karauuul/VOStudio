import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { sanitizeTerms, type Project } from '../src/shared/domain'
import { exportName } from '../src/shared/export-plan'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-template-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const { buildProjectBase, createProjectFromTemplate, toPreview, validateTemplate } = await import(
  '../src/main/template-import'
)

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

  it('refuses to overwrite an existing project folder', async () => {
    await expect(createProjectFromTemplate(await validateTemplate(FIXTURE))).rejects.toThrow(
      'Project "Sample Template" already exists'
    )
  })

  it('refuses a template with fatal errors', async () => {
    const dir = await makeTemplate({ index: rows('A,ADA,S,,,X,,,', 'A,ADA,S,,,Y,,,') })
    await expect(createProjectFromTemplate(await validateTemplate(dir))).rejects.toThrow('import blocked')
  })
})
