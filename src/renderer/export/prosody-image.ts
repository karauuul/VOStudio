import {
  F0_MAX,
  F0_MIN,
  FIGURE_CHROME_HEIGHT,
  FIGURE_PANEL_HEIGHT,
  FIGURE_WIDTH,
  semitones,
  type Contour,
  type PanelKind,
  type ProsodyFigure,
  type ProsodyPanel,
} from '@shared/prosody'

const COLORS = {
  bg: '#191b1e',
  panel: '#222428',
  grid: '#35383e',
  tx: '#e3e6eb',
  tx2: '#a3aab5',
  tx3: '#6f7680',
  f0: '#82acec',
  energy: '#e6a23c',
  phrase: 'rgba(130, 172, 236, 0.10)',
  phraseEdge: 'rgba(130, 172, 236, 0.45)',
  pause: '#e5655f',
  waves: { original: '#8f97a8', dub: '#3fb8a8' },
}

const FONT = 'system-ui, "Segoe UI", sans-serif'
const LEFT = 60
const RIGHT = 16
const TITLE = 26
const WORD_ROWS = 2
const WORD_ROW = 14
const MIN_RANGE_ST = 12
const PITCH_BAND = 0.62
const PITCH_MARGIN = 8
const WAVE_ALPHA = 0.35
const HZ_TICKS = [60, 80, 100, 120, 150, 200, 250, 300, 400, 500]
const ARROWS: Record<Contour, string> = { rising: '↗', flat: '→', falling: '↘' }
const LABELS: Record<PanelKind, string> = { original: 'Original', dub: 'Dub' }

interface Scale {
  x: (t: number) => number
  lo: number
  hi: number
}

function pitchRange(panels: ProsodyPanel[]): { lo: number; hi: number } {
  let lo = Infinity
  let hi = -Infinity
  for (const p of panels) {
    for (const f of p.f0) {
      if (!(f > 0)) continue
      const st = semitones(f)
      if (st < lo) lo = st
      if (st > hi) hi = st
    }
  }
  if (!Number.isFinite(lo)) return { lo: semitones(80), hi: semitones(300) }
  const pad = Math.max(1, (hi - lo) * 0.15, (MIN_RANGE_ST - (hi - lo)) / 2)
  return { lo: Math.max(semitones(F0_MIN), lo - pad), hi: Math.min(semitones(F0_MAX), hi + pad) }
}

function tickStep(duration: number): number {
  return duration > 20 ? 2 : duration > 8 ? 1 : duration > 3 ? 0.5 : duration > 1.2 ? 0.25 : 0.1
}

