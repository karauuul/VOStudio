export type SidePanes = { lines: number; props: number; prog: number }

const SHRINK_ORDER: (keyof SidePanes)[] = ['prog', 'props', 'lines']

export function fitWorkPanes(
  widths: SidePanes,
  tiers: SidePanes[],
  available: number,
  textMin: number
): SidePanes {
  let excess = widths.lines + widths.props + widths.prog + textMin - available
  const fitted = { ...widths }
  for (const mins of tiers) {
    for (const pane of SHRINK_ORDER) {
      if (excess <= 0) return fitted
      const cut = Math.min(excess, Math.max(0, fitted[pane] - mins[pane]))
      fitted[pane] -= cut
      excess -= cut
    }
  }
  return fitted
}
