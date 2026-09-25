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
