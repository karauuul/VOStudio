import type { Peaks } from '../Waveform'

export function drawWave(
  canvas: HTMLCanvasElement | null,
  peaks: Peaks | null,
  from: number,
  to: number,
  color: string
): void {
  if (!canvas) return
  const cx = canvas.getContext('2d')
  if (!cx) return
  const dpr = window.devicePixelRatio || 1
  const W = Math.max(1, Math.round(canvas.offsetWidth * dpr))
  const H = Math.max(1, Math.round(canvas.offsetHeight * dpr))
  if (canvas.width !== W) canvas.width = W
  if (canvas.height !== H) canvas.height = H
  cx.clearRect(0, 0, W, H)

  const n = peaks?.min.length ?? 0
  if (!peaks || n === 0 || !(to > from)) return
  const dur = peaks.duration > 0 ? peaks.duration : 1
  const mid = H / 2
  const half = mid * 0.86
  const step = Math.max(1, Math.round(dpr))
  cx.fillStyle = color
  for (let x = 0; x < W; x += step) {
    const t = from + ((x + step / 2) / W) * (to - from)
    const i = Math.min(n - 1, Math.max(0, Math.floor((t / dur) * n)))
    const top = mid - peaks.max[i] * half
    const bot = mid - peaks.min[i] * half
    cx.fillRect(x, Math.min(top, bot), step, Math.max(step, Math.abs(bot - top)))
  }
}
