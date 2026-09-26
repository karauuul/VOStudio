import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateRawSync } from 'zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseTableFile,
  TABLE_COLUMNS_MAX,
  TABLE_FILE,
  TABLE_ROWS_MAX,
  TOO_MANY_COLUMNS,
  TOO_MANY_ROWS,
} from '../src/shared/import-table'

const inflateLimits = vi.hoisted(() => [] as number[])

vi.mock('zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('zlib')>()
  return {
    ...zlib,
    inflateRawSync: (data: Buffer, options: { maxOutputLength: number }) => {
      inflateLimits.push(options.maxOutputLength)
      return zlib.inflateRawSync(data, options)
    },
  }
})

import { readXlsx } from '../src/main/xlsx'
import { readTable } from '../src/main/table-import'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Entry {
  name: string
  data: string | Buffer
  deflate?: boolean
  flags?: number
  method?: number
  size?: number
  localExtra?: number
}

function zip(entries: Entry[], comment = ''): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const raw = Buffer.from(entry.data)
    const body = entry.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(entry.name)
    const flags = entry.flags ?? 0
    const method = entry.method ?? (entry.deflate ? 8 : 0)
    const size = entry.size ?? raw.length
    const described = (flags & 8) !== 0
    const local = Buffer.alloc(30 + name.length + (entry.localExtra ?? 0))
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(described ? 0 : crc32(raw), 14)
    local.writeUInt32LE(described ? 0 : body.length, 18)
    local.writeUInt32LE(described ? 0 : size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(entry.localExtra ?? 0, 28)
    name.copy(local, 30)
    const descriptor = Buffer.alloc(described ? 16 : 0)
    if (described) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc32(raw), 4)
      descriptor.writeUInt32LE(body.length, 8)
      descriptor.writeUInt32LE(size, 12)
    }
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    parts.push(local, body, descriptor)
    directory.push(central)
    offset += local.length + body.length + descriptor.length
  }
  const centralDirectory = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(Buffer.byteLength(comment), 20)
  return Buffer.concat([...parts, centralDirectory, end, Buffer.from(comment)])
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WORKSHEET = `${RELS}/worksheet`

const workbookXml = (sheets: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><bookViews><workbookView/></bookViews><sheets>${sheets}</sheets></workbook>`
const relsXml = (relationships: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
const relationship = (id: string, target: string, type = WORKSHEET): string =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
const sheetXml = (rows: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${RELS}"><dimension ref="A1"/><cols><col min="1" max="3" width="20"/></cols><sheetData>${rows}</sheetData><pageMargins left="0.7"/></worksheet>`
const sharedXml = (items: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${MAIN}">${items}</sst>`

function book(rows: string, shared?: string): Entry[] {
  return [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: workbookXml('<sheet name="Sheet1" sheetId="1" r:id="rId1"/>') },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml(relationship('rId1', 'worksheets/sheet1.xml')) },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows), deflate: true },
    ...(shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: sharedXml(shared) }]),
  ]
}

const CAP = 1024 * 1024
const read = (entries: Entry[], cap = CAP) => readXlsx(zip(entries), cap)
const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

