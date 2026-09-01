export interface ParsedCsv {
  hadBom: boolean
  newline: '\r\n' | '\n'
  trailingNewline: boolean
  headers: string[]
  rawHeader: string[]
  rows: string[][]
  rawRows: string[][]
}

export function parseCsv(raw: string): ParsedCsv {
  const hadBom = raw.charCodeAt(0) === 0xfeff
  if (hadBom) raw = raw.slice(1)
  const newline: '\r\n' | '\n' = raw.includes('\r\n') ? '\r\n' : '\n'

  const values: string[][] = []
  const raws: string[][] = []
  let cell = ''
  let rawCell = ''
  let row: string[] = []
  let rawRow: string[] = []
  let inQuotes = false
  let endedWithNewline = false

  const pushCell = () => {
    row.push(cell)
    rawRow.push(rawCell)
    cell = ''
    rawCell = ''
  }
  const pushRow = () => {
    pushCell()
    values.push(row)
    raws.push(rawRow)
    row = []
    rawRow = []
  }

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inQuotes) {
      rawCell += c
      if (c === '"') {
        if (raw[i + 1] === '"') {
          cell += '"'
          rawCell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += c
      }
    } else if (c === '"') {
      inQuotes = true
      rawCell += c
    } else if (c === ',') {
      pushCell()
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && raw[i + 1] === '\n') i++
      pushRow()
      endedWithNewline = i === raw.length - 1
    } else {
      cell += c
      rawCell += c
    }
  }
  if (cell.length > 0 || rawCell.length > 0 || row.length > 0) {
    pushRow()
    endedWithNewline = false
  }

  const headers = values.shift() ?? []
  const rawHeader = raws.shift() ?? []
  return { hadBom, newline, trailingNewline: endedWithNewline, headers, rawHeader, rows: values, rawRows: raws }
}

export function needsQuoting(v: string): boolean {
  return v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')
}

export function serializeCell(v: string): string {
  return needsQuoting(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

export function setCell(p: ParsedCsv, rowIdx: number, colIdx: number, value: string): boolean {
  if ((p.rows[rowIdx]?.[colIdx] ?? '') === value) return false
  p.rows[rowIdx][colIdx] = value
  p.rawRows[rowIdx][colIdx] = serializeCell(value)
  return true
}

export function serializeCsv(p: ParsedCsv): string {
  const headerLine = p.rawHeader.join(',')
  const lines = [headerLine, ...p.rawRows.map((r) => r.join(','))]
  return (p.hadBom ? '﻿' : '') + lines.join(p.newline) + (p.trailingNewline ? p.newline : '')
}
