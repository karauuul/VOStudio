import path from 'path'
import { inflateRawSync } from 'zlib'
import {
  headedTable,
  TABLE_CELLS_MAX,
  TABLE_COLUMNS_MAX,
  TABLE_ROWS_MAX,
  TOO_MANY_COLUMNS,
  TOO_MANY_ROWS,
  type TableFile,
} from '@shared/import-table'

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const END_OF_CENTRAL_SIZE = 22
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff
const STORED = 0
const DEFLATED = 8

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  size: number
  offset: number
}

const invalid = (reason: string): Error => new Error(`Invalid .xlsx: ${reason}`)
const zip64 = (): Error => new Error('ZIP64 .xlsx files are not supported')

function endOfCentral(zip: Buffer): number {
  const last = Math.max(0, zip.length - END_OF_CENTRAL_SIZE - U16_MAX)
  for (let at = zip.length - END_OF_CENTRAL_SIZE; at >= last; at--) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL) return at
  }
  throw invalid('zip directory not found')
}

function centralDirectory(zip: Buffer): Map<string, ZipEntry> {
  const end = endOfCentral(zip)
  const count = zip.readUInt16LE(end + 10)
  const size = zip.readUInt32LE(end + 12)
  let at = zip.readUInt32LE(end + 16)
  if (count === U16_MAX || size === U32_MAX || at === U32_MAX) throw zip64()
  const stop = at + size
  if (stop > end) throw invalid('corrupt zip directory')
  const entries = new Map<string, ZipEntry>()
  for (let i = 0; i < count; i++) {
    if (at + 46 > stop || zip.readUInt32LE(at) !== CENTRAL_HEADER) throw invalid('corrupt zip directory')
    const nameEnd = at + 46 + zip.readUInt16LE(at + 28)
    const name = zip.toString('utf8', at + 46, nameEnd)
    entries.set(name.toLowerCase(), {
      name,
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    })
    at = nameEnd + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return entries
}

function inflate(entry: ZipEntry, data: Buffer): Buffer {
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
  } catch {
    throw invalid(`${entry.name} is corrupt`)
  }
}

function extract(zip: Buffer, entry: ZipEntry, budget: number, cap: number): Buffer {
  if (entry.flags & 1) throw new Error('Encrypted .xlsx files are not supported')
  if (entry.compressedSize === U32_MAX || entry.size === U32_MAX || entry.offset === U32_MAX) throw zip64()
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`Unsupported .xlsx compression method ${entry.method}`)
  }
  if (entry.size > budget) throw new Error(`Table is larger than ${cap / 1024 / 1024} MB unpacked`)
  const header = entry.offset
  if (header + 30 > zip.length || zip.readUInt32LE(header) !== LOCAL_HEADER) throw invalid(`${entry.name} is corrupt`)
  const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28)
  const data = zip.subarray(start, start + entry.compressedSize)
  if (data.length !== entry.compressedSize) throw invalid(`${entry.name} is corrupt`)
  const out = entry.method === STORED ? data : inflate(entry, data)
  if (out.length !== entry.size) throw invalid(`${entry.name} is corrupt`)
  return out
}