function drawPanel(g: CanvasRenderingContext2D, panel: ProsodyPanel, top: number, scale: Scale): void {
  const height = FIGURE_PANEL_HEIGHT
  const plotTop = top + 18
  const plotBottom = top + height - WORD_ROWS * WORD_ROW - 8
  const plotHeight = plotBottom - plotTop
  const pitchBottom = plotTop + Math.round(plotHeight * PITCH_BAND)
  const levelTop = pitchBottom + 6
  const levelHeight = plotBottom - 4 - levelTop
  const right = FIGURE_WIDTH - RIGHT
  g.fillStyle = COLORS.panel
  g.fillRect(LEFT, top, right - LEFT, height - 4)

  g.font = `12px ${FONT}`
  g.textBaseline = 'middle'
  g.strokeStyle = COLORS.grid
  g.lineWidth = 1
  g.fillStyle = COLORS.tx3
  g.textAlign = 'right'
  const yOf = (st: number): number =>
    pitchBottom - PITCH_MARGIN - ((st - scale.lo) / (scale.hi - scale.lo)) * (pitchBottom - plotTop - 2 * PITCH_MARGIN)
  for (const hz of HZ_TICKS) {
    const st = semitones(hz)
    if (st < scale.lo || st > scale.hi) continue
    const y = Math.round(yOf(st)) + 0.5
    g.beginPath()
    g.moveTo(LEFT, y)
    g.lineTo(right, y)
    g.stroke()
    g.fillText(`${hz}`, LEFT - 6, y)
  }

  for (const ph of panel.phrases) {
    const x0 = scale.x(ph.start)
    const x1 = scale.x(ph.end)
    g.fillStyle = COLORS.phrase
    g.fillRect(x0, plotTop, Math.max(1, x1 - x0), plotHeight)
    g.strokeStyle = COLORS.phraseEdge
    g.strokeRect(Math.round(x0) + 0.5, plotTop + 0.5, Math.max(1, Math.round(x1 - x0)), plotHeight)
    if (ph.finalContour) {
      g.fillStyle = COLORS.tx
      g.textAlign = 'right'
      g.font = `bold 14px ${FONT}`
      g.fillText(ARROWS[ph.finalContour], x1 - 4, plotTop + 10)
    }
  }

  g.font = `11px ${FONT}`
  g.textAlign = 'center'
  for (let i = 1; i < panel.phrases.length; i++) {
    const a = panel.phrases[i - 1].end
    const b = panel.phrases[i].start
    const x0 = scale.x(a)
    const x1 = scale.x(b)
    const y = plotBottom - 8
    g.strokeStyle = COLORS.pause
    g.beginPath()
    g.moveTo(x0, y - 4)
    g.lineTo(x0, y)
    g.lineTo(x1, y)
    g.lineTo(x1, y - 4)
    g.stroke()
    g.fillStyle = COLORS.pause
    g.fillText(`${(b - a).toFixed(2)}s`, (x0 + x1) / 2, y - 9)
  }

  g.strokeStyle = COLORS.grid
  g.beginPath()
  g.moveTo(LEFT, pitchBottom + 3.5)
  g.lineTo(right, pitchBottom + 3.5)
  g.stroke()
  const mid = levelTop + levelHeight / 2
  const half = levelHeight / 2
  const loudest = Math.max(1e-6, ...panel.peak)
  const edge = panel.peak.map((v, i) => ({ x: scale.x(i * panel.hop), h: (v / loudest) * half }))
  g.fillStyle = COLORS.waves[panel.kind]
  g.globalAlpha = WAVE_ALPHA
  g.beginPath()
  edge.forEach(({ x, h }, i) => (i === 0 ? g.moveTo(x, mid - h) : g.lineTo(x, mid - h)))
  for (let i = edge.length - 1; i >= 0; i--) g.lineTo(edge[i].x, mid + edge[i].h)
  g.closePath()
  g.fill()
  g.globalAlpha = 1

  const floor = panel.silenceDb - 5
  const ceiling = Math.max(floor + 10, ...panel.db) + 3
  const yDb = (db: number): number => levelTop + levelHeight - Math.min(1, Math.max(0, (db - floor) / (ceiling - floor))) * levelHeight
  g.strokeStyle = COLORS.energy
  g.lineWidth = 1.25
  g.beginPath()
  panel.db.forEach((db, i) => {
    const x = scale.x(i * panel.hop)
    if (i === 0) g.moveTo(x, yDb(db))
    else g.lineTo(x, yDb(db))
  })
  g.stroke()

  g.strokeStyle = COLORS.f0
  g.lineWidth = 2.5
  g.beginPath()
  let drawing = false
  panel.f0.forEach((f, i) => {
    if (!(f > 0)) {
      drawing = false
      return
    }
    const x = scale.x(i * panel.hop)
    const y = yOf(Math.min(scale.hi, Math.max(scale.lo, semitones(f))))
    if (drawing) g.lineTo(x, y)
    else g.moveTo(x, y)
    drawing = true
  })
  g.stroke()
  g.lineWidth = 1

  const ends = new Array<number>(WORD_ROWS).fill(-Infinity)
  g.textAlign = 'left'
  g.textBaseline = 'top'
  for (const w of panel.words) {
    g.font = `${w.emphasis ? 'bold ' : ''}12px ${FONT}`
    const x = scale.x(w.start)
    const width = g.measureText(w.text).width
    const row = ends.findIndex((end) => end + 4 <= x)
    if (row < 0) continue
    ends[row] = x + width
    g.strokeStyle = COLORS.tx3
    g.beginPath()
    g.moveTo(Math.round(x) + 0.5, plotBottom)
    g.lineTo(Math.round(x) + 0.5, plotBottom + 3 + row * WORD_ROW)
    g.stroke()
    g.fillStyle = w.emphasis ? COLORS.tx : COLORS.tx2
    g.fillText(w.text, x + 2, plotBottom + 3 + row * WORD_ROW)
  }

  g.textBaseline = 'top'
  g.font = `bold 12px ${FONT}`
  g.fillStyle = COLORS.tx
  g.textAlign = 'left'
  g.fillText(LABELS[panel.kind], LEFT + 6, top + 3)
  if (!panel.f0.some((f) => f > 0)) {
    g.font = `12px ${FONT}`
    g.fillStyle = COLORS.tx3
    g.fillText(`no F0 in ${F0_MIN}–${F0_MAX} Hz`, LEFT + 6 + g.measureText(LABELS[panel.kind]).width + 24, top + 3)
  }
}

