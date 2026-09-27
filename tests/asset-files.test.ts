import { execFile } from 'child_process'
import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-assets-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const { addAssets, assetAudioLines, assetPage, loadAsset } = await import('../src/main/assets')
const store = await import('../src/main/project-store')
const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string

const run = promisify(execFile)
const DROP = path.join(H.root, 'drop')
const PROJECT_DIR = path.join(H.root, 'VOStudio', 'bin.vostudio')

const tone = (file: string): Promise<unknown> =>
  run(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', file])

const base = (): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name: 'bin',
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { filter: '', search: '' },
})

beforeAll(async () => {
  await fs.mkdir(path.join(DROP, 'vo', 'ada'), { recursive: true })
  await tone(path.join(DROP, 'vo', 'ada', 'ada_001.wav'))
  await tone(path.join(DROP, 'vo', 'hit.wav'))
  await fs.writeFile(path.join(DROP, 'vo', 'music.flac'), 'not really flac')
  await fs.writeFile(path.join(DROP, 'vo', '.DS_Store'), 'x')
  await fs.writeFile(path.join(DROP, 'lines.csv'), 'cueId,sourceText\nVO_ADA_001,Welcome back\n')
  await fs.writeFile(path.join(DROP, 'subs.srt'), '1\n00:00:01,000 --> 00:00:02,000\nADA: Welcome back\n')
  await fs.writeFile(path.join(DROP, 'dump.json'), '{"lines":[{"id":"a","en":"Hi"}]}')
  await fs.writeFile(path.join(DROP, 'strings.locres'), 'first\nsecond\n')
})

afterAll(async () => {
  await fs.rm(H.root, { recursive: true, force: true })
})

