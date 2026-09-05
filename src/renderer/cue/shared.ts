import { isEmptyComp } from '@shared/comp'
import { estimateStsCredits, type Cue, type CueStatus } from '@shared/domain'
import { outputSource } from '@shared/workspace-source'

export const REF_COLOR = '#6d9ff2'
export const TAKE_COLOR = '#46c98c'
export const REC_COLOR = '#e6a23c'

export const STATUS_LABEL: Record<CueStatus, string> = {
  empty: 'Empty',
  translated: 'Translated',
  generated: 'Voiced',
  approved: 'Approved',
  excluded: 'Excluded',
}

export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.0'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

export const timecode = clock

export function meterPct(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
}

export const credits = (sec: number): string => estimateStsCredits(sec).toLocaleString('en-US')

export const stamp = (at: string | number): string => new Date(at).toLocaleString('en-US')

export function compositionLabel(cue: Cue): string {
  if (isEmptyComp(cue.comp)) return 'Composition · Unsaved'
  return outputSource(cue)?.kind === 'comp' ? 'Composition · Final' : 'Composition'
}