describe('readXlsx cells', () => {
  it('reads shared strings with rich text runs, skipping phonetic runs', () => {
    const shared =
      '<si><t>EventName</t></si>' +
      '<si><t xml:space="preserve"> Text </t></si>' +
      '<si><r><rPr><b/><sz val="11"/><rFont val="Calibri"/></rPr><t>Hel</t></r><r><t xml:space="preserve">lo there</t></r><rPh sb="0" eb="1"><t>ハロー</t></rPh><phoneticPr fontId="1"/></si>' +
      '<si/>' +
      '<si><t>after empty</t></si>'
    const rows =
      '<row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2" spans="1:3"><c r="A2" t="s"><v>4</v></c><c r="B2" s="1" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c></row>'
    expect(read(book(rows, shared))).toEqual({
      script: false,
      headers: ['EventName', ' Text '],
      rows: [['after empty', 'Hello there']],
    })
  })

  it('reads inline, formula string, boolean, number and error cells', () => {
    const rows =
      `<row r="1">${inline('A1', 'Key')}<c r="B1" t="inlineStr"><is><r><t>Va</t></r><r><rPr><i/></rPr><t>lue</t></r></is></c></row>` +
      '<row r="2"><c r="A2" t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="b"><v>0</v></c>' +
      '<c r="D2"><v>3.5</v></c><c r="E2" t="n"><v>-2E-3</v></c><c r="F2" t="e"><v>#DIV/0!</v></c><c r="G2" s="1"><f>A1</f><v>42</v></c></row>'
    expect(read(book(rows))).toEqual({
      script: false,
      headers: ['Key', 'Value'],
      rows: [['ab', 'TRUE', 'FALSE', '3.5', '-2E-3', '#DIV/0!', '42']],
    })
  })

  it('places sparse cells by reference, fills skipped rows and drops trailing empty rows', () => {
    const rows =
      `<row r="1" spans="1:27">${inline('A1', 'id')}${inline('AA1', 'far')}</row>` +
      '<row r="3"><c r="B3"><v>7</v></c><c r="C3" s="2"/><c r="D3" t="s"/><c r="E3" t="s"><v></v></c></row>' +
      '<row r="4" s="1" customFormat="1"><c r="A4" s="1"/></row>' +
      '<row r="5"/>' +
      `<row r="6"><c r="A6" s="3"/><c r="B6" t="inlineStr"><is><t/></is></c></row>`
    const table = read(book(rows, '<si><t>not me</t></si>'))
    expect(table.headers).toHaveLength(27)
    expect(table.headers[0]).toBe('id')
    expect(table.headers[26]).toBe('far')
    expect(table.headers.slice(1, 26).every((cell) => cell === '')).toBe(true)
    expect(table.rows).toEqual([[''], ['', '7']])
  })

  it('positions rows and cells without references sequentially', () => {
    const rows = '<row><c><v>1</v></c><c><v>2</v></c></row><row><c r="B2"><v>3</v></c><c><v>4</v></c></row>'
    expect(read(book(rows))).toEqual({ script: false, headers: ['1', '2'], rows: [['', '3', '4']] })
  })

  it('decodes entities, character references, Cyrillic text and Excel escapes', () => {
    const rows =
      `<row r="1">${inline('A1', 'a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;')}${inline('B1', '&#x422;&#1077;&#x43a;&#x441;&#x442; &#x1F600;')}</row>` +
      `<row r="2"><c r="A2" t="s"><v>0</v></c>${inline('B2', 'one_x000D_\ntwo _x005F_x0041_')}<c r="C2" t="str"><v>&amp;amp;</v></c></row>`
    expect(read(book(rows, '<si><t>Слово</t></si>'))).toEqual({
      script: false,
      headers: [`a <b> & "c" 'd'`, 'Текст 😀'],
      rows: [['Слово', 'one\r\ntwo _x0041_', '&amp;']],
    })
  })

  it('refuses an empty sheet like an empty csv', () => {
    expect(() => read(book(''))).toThrow('Table has no header row')
    expect(() => read(book('<row r="1"><c r="A1" s="1"/></row>'))).toThrow('Table has no header row')
  })
})