describe('addAssets', () => {
  it('keeps media in place, copies the rest, counts rows and skips hidden files and duplicates', async () => {
    await fs.mkdir(PROJECT_DIR, { recursive: true })
    const first = await addAssets([], PROJECT_DIR, [DROP])
    const byName = new Map(first.added.map((a) => [a.name, a]))
    expect([...byName.keys()].sort()).toEqual([
      'drop/dump.json',
      'drop/lines.csv',
      'drop/strings.locres',
      'drop/subs.srt',
      'drop/vo/ada/ada_001.wav',
      'drop/vo/hit.wav',
      'drop/vo/music.flac',
    ])
    const wav = byName.get('drop/vo/ada/ada_001.wav')!
    expect(wav).toMatchObject({ kind: 'audio', file: { relPath: path.join(DROP, 'vo', 'ada', 'ada_001.wav') } })
    expect(wav.duration).toBeCloseTo(1, 1)
    const csv = byName.get('drop/lines.csv')!
    expect(csv).toMatchObject({ kind: 'table', rows: 1, file: { fileId: 'lines.csv', relPath: path.join(PROJECT_DIR, 'assets', 'lines.csv') } })
    expect(byName.get('drop/subs.srt')).toMatchObject({ kind: 'subtitles', rows: 1 })
    expect(byName.get('drop/strings.locres')).toMatchObject({ kind: 'other' })
    expect(byName.get('drop/strings.locres')).not.toHaveProperty('rows')
    const again = await addAssets(first.added, PROJECT_DIR, [DROP, path.join(DROP, 'lines.csv')])
    expect(again.added).toEqual([])
    expect(again.skipped.every((s) => s.reason === 'already in the bin')).toBe(true)
    const renamed = await addAssets([], PROJECT_DIR, [path.join(DROP, 'lines.csv')])
    expect(renamed.added[0].file.relPath).toBe(path.join(PROJECT_DIR, 'assets', 'lines (2).csv'))
  })

  it('tells same-named copies of equal size apart by content and still skips a true re-add', async () => {
    const locales = path.join(H.root, 'locales')
    const dir = path.join(H.root, 'VOStudio', 'locales.vostudio')
    await fs.mkdir(path.join(locales, 'en'), { recursive: true })
    await fs.mkdir(path.join(locales, 'fr'), { recursive: true })
    await fs.writeFile(path.join(locales, 'en', 'strings.csv'), 'id,text\nA,Hello\n')
    await fs.writeFile(path.join(locales, 'fr', 'strings.csv'), 'id,text\nA,Salut\n')
    const first = await addAssets([], dir, [locales])
    expect(first.added.map((a) => [a.name, a.file.fileId])).toEqual([
      ['locales/en/strings.csv', 'strings.csv'],
      ['locales/fr/strings.csv', 'strings (2).csv'],
    ])
    const again = await addAssets(first.added, dir, [path.join(locales, 'en', 'strings.csv')])
    expect(again).toEqual({ added: [], skipped: [{ name: 'strings.csv', reason: 'already in the bin' }] })
  })

  it('leaves audio and video of a dropped folder to the line import when asked to skip media', async () => {
    const { added } = await addAssets([], path.join(H.root, 'skip.vostudio'), [DROP], true)
    expect(added.map((a) => a.name).sort()).toEqual(['drop/dump.json', 'drop/lines.csv', 'drop/strings.locres', 'drop/subs.srt'])
  })

  it('reads each kind the way the agent sees it', async () => {
    const { added } = await addAssets([], PROJECT_DIR, [path.join(DROP, 'subs.srt'), path.join(DROP, 'dump.json'), path.join(DROP, 'strings.locres')])
    const [srt, json, raw] = added
    expect(await loadAsset(srt, {})).toMatchObject({ columns: ['index', 'start', 'end', 'speaker', 'text'], rows: [['1', '1', '2', 'ADA', 'Welcome back']] })
    expect(await loadAsset(json, { jsonPath: '$.lines[*]' })).toEqual({ format: 'json', columns: ['id', 'en'], rows: [['a', 'Hi']] })
    const pretty = await loadAsset(json, {})
    expect(pretty.format).toBe('json')
    expect('lines' in pretty && pretty.lines.slice(0, 2)).toEqual(['{', '  "lines": ['])
    expect(await loadAsset(raw, {})).toEqual({ format: 'locres', lines: ['first', 'second', ''] })
    await expect(loadAsset(raw, { jsonPath: '$' })).rejects.toThrow(/only applies to JSON/)
  })

  it('builds one line per audio asset, keeping the nested folder and the origin asset', async () => {
    const { added } = await addAssets([], PROJECT_DIR, [DROP])
    const project = { ...base(), id: 'p', schemaVersion: 1, createdAt: '', assets: added } as Project
    const ids = added.filter((a) => a.kind === 'audio').map((a) => a.id)
    const { result } = await assetAudioLines(project, PROJECT_DIR, [...ids, added.find((a) => a.kind === 'table')!.id])
    expect(result).toMatchObject({ added: 2, updated: 0 })
    expect(result.skipped).toEqual([
      { asset: 'drop/lines.csv', reason: 'a table asset, not audio' },
      { asset: 'drop/vo/music.flac', reason: 'could not be converted to wav' },
    ])
    expect(result).not.toHaveProperty('failed')
    await expect(fs.stat(path.join(PROJECT_DIR, 'audio', 'reference', 'drop', 'vo', 'music.wav'))).rejects.toThrow()
    const ada = project.cues.find((c) => c.key === 'ada_001')!
    expect(ada.fields).toEqual({ EventName: 'ada_001', path: 'vo/ada' })
    expect(ada.origins).toEqual([{ assetId: added.find((a) => a.name === 'drop/vo/ada/ada_001.wav')!.id }])
    expect(ada.referenceAudio?.relPath).toBe(path.join(PROJECT_DIR, 'audio', 'reference', 'drop', 'vo', 'ada', 'ada_001.wav'))
  })
})

describe('audio assets of every audio format become lines', () => {
  it('converts a flac asset to wav, so the default selection finds it built afterwards', async () => {
    const dir = path.join(H.root, 'flacs')
    await fs.mkdir(dir, { recursive: true })
    await tone(path.join(dir, 'bark_001.flac'))
    await tone(path.join(dir, 'bark_002.wav'))
    await run(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(dir, 'bark_002.flac')])
    const target = path.join(H.root, 'VOStudio', 'flacs.vostudio')
    const { added } = await addAssets([], target, [dir])
    expect(added.every((a) => a.kind === 'audio')).toBe(true)
    const project = { ...base(), id: 'p', schemaVersion: 1, createdAt: '', assets: added } as Project
    const { result } = await assetAudioLines(project, target, added.map((a) => a.id))
    expect(result).toMatchObject({ added: 2, updated: 0, skipped: [], duplicates: ['flacs/bark_002.wav'] })
    const bark = project.cues.find((c) => c.key === 'bark_001')!
    expect(bark.referenceAudio).toMatchObject({ format: 'wav', relPath: path.join(target, 'audio', 'reference', 'flacs', 'bark_001.wav') })
    expect(bark.referenceDuration).toBeCloseTo(1, 1)
    expect(bark.origins).toEqual([{ assetId: added.find((a) => a.name === 'flacs/bark_001.flac')!.id }])
  })

  it('refuses an asset whose name climbs out of the project and writes nothing', async () => {
    const target = path.join(H.root, 'VOStudio', 'crafted.vostudio')
    await fs.mkdir(target, { recursive: true })
    const src = path.join(DROP, 'vo', 'hit.wav')
    const project = {
      ...base(), id: 'p', schemaVersion: 1, createdAt: '',
      assets: [{ id: 'evil', name: '../../../../victim.wav', kind: 'audio', file: { fileId: 'hit.wav', relPath: src }, size: 1, addedAt: 'now' }],
    } as Project
    await expect(assetAudioLines(project, target, ['evil'])).rejects.toThrow(/leaves the project/)
    expect(project.cues).toEqual([])
    expect(await fs.readdir(target)).toEqual([])
    await expect(fs.stat(path.join(H.root, 'victim.wav'))).rejects.toThrow()
  })
})

