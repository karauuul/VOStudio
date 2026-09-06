export interface HintAnchor {
  left: number
  right: number
  top: number
  bottom: number
}

export interface HintPlacement {
  left: number
  top: number
}

const GAP = 4
const MARGIN = 6

export function hintPosition(
  anchor: HintAnchor,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number
): HintPlacement {
  const below = anchor.bottom + GAP
  const top =
    below + height > viewHeight - MARGIN
      ? Math.max(MARGIN, anchor.top - GAP - height)
      : below
  const center = (anchor.left + anchor.right) / 2 - width / 2
  const left = Math.max(MARGIN, Math.min(center, viewWidth - MARGIN - width))
  return { left, top }
}