function drawLegend(g: CanvasRenderingContext2D): void {
  const items: [string, string][] = [
    ['F0', COLORS.f0],
    ['energy', COLORS.energy],
    ['pause', COLORS.pause],
  ]
  g.font = `12px ${FONT}`
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  let x = FIGURE_WIDTH - RIGHT
  for (const [label, color] of [...items].reverse()) {
    x -= g.measureText(label).width
    g.fillStyle = COLORS.tx2
    g.fillText(label, x, TITLE / 2)
    x -= 20
    g.fillStyle = color
    g.fillRect(x, TITLE / 2 - 2, 14, 4)
    x -= 14
  }
}

export function drawFigure(figure: ProsodyFigure): HTMLCanvasElement {
  const height = FIGURE_CHROME_HEIGHT + FIGURE_PANEL_HEIGHT * figure.panels.length
  const canvas = document.createElement('canvas')
  canvas.width = FIGURE_WIDTH
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error('Canvas 2D is unavailable')
  g.fillStyle = COLORS.bg
  g.fillRect(0, 0, FIGURE_WIDTH, height)
  const duration = Math.max(0.1, ...figure.panels.map((p) => p.duration))
  const range = pitchRange(figure.panels)
  const width = FIGURE_WIDTH - LEFT - RIGHT
  const scale: Scale = { x: (t) => LEFT + (t / duration) * width, ...range }

  g.font = `bold 13px ${FONT}`
  g.fillStyle = COLORS.tx
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  g.fillText(figure.title, 8, TITLE / 2)
  drawLegend(g)
  g.font = `11px ${FONT}`
  g.fillStyle = COLORS.tx3
  g.textAlign = 'right'
  g.fillText('Hz', LEFT - 6, TITLE + 6)

  figure.panels.forEach((panel, i) => drawPanel(g, panel, TITLE + i * FIGURE_PANEL_HEIGHT, scale))

  const axisTop = TITLE + figure.panels.length * FIGURE_PANEL_HEIGHT
  const step = tickStep(duration)
  g.strokeStyle = COLORS.tx3
  g.fillStyle = COLORS.tx2
  g.font = `11px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'top'
  for (let t = 0; t <= duration + 1e-9; t += step) {
    const x = Math.round(scale.x(t)) + 0.5
    g.beginPath()
    g.moveTo(x, axisTop - 2)
    g.lineTo(x, axisTop + 3)
    g.stroke()
    g.fillText(`${Number(t.toFixed(2))}s`, x, axisTop + 5)
  }
  return canvas
}

export async function figurePng(figure: ProsodyFigure): Promise<ArrayBuffer> {
  const canvas = drawFigure(figure)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The image could not be encoded')
  return blob.arrayBuffer()
}
