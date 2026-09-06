export type ExportFormatId = 'source' | 'wav-48-24' | 'wav-44-16' | 'mp3-192' | 'ogg'
export type LoudnessMode = 'match' | 'off'
export type LengthMode = 'trim' | 'pad' | 'asis'
export type VideoMode = 'copy' | 'audio'

export interface ExportSettings {
  outDir?: string
  format?: ExportFormatId
  loudness?: LoudnessMode
  length?: LengthMode
  video?: VideoMode
  videoName?: string
}

export const VIDEO_MODES: { id: VideoMode; label: string }[] = [
  { id: 'copy', label: 'Copy video, replace audio' },
  { id: 'audio', label: 'Audio only' },
]

export const DEFAULT_VIDEO_NAME = '{name}_{lang}.mp4'

export function videoMode(settings: ExportSettings | undefined): VideoMode {
  return settings?.video === 'audio' ? 'audio' : 'copy'
}

export function videoName(
  settings: ExportSettings | undefined,
  sourceName: string,
  lang: string,
  mode: VideoMode
): string {
  const pattern = settings?.videoName?.trim() || DEFAULT_VIDEO_NAME
  const base = sourceName.replace(/\.[^.]+$/, '')
  const named = pattern
    .replace(/\{name\}/g, base)
    .replace(/\{lang\}/g, lang)
    .replace(/[_-]+(?=\.[^.]*$|$)/, '')
  if (mode === 'audio') return named.replace(/\.[^.]+$/, '') + '.wav'
  return /\.[^.]+$/.test(named) ? named : named + '.mp4'
}

export interface ExportFormatSpec {
  id: ExportFormatId
  label: string
  ext?: 'wav' | 'mp3' | 'ogg'
  bytesPerSecond: number
  args: string[]
}

export const EXPORT_FORMATS: ExportFormatSpec[] = [
  { id: 'source', label: 'Same as source', bytesPerSecond: 24000, args: [] },
  {
    id: 'wav-48-24',
    label: 'WAV · 48 kHz · 24-bit',
    ext: 'wav',
    bytesPerSecond: 48000 * 3,
    args: ['-ar', '48000', '-c:a', 'pcm_s24le'],
  },
  {
    id: 'wav-44-16',
    label: 'WAV · 44.1 kHz · 16-bit',
    ext: 'wav',
    bytesPerSecond: 44100 * 2,
    args: ['-ar', '44100', '-c:a', 'pcm_s16le'],
  },
  {
    id: 'mp3-192',
    label: 'MP3 · 192 kbps',
    ext: 'mp3',
    bytesPerSecond: 24000,
    args: ['-c:a', 'libmp3lame', '-b:a', '192k'],
  },
  { id: 'ogg', label: 'OGG', ext: 'ogg', bytesPerSecond: 24000, args: ['-c:a', 'libvorbis', '-q:a', '6'] },
]

export const DEFAULT_EXPORT_FORMAT: ExportFormatId = 'source'

export function formatSpec(id: ExportFormatId | undefined): ExportFormatSpec {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0]
}

export const LOUDNESS_MODES: { id: LoudnessMode; label: string }[] = [
  { id: 'match', label: 'Match original' },
  { id: 'off', label: 'Off' },
]

export const LENGTH_MODES: { id: LengthMode; label: string }[] = [
  { id: 'trim', label: 'Trim to in / out' },
  { id: 'pad', label: 'Pad to original' },
  { id: 'asis', label: 'As is' },
]

export function sanitizeExportSettings(value: unknown): ExportSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Partial<ExportSettings>
  const out: ExportSettings = {}
  if (typeof row.outDir === 'string' && row.outDir.trim()) out.outDir = row.outDir.trim()
  if (EXPORT_FORMATS.some((f) => f.id === row.format)) out.format = row.format
  if (row.loudness === 'match' || row.loudness === 'off') out.loudness = row.loudness
  if (row.length === 'trim' || row.length === 'pad' || row.length === 'asis') out.length = row.length
  if (row.video === 'copy' || row.video === 'audio') out.video = row.video
  if (typeof row.videoName === 'string' && row.videoName.trim()) out.videoName = row.videoName.trim()
  return Object.keys(out).length > 0 ? out : undefined
}

export function lengthMode(settings: ExportSettings | undefined): LengthMode {
  return settings?.length ?? 'trim'
}

export function loudnessMode(settings: ExportSettings | undefined): LoudnessMode {
  return settings?.loudness ?? 'off'
}

export function estimateBytes(seconds: number, id: ExportFormatId | undefined): number {
  return Math.max(0, seconds) * formatSpec(id).bytesPerSecond
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  let n = Math.max(0, bytes)
  let unit = 0
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${UNITS[unit]}`
}

const LUFS_RE = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g

export function parseEbur128(stderr: string): number | null {
  let last: number | null = null
  for (const m of stderr.matchAll(LUFS_RE)) {
    const v = Number(m[1])
    if (Number.isFinite(v)) last = v
  }
  return last
}

export const LOUDNESS_GAIN_LIMIT_DB = 24

export function loudnessGainDb(referenceLufs: number | null, renderedLufs: number | null): number {
  if (referenceLufs === null || renderedLufs === null) return 0
  if (!Number.isFinite(referenceLufs) || !Number.isFinite(renderedLufs)) return 0
  const gain = referenceLufs - renderedLufs
  if (gain > LOUDNESS_GAIN_LIMIT_DB) return LOUDNESS_GAIN_LIMIT_DB
  if (gain < -LOUDNESS_GAIN_LIMIT_DB) return -LOUDNESS_GAIN_LIMIT_DB
  return Math.round(gain * 100) / 100
}