function zipParts(zip: Buffer, cap: number): (name: string) => string | undefined {
  const entries = centralDirectory(zip)
  let budget = cap
  return (name) => {
    const entry = entries.get(name.toLowerCase())
    if (!entry) return undefined
    const data = extract(zip, entry, budget, cap)
    budget -= data.length
    return data.toString('utf8')
  }
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const decodeXml = (text: string): string =>
  text.replace(/&(?:#x([\da-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g, (match, hex?: string, dec?: string, name?: string) => {
    if (name) return XML_ENTITIES[name]
    const code = hex ? Number.parseInt(hex, 16) : Number(dec)
    return code <= 0x10ffff ? String.fromCodePoint(code) : match
  })

const decodeExcelEscapes = (text: string): string =>
  text.replace(/_x([\da-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

function textAfter(xml: string, from: number): string {
  const end = xml.indexOf('<', from)
  return decodeExcelEscapes(decodeXml(xml.slice(from, end < 0 ? xml.length : end)))
}

const tags = (names: string): RegExp => new RegExp(`<(/?)(${names})(?=[\\s/>])([^<>]*)>`, 'g')
const attribute = (name: string): RegExp => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)

const SHEET_TAGS = tags('sheet')
const RELATIONSHIP_TAGS = tags('Relationship')
const SHARED_STRING_TAGS = tags('si|t|rPh')
const CELL_TAGS = tags('row|c|v|t|rPh')
const REF = attribute('r')
const TYPE = attribute('t')
const RELATION_ID = attribute('[\\w.-]+:id')
const ID = attribute('Id')
const TARGET = attribute('Target')

function attr(attrs: string, pattern: RegExp): string {
  const match = pattern.exec(attrs)
  return match ? decodeXml(match[1] ?? match[2]) : ''
}

function sharedStrings(xml: string): string[] {
  const strings: string[] = []
  let current = ''
  let phonetic = false
  for (const match of xml.matchAll(SHARED_STRING_TAGS)) {
    const [tag, closing, name, attrs] = match
    const empty = attrs.endsWith('/')
    if (name === 'rPh') phonetic = !closing && !empty
    else if (name === 't') {
      if (!closing && !empty && !phonetic) current += textAfter(xml, match.index + tag.length)
    } else if (closing || empty) {
      strings.push(current)
      current = ''
    } else current = ''
  }
  return strings
}

function rowIndex(ref: string, previous: number): number {
  const n = Number(ref)
  return Number.isInteger(n) && n > 0 ? n - 1 : previous + 1
}

function columnIndex(ref: string, previous: number): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0]
  if (!letters) return previous + 1
  let n = 0
  for (const letter of letters.toUpperCase()) n = n * 26 + letter.charCodeAt(0) - 64
  return n - 1
}

function cellText(type: string, value: string, inline: string, shared: string[]): string {
  if (type === 's') return shared[Number.parseInt(value, 10)] ?? ''
  if (type === 'inlineStr') return inline
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
  return value
}

function sheetRows(xml: string, shared: string[], cellLimit: number): string[][] {
  const start = xml.indexOf('<sheetData')
  const end = xml.indexOf('</sheetData>', start)
  const body = start < 0 || end < 0 ? '' : xml.slice(start, end)
  const rows: string[][] = []
  let cells: string[] = []
  let row = -1
  let column = -1
  let type = ''
  let value = ''
  let inline = ''
  let phonetic = false
  let total = 0
  for (const match of body.matchAll(CELL_TAGS)) {
    const [tag, closing, name, attrs] = match
    const open = !closing
    const empty = attrs.endsWith('/')
    if (name === 'row') {
      if (open) {
        row = rowIndex(attr(attrs, REF), row)
        cells = []
        column = -1
      }
      if ((closing || empty) && cells.length > 0) {
        if (row > TABLE_ROWS_MAX) throw new Error(TOO_MANY_ROWS)
        while (rows.length < row) rows.push([''])
        rows[row] = cells
      }
    } else if (name === 'c') {
      if (open) {
        column = columnIndex(attr(attrs, REF), column)
        type = attr(attrs, TYPE)
        value = ''
        inline = ''
      }
      const text = closing || empty ? cellText(type, value, inline, shared) : ''
      if (text) {
        if (column >= TABLE_COLUMNS_MAX) throw new Error(TOO_MANY_COLUMNS)
        total += Math.max(0, column + 1 - cells.length)
        if (total > cellLimit) throw new Error(`Table has more than ${cellLimit} cells`)
        while (cells.length < column) cells.push('')
        cells[column] = text
      }
    } else if (name === 'rPh') phonetic = open && !empty
    else if (open && !empty && name === 'v') value = textAfter(body, match.index + tag.length)
    else if (open && !empty && !phonetic) inline += textAfter(body, match.index + tag.length)
  }
  return rows
}

export function readXlsx(file: Buffer, cap: number, cellLimit = TABLE_CELLS_MAX): TableFile {
  if (!file.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new Error('Not an .xlsx workbook (password-protected and .xls files are not supported)')
  }
  const part = zipParts(file, cap)
  const workbook = part('xl/workbook.xml')
  if (workbook === undefined) throw invalid('xl/workbook.xml is missing')
  const [sheet] = workbook.matchAll(SHEET_TAGS)
  if (!sheet) throw invalid('workbook has no sheets')
  const id = attr(sheet[3], RELATION_ID)
  const relationship = [...(part('xl/_rels/workbook.xml.rels') ?? '').matchAll(RELATIONSHIP_TAGS)].find(
    (match) => attr(match[3], ID) === id
  )
  const target = relationship ? attr(relationship[3], TARGET) : ''
  if (!target) throw invalid('first sheet is not linked')
  const sheetPath = target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target)
  const xml = part(sheetPath)
  if (xml === undefined) throw invalid(`${sheetPath} is missing`)
  const rows = sheetRows(xml, sharedStrings(part('xl/sharedStrings.xml') ?? ''), cellLimit)
  const headers = rows.shift() ?? []
  const width = rows.reduce((max, cells) => Math.max(max, cells.length), headers.length)
  return headedTable(headers.length > 0 ? [...headers, ...Array<string>(width - headers.length).fill('')] : headers, rows)
}
