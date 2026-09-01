import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildReferenceIndex, characterFromEventName, convert } from '../scripts/convert-satisfactory.ts'
import { parseCsv } from '../src/shared/csv'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-convert-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const { validateTemplate } = await import('../src/main/template-import')

const MASTER_CSV = path.join(__dirname, 'fixtures', 'sample_vo_table.csv')
const AUDIO_DIR = path.join(H.root, 'original_audio')
const OUT_DIR = path.join(H.root, 'satisfactory-ua.vostudio-src')

const master = parseCsv(await fs.readFile(MASTER_CSV, 'utf-8'))
const masterRow = (index: number): Record<string, string> => {
  const out: Record<string, string> = {}
  master.headers.forEach((h, i) => (out[h] = master.rows[index][i] ?? ''))
  return out
}

const withAudio = [masterRow(0), masterRow(1), masterRow(2)]
mkdirSync(AUDIO_DIR, { recursive: true })
await Promise.all(
  withAudio.map((row) => fs.writeFile(path.join(AUDIO_DIR, `${row['EventName']}__${row['WemId']}.wav`), 'RIFFstub'))
)

const result = await convert({ csv: MASTER_CSV, audio: AUDIO_DIR, out: OUT_DIR })

afterAll(async () => {
  await fs.rm(H.root, { recursive: true, force: true })
})

describe('convert-satisfactory', () => {
  it('emits the full canonical template structure', async () => {
    expect((await fs.readdir(OUT_DIR)).sort()).toEqual(['audio', 'index.csv', 'project-meta.json', 'terms.csv'])
    expect(JSON.parse(await fs.readFile(path.join(OUT_DIR, 'project-meta.json'), 'utf-8'))).toEqual({
      formatVersion: 1,
      name: 'satisfactory-ua',
      sourceLang: 'en',
      targetLang: 'uk',
    })
    expect(await fs.readFile(path.join(OUT_DIR, 'terms.csv'), 'utf-8')).toBe('term,translation,note\r\n')
  })

  it('copies only the reference audio it matched by WemId', async () => {
    expect((await fs.readdir(path.join(OUT_DIR, 'audio'))).sort()).toEqual(
      withAudio.map((row) => `${row['EventName']}__${row['WemId']}.wav`).sort()
    )
    expect(result.withAudio).toBe(3)
    expect(result.missingAudio).toBe(result.cues - 3)
    expect(result.skipped).toBe(0)
  })

  it('maps the Satisfactory columns onto the canonical ones', async () => {
    const index = parseCsv(await fs.readFile(path.join(OUT_DIR, 'index.csv'), 'utf-8'))
    expect(index.headers).toEqual([
      'cueId',
      'character',
      'sourceText',
      'translation',
      'refAudio',
      'exportName',
      'status',
      'durationHint',
      'note',
      'EventName',
    ])
    expect(index.rows).toHaveLength(result.cues)

    const source = masterRow(0)
    const converted = Object.fromEntries(index.headers.map((h, i) => [h, index.rows[0][i]]))
    expect(converted['cueId']).toBe(source['WemId'])
    expect(converted['sourceText']).toBe(source['Transcript'])
    expect(converted['translation']).toBe(source['UkrText'])
    expect(converted['exportName']).toBe(`${source['EventName']}__${source['WemId']}`)
    expect(converted['refAudio']).toBe(`${source['EventName']}__${source['WemId']}.wav`)
    expect(converted['durationHint']).toBe(source['AudioDuration'])
    expect(converted['character']).toBe(characterFromEventName(source['EventName']))
    expect(converted['EventName']).toBe(source['EventName'])

    const statuses = new Set(index.rows.map((r) => r[index.headers.indexOf('status')]))
    expect([...statuses].sort()).toEqual(['', 'excluded'])
    const noMatchRow = master.rows.findIndex((r) => r[master.headers.indexOf('Status')] === 'no_match')
    const noMatchId = master.rows[noMatchRow][master.headers.indexOf('WemId')]
    const emitted = index.rows.find((r) => r[0] === noMatchId)!
    expect(emitted[index.headers.indexOf('status')]).toBe('excluded')
  })

  it('routes characters from EventName', () => {
    expect(characterFromEventName('VO_ADA_Line_001')).toBe('ADA')
    expect(characterFromEventName('Play_SamOre_Whispers')).toBe('Alien')
    expect(characterFromEventName('Play_Alien_Chatter')).toBe('Alien')
    expect(characterFromEventName('VO_Operator_Line_000')).toBe('ADA')
  })

  it('indexes reference audio by the WemId suffix only', async () => {
    const index = await buildReferenceIndex(AUDIO_DIR)
    expect(index.size).toBe(3)
    expect(index.get(withAudio[0]['WemId'])).toBe(`${withAudio[0]['EventName']}__${withAudio[0]['WemId']}.wav`)
    expect(await buildReferenceIndex(path.join(H.root, 'nope'))).toEqual(new Map())
  })

  it('rejects an --out folder without the template suffix', async () => {
    await expect(
      convert({ csv: MASTER_CSV, audio: AUDIO_DIR, out: path.join(H.root, 'plain-folder') })
    ).rejects.toThrow('.vostudio-src')
    await expect(
      convert({ csv: MASTER_CSV, audio: AUDIO_DIR, out: path.join(H.root, 'Xvostudio-src') })
    ).rejects.toThrow('.vostudio-src')
    await expect(
      convert({ csv: MASTER_CSV, audio: AUDIO_DIR, out: path.join(H.root, '.vostudio-src') })
    ).rejects.toThrow('.vostudio-src')
  })

  it('produces a template the app validator accepts', async () => {
    const validation = await validateTemplate(OUT_DIR)
    expect(validation.fatalErrors).toEqual([])
    expect(validation.rows).toHaveLength(result.cues)
    expect(validation.meta?.name).toBe('satisfactory-ua')
    expect(validation.rows.filter((r) => !r.missingAudio && r.refAudio).length).toBe(3)
    expect(validation.warnings.every((w) => w.reason.includes('terms.csv') || w.reason.includes('not found'))).toBe(true)
  })
})
