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
const CHANNELS_RE = /Hz,\s*([^,]+)/
const LAYOUT_CHANNELS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  '3.0(back)': 3,
  quad: 4,
  'quad(side)': 4,
  '4.0': 4,
  '4.1': 5,
  '5.0': 5,
  '5.0(side)': 5,
  '5.1': 6,
  '5.1(side)': 6,
  '6.0': 6,
  '6.1': 7,
  '6.1(back)': 7,
  '7.0': 7,
  '7.1': 8,
  '7.1(wide)': 8,
  '7.1(wide-side)': 8,
}
const UNKNOWN_LAYOUT_CHANNELS = 8

export function layoutChannels(layout: string): number {
  const name = layout.trim().toLowerCase()
  const counted = /^(\d+)\s+channels?/.exec(name)
  if (counted) return Number(counted[1])
  return LAYOUT_CHANNELS[name] ?? UNKNOWN_LAYOUT_CHANNELS
}
const RATE_RE = /,\s*(\d{4,6})\s+Hz/
const VIDEO_RE = /Stream #.*Video:/
const AUDIO_RE = /Stream #.*Audio:/
const BRACKETS_RE = /\[[^\]]*\]/g

export interface MediaProbe {
  duration?: number
  width?: number
  height?: number
  channels?: number
  sampleRate?: number
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
      if (ch && out.channels === undefined) out.channels = layoutChannels(ch[1])
      const rate = RATE_RE.exec(line)
      if (rate && out.sampleRate === undefined) out.sampleRate = Number(rate[1])
    }
  }
  return out
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  return parseProbe(await ffmpegInfo(file))
}