describe('readXlsx workbook', () => {
  it('reads the first sheet in workbook order through its relationship, absolute target included', () => {
    const entries: Entry[] = [
      {
        name: 'xl/workbook.xml',
        data: workbookXml(`<sheet name="Lines" sheetId="2" r:id='rId3'/><sheet name="Old" sheetId="1" r:id="rId1"/>`),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: relsXml(
          relationship('rId1', 'worksheets/sheet1.xml') +
            relationship('rId2', 'styles.xml', `${RELS}/styles`) +
            `<Relationship Target='/xl/worksheets/sheet2.xml' Type='${WORKSHEET}' Id='rId3'/>`
        ),
      },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(`<row r="1">${inline('A1', 'Old')}</row>`) },
      { name: 'xl/worksheets/sheet2.xml', data: sheetXml(`<row r="1">${inline('A1', 'Lines')}</row>`), deflate: true },
    ]
    expect(read(entries).headers).toEqual(['Lines'])
  })

  it('reads without sharedStrings, with data descriptors, local extra fields and an archive comment', () => {
    const entries = book(`<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="s"><v>0</v></c>${inline('C1', 'x')}</row>`).map(
      (entry) => ({ ...entry, flags: 8, localExtra: 4 })
    )
    expect(readXlsx(zip(entries, 'made by a test'), CAP).headers).toEqual(['1', '', 'x'])
  })

  it('matches part names case-insensitively', () => {
    const entries = book(`<row r="1">${inline('A1', 'Case')}</row>`).map((entry) => ({
      ...entry,
      name: entry.name.replace('workbook.xml', 'Workbook.xml'),
    }))
    expect(read(entries).headers).toEqual(['Case'])
  })

  it('names the missing parts', () => {
    expect(() => read(book('').filter((entry) => entry.name !== 'xl/workbook.xml'))).toThrow('xl/workbook.xml is missing')
    expect(() => read(book('').filter((entry) => !entry.name.includes('_rels')))).toThrow('first sheet is not linked')
    expect(() => read(book('').filter((entry) => !entry.name.includes('sheet1')))).toThrow('xl/worksheets/sheet1.xml is missing')
    const noSheets = book('').map((entry) =>
      entry.name === 'xl/workbook.xml' ? { ...entry, data: workbookXml('') } : entry
    )
    expect(() => read(noSheets)).toThrow('workbook has no sheets')
  })
})

describe('readXlsx archive', () => {
  it('refuses a file that is not a zip', () => {
    expect(() => readXlsx(Buffer.from('EventName,Text\nA,b\n'), CAP)).toThrow('Not an .xlsx workbook')
    expect(() => readXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), CAP)).toThrow('password-protected')
    expect(() => readXlsx(Buffer.from('PK\x03\x04 truncated'), CAP)).toThrow('zip directory not found')
  })

  it('refuses ZIP64, encrypted entries and unknown compression', () => {
    const archive = zip(book(''))
    archive.writeUInt16LE(0xffff, archive.length - 22 + 10)
    expect(() => readXlsx(archive, CAP)).toThrow('ZIP64')
    const huge = book('').map((entry) => (entry.name === 'xl/workbook.xml' ? { ...entry, size: 0xffffffff } : entry))
    expect(() => read(huge)).toThrow('ZIP64')
    const locked = book('').map((entry) => (entry.name === 'xl/workbook.xml' ? { ...entry, flags: 1 } : entry))
    expect(() => read(locked)).toThrow('Encrypted')
    const bzip = book('').map((entry) => (entry.name === 'xl/workbook.xml' ? { ...entry, method: 12 } : entry))
    expect(() => read(bzip)).toThrow('compression method 12')
  })

  it('refuses corrupt deflate data and sizes that disagree with the directory', () => {
    const broken = book('').map((entry) =>
      entry.name === 'xl/worksheets/sheet1.xml' ? { ...entry, deflate: false, method: 8, data: Buffer.from([0xff, 0xff, 0xff]) } : entry
    )
    expect(() => read(broken)).toThrow('xl/worksheets/sheet1.xml is corrupt')
    const short = book('').map((entry) => (entry.name === 'xl/workbook.xml' ? { ...entry, size: 10 } : entry))
    expect(() => read(short)).toThrow('xl/workbook.xml is corrupt')
  })

  it('stops at the unpacked size cap before inflating', () => {
    const big = `<row r="1">${inline('A1', 'x'.repeat(200_000))}</row>`
    inflateLimits.length = 0
    expect(() => read(book(big), 100_000)).toThrow('larger than')
    expect(inflateLimits).toEqual([])
  })

  it('counts every part against one cap', () => {
    const entries = book(`<row r="1">${inline('A1', 'x'.repeat(60_000))}</row>`, `<si><t>${'y'.repeat(60_000)}</t></si>`)
    expect(read(entries, 200_000).headers[0]).toHaveLength(60_000)
    expect(() => read(entries, 100_000)).toThrow('larger than')
  })

  it('never inflates past the declared size of a lying entry', () => {
    const lying = book(`<row r="1">${inline('A1', 'x'.repeat(5_000_000))}</row>`).map((entry) =>
      entry.name === 'xl/worksheets/sheet1.xml' ? { ...entry, size: 1000 } : entry
    )
    inflateLimits.length = 0
    expect(() => read(lying, 1_000_000)).toThrow('xl/worksheets/sheet1.xml is corrupt')
    expect(inflateLimits).toEqual([1000])
  })
})

