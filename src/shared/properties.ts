export type PropertiesTab = 'clip' | 'track' | 'line' | 'source'

export interface PropertiesTargets {
  source: string
  clip: string
  track: string
}

export function propertiesTabs(targets: PropertiesTargets): PropertiesTab[] {
  return targets.source ? ['clip', 'track', 'line', 'source'] : ['clip', 'track', 'line']
}

export function propertiesTab(
  prev: PropertiesTargets,
  next: PropertiesTargets,
  current: PropertiesTab
): PropertiesTab {
  if (next.source && next.source !== prev.source) return 'source'
  if (next.clip && next.clip !== prev.clip) return 'clip'
  if (next.track && next.track !== prev.track) return 'track'
  if (current === 'source') return next.source ? 'source' : next.clip ? 'clip' : 'line'
  if (current === 'clip') return next.clip ? 'clip' : 'line'
  return current
}
