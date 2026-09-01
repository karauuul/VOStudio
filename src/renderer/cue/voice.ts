import type { VoiceSettings } from '@shared/domain'

export type KnobKey = 'stability' | 'similarity' | 'style' | 'speed'

export interface Knob {
  key: KnobKey
  label: string
  min: number
  max: number
  decimals: 0 | 2
  title: string
}

export const KNOBS: readonly Knob[] = [
  { key: 'stability', label: 'Stab', min: 0, max: 100, decimals: 0, title: 'Stability' },
  { key: 'similarity', label: 'Sim', min: 0, max: 100, decimals: 0, title: 'Similarity' },
  { key: 'style', label: 'Style', min: 0, max: 100, decimals: 0, title: 'Style exaggeration' },
  { key: 'speed', label: 'Speed', min: 70, max: 120, decimals: 2, title: 'Speaking rate' },
]

export const toSlider = (v: number): number => Math.round(v * 100)
export const fromSlider = (n: number): number => n / 100

export function knobText(knob: Knob, v: number): string {
  const n = toSlider(v)
  return knob.decimals === 0 ? String(n) : (n / 100).toFixed(2)
}

export function isOverridden(
  override: Partial<VoiceSettings> | undefined,
  key: keyof VoiceSettings
): boolean {
  return !!override && override[key] !== undefined
}
