import { spawn } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'

export function ffmpegPath(): string {
  const p = ffmpegStatic as unknown as string
  if (!p) throw new Error('bundled ffmpeg not found')
  return p.replace('app.asar', 'app.asar.unpacked')
}

export function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-y', ...args], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
  })
}

export async function runFfmpeg(args: string[]): Promise<void> {
  await ffmpegStderr(args)
}

export function ffmpegInfo(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', () => resolve(stderr))
  })
}

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
const SIZE_RE = /\b(\d{2,5})x(\d{2,5})\b/
const CHANNELS_RE = /,\s*(mono|stereo|(\d+)\s+channels)/
const VIDEO_RE = /Stream #.*Video:/
const AUDIO_RE = /Stream #.*Audio:/
const BRACKETS_RE = /\[[^\]]*\]/g

export interface MediaProbe {
  duration?: number
  width?: number
  height?: number
  channels?: number
  hasVideo: boolean
  hasAudio: boolean
}

export function parseProbe(stderr: string): MediaProbe {
  const out: MediaProbe = { hasVideo: false, hasAudio: false }
  const d = DURATION_RE.exec(stderr)
  if (d) {
    const seconds = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])
    if (Number.isFinite(seconds) && seconds > 0) out.duration = seconds
  }
  for (const line of stderr.split(/\r?\n/)) {
    if (VIDEO_RE.test(line) && !line.includes('attached pic')) {
      out.hasVideo = true
      const size = SIZE_RE.exec(line.replace(BRACKETS_RE, ' '))
      if (size && out.width === undefined) {
        out.width = Number(size[1])
        out.height = Number(size[2])
      }
      continue
    }
    if (AUDIO_RE.test(line)) {
      out.hasAudio = true
      const ch = CHANNELS_RE.exec(line)
      if (ch && out.channels === undefined) {
        out.channels = ch[1] === 'mono' ? 1 : ch[1] === 'stereo' ? 2 : Number(ch[2])
      }
    }
  }
  return out
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  return parseProbe(await ffmpegInfo(file))
}
