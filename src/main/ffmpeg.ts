import { spawn } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'

export function ffmpegPath(): string {
  const p = ffmpegStatic as unknown as string
  if (!p) throw new Error('bundled ffmpeg not found')
  return p.replace('app.asar', 'app.asar.unpacked')
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-y', ...args], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
  })
}