describe('readXlsx table bounds', () => {
  it('rejects rows and columns past the table limits with the csv errors, without padding first', () => {
    expect(() => parseTableFile('big.csv', `Text\n${'x\n'.repeat(TABLE_ROWS_MAX + 1)}`)).toThrow(TOO_MANY_ROWS)
    expect(() => parseTableFile('wide.csv', `${','.repeat(TABLE_COLUMNS_MAX)}\n`)).toThrow(TOO_MANY_COLUMNS)
    expect(() => read(book(`<row r="1">${inline('A1', 'Text')}</row><row r="1048576"><c r="A1048576"><v>1</v></c></row>`))).toThrow(
      TOO_MANY_ROWS
    )
    expect(() => read(book(`<row r="1">${inline('FAO1', 'wide')}</row>`))).toThrow(TOO_MANY_COLUMNS)
    expect(() => read(book(`<row r="1">${inline('A1', 'Text')}</row><row r="2">${inline('XFD2', 'wide')}</row>`))).toThrow(
      TOO_MANY_COLUMNS
    )
  })

  it('accepts exactly the row and column limits', () => {
    const last = TABLE_ROWS_MAX + 1
    const table = read(book(`<row r="1">${inline('FAN1', 'last')}</row><row r="${last}"><c r="A${last}"><v>1</v></c></row>`))
    expect(table.headers).toHaveLength(TABLE_COLUMNS_MAX)
    expect(table.rows).toHaveLength(TABLE_ROWS_MAX)
    expect(table.rows[TABLE_ROWS_MAX - 1]).toEqual(['1'])
  })

  it('caps the cells that sparse references would pad', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `<row r="${i + 1}"><c r="FAN${i + 1}"><v>1</v></c></row>`).join('')
    expect(read(book(rows), 30_000).rows).toHaveLength(4)
    expect(() => read(book(rows), 10_000)).toThrow('more than 10000 cells')
  })
})

describe('readTable xlsx', () => {
  let sandbox: string | undefined

  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
    sandbox = undefined
  })

  it('routes .xlsx as a table file', () => {
    expect(TABLE_FILE.test('/lines.xlsx')).toBe(true)
    expect(TABLE_FILE.test('C:\\Lines.XLSX')).toBe(true)
    expect(TABLE_FILE.test('/lines.xls')).toBe(false)
  })

  it('reads an .xlsx into the same table as the equivalent csv', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'vostudio-xlsx-'))
    const csvPath = join(sandbox, 'lines.csv')
    const xlsxPath = join(sandbox, 'lines.xlsx')
    await writeFile(csvPath, 'EventName,Text,Character\r\nA1,"Hello, world",Bo\r\n\r\nB2,Текст\r\n')
    const shared = '<si><t>EventName</t></si><si><t>Text</t></si><si><t>Character</t></si><si><t>Hello, world</t></si>'
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      `<row r="2">${inline('A2', 'A1')}<c r="B2" t="s"><v>3</v></c>${inline('C2', 'Bo')}</row>` +
      `<row r="4">${inline('A4', 'B2')}${inline('B4', 'Текст')}<c r="C4" s="1"/></row>` +
      '<row r="5"><c r="A5" s="1"/></row>'
    await writeFile(xlsxPath, zip(book(rows, shared)))
    const fromCsv = await readTable(csvPath)
    const fromXlsx = await readTable(xlsxPath)
    expect(fromXlsx.path).toBe(xlsxPath)
    expect({ ...fromXlsx, path: '' }).toEqual({ ...fromCsv, path: '' })
    expect(fromXlsx.rows).toEqual([['A1', 'Hello, world', 'Bo'], [''], ['B2', 'Текст']])
  })

  it('refuses a text file named .xlsx instead of reading it as csv', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'vostudio-xlsx-'))
    const fake = join(sandbox, 'fake.xlsx')
    await writeFile(fake, 'EventName,Text\nA,b\n')
    await expect(readTable(fake)).rejects.toThrow('Not an .xlsx workbook')
  })
})
