export type TakeFileKind = 'keep' | 'transcode' | 'video' | 'unsupported'

const KEEP = new Set(['.wav', '.mp3', '.ogg'])
const TRANSCODE = new Set(['.flac', '.m4a', '.aac', '.opus', '.webm'])
const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.wmv', '.mpg', '.mpeg'])

export const TAKE_FILE_EXTENSIONS = [...KEEP, ...TRANSCODE].map((ext) => ext.slice(1))

export function takeFileKind(path: string): TakeFileKind {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  if (KEEP.has(ext)) return 'keep'
  if (TRANSCODE.has(ext)) return 'transcode'
  if (VIDEO.has(ext)) return 'video'
  return 'unsupported'
}

export const DECODE_BUDGET_BYTES = 300 * 1024 * 1024

const FALLBACK_SAMPLE_RATE = 48000
const FALLBACK_CHANNELS = 2
const FLOAT_BYTES = 4

export interface AudioProbe {
  duration?: number
  sampleRate?: number
  channels?: number
}

const bytesPerSecond = (probe: AudioProbe): number =>
  (probe.sampleRate ?? FALLBACK_SAMPLE_RATE) * (probe.channels ?? FALLBACK_CHANNELS) * FLOAT_BYTES

export function decodedBytes(probe: AudioProbe): number {
  return (probe.duration ?? 0) * bytesPerSecond(probe)
}

export function maxEditMinutes(probe: AudioProbe): number {
  return Math.floor(DECODE_BUDGET_BYTES / bytesPerSecond(probe) / 60)
}

export function importProblem(probe: AudioProbe): string | null {
  if (probe.duration === undefined) return 'Audio length is unknown'
  if (decodedBytes(probe) > DECODE_BUDGET_BYTES) return `File too long to edit (max ~${maxEditMinutes(probe)} min)`
  return null
}