describe('project.json keeps the new fields across a reopen', () => {
  it('an asset name that climbs out of the project reopens as a safe relative name', async () => {
    const dir = path.join(H.root, 'crafted-open.vostudio')
    await fs.mkdir(dir, { recursive: true })
    const { ui: _ui, ...stored } = { ...base(), id: 'p', schemaVersion: 1, createdAt: 'now' }
    const file = { fileId: 'x.wav', relPath: '/x/x.wav' }
    const assets = [
      { id: 'a1', name: '../../../victim.wav', kind: 'audio', file, size: 1, addedAt: 'now' },
      { id: 'a2', name: 'C:\\Windows\\..\\evil.csv', kind: 'table', file, size: 1, addedAt: 'now' },
      { id: 'a3', name: 'drop/vo/ok.wav', kind: 'audio', file, size: 1, addedAt: 'now' },
    ]
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...stored, assets }))
    const reopened = await store.openProjectDir(dir)
    expect(reopened.assets?.map((a) => a.name)).toEqual(['victim.wav', 'Windows/evil.csv', 'drop/vo/ok.wav'])
  })

  it('assets, proposals, origins and proposed terms survive save and open', async () => {
    const dir = path.join(H.root, 'roundtrip.vostudio')
    await fs.mkdir(dir, { recursive: true })
    const { ui: _ui, ...stored } = { ...base(), id: 'p', schemaVersion: 1, createdAt: 'now' }
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(stored))
    const project = await store.openProjectDir(dir)
    project.assets = [{ id: 'a1', name: 'subs.srt', kind: 'subtitles', file: { fileId: 'subs.srt', relPath: '/x/subs.srt' }, size: 3, addedAt: 'now', rows: 1 }]
    project.cues = [
      {
        id: 'c1', characterId: '', key: 'K', fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [],
        proposals: { character: { characterId: 'ada', confidence: 0.9, reason: 'speaker in subs.srt' } },
        origins: [{ assetId: 'a1', row: 0 }],
      },
      {
        id: 'c2', characterId: '', key: 'K2', fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [],
        proposals: { link: { assetId: '', row: 0, confidence: 1, reason: '' } } as never,
        origins: [{ row: 1 }] as never,
      },
    ]
    project.terms = [{ term: 'node', translation: 'вузол', proposed: true }]
    await store.persistProjectSnapshot(project)
    const reopened = await store.openProjectDir(dir)
    expect(reopened.assets).toEqual(project.assets)
    expect(reopened.cues[0].proposals).toEqual(project.cues[0].proposals)
    expect(reopened.cues[0].origins).toEqual([{ assetId: 'a1', row: 0 }])
    expect(reopened.cues[1]).not.toHaveProperty('proposals')
    expect(reopened.cues[1]).not.toHaveProperty('origins')
    expect(reopened.terms).toEqual([{ term: 'node', translation: 'вузол', proposed: true }])
  })

  it('pages an asset for the preview: table rows, text lines as one column, media as empty', () => {
    const table = { format: 'csv', columns: ['id', 'text'], rows: [['1', 'a'], ['2', 'b'], ['3', 'x'.repeat(1500)]] }
    expect(assetPage(table, 1, 5)).toEqual({ format: 'csv', total: 3, columns: ['id', 'text'], rows: [['2', 'b'], ['3', 'x'.repeat(1000)]] })
    expect(assetPage({ format: 'xml', lines: ['<a>', '</a>'] }, 0, 1)).toEqual({ format: 'xml', total: 2, columns: [], rows: [['<a>']] })
    expect(assetPage({ format: 'audio', duration: 2 }, 0, 10)).toEqual({ format: 'audio', total: 0, columns: [], rows: [] })
  })
})
