const S = (p: { children: React.ReactNode }): JSX.Element => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    {p.children}
  </svg>
)

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const IconCut = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2 2.5 L10.5 11" />
    <path {...stroke} d="M2 13.5 L10.5 5" />
    <circle {...stroke} cx="12.2" cy="3.6" r="1.9" />
    <circle {...stroke} cx="12.2" cy="12.4" r="1.9" />
  </S>
)

const IconHeal = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2.5 4 h4 v8 h-4 z" />
    <path {...stroke} d="M13.5 4 h-4 v8 h4 z" />
    <path {...stroke} d="M6.8 8 h2.4" />
  </S>
)

const IconDelete = (): JSX.Element => (
  <S>
    <path {...stroke} d="M3 4.5 h10" />
    <path {...stroke} d="M6.5 4.5 V3 h3 v1.5" />
    <path {...stroke} d="M4.3 4.5 L5 13.5 h6 l0.7-9" />
  </S>
)

const IconUndo = (): JSX.Element => (
  <S>
    <path {...stroke} d="M5.5 4.5 L2.5 7.5 L5.5 10.5" />
    <path {...stroke} d="M2.5 7.5 H9.5 a3.5 3.5 0 0 1 0 7 H7" />
  </S>
)

const IconRedo = (): JSX.Element => (
  <S>
    <path {...stroke} d="M10.5 4.5 L13.5 7.5 L10.5 10.5" />
    <path {...stroke} d="M13.5 7.5 H6.5 a3.5 3.5 0 0 0 0 7 H9" />
  </S>
)

const IconZoomIn = (): JSX.Element => (
  <S>
    <circle {...stroke} cx="7" cy="7" r="4.5" />
    <path {...stroke} d="M10.4 10.4 L14 14" />
    <path {...stroke} d="M4.8 7 h4.4 M7 4.8 v4.4" />
  </S>
)

const IconZoomOut = (): JSX.Element => (
  <S>
    <circle {...stroke} cx="7" cy="7" r="4.5" />
    <path {...stroke} d="M10.4 10.4 L14 14" />
    <path {...stroke} d="M4.8 7 h4.4" />
  </S>
)

const IconFit = (): JSX.Element => (
  <S>
    <path {...stroke} d="M1.8 3 v10 M14.2 3 v10" />
    <path {...stroke} d="M4.5 8 h7" />
    <path {...stroke} d="M6.6 5.9 L4.5 8 L6.6 10.1" />
    <path {...stroke} d="M9.4 5.9 L11.5 8 L9.4 10.1" />
  </S>
)

const IconSnap = (): JSX.Element => (
  <S>
    <path {...stroke} d="M4 12.5 V7 a4 4 0 0 1 8 0 v5.5" />
    <path {...stroke} d="M4 9.5 h3.2 M12 9.5 H8.8" />
    <path {...stroke} d="M4 12.5 h3.2 M12 12.5 H8.8" />
  </S>
)

const IconSpark = (): JSX.Element => (
  <S>
    <path {...stroke} d="M6.4 1.8 L7.6 5.4 L11.2 6.6 L7.6 7.8 L6.4 11.4 L5.2 7.8 L1.6 6.6 L5.2 5.4 z" />
    <path {...stroke} d="M11.6 10 L12.3 12 L14.3 12.7 L12.3 13.4 L11.6 15.4 L10.9 13.4 L8.9 12.7 L10.9 12 z" />
  </S>
)

const IconAB = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2 8 h1.4 M5 4.5 v7 M8 2.5 v11 M11 4.5 v7 M14 8 h-1.4" />
  </S>
)

const IconXfade = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2 12.5 L14 3.5" />
    <path {...stroke} d="M2 3.5 L14 12.5" />
    <path {...stroke} d="M8 1.5 v13" strokeWidth={0.9} strokeDasharray="2 2" />
  </S>
)

const IconReverb = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2.5 3.5 v9" />
    <path {...stroke} d="M5.5 5 v6" />
    <path {...stroke} d="M8.5 6.5 v3" />
    <path {...stroke} d="M11.5 7.3 v1.4" />
    <path {...stroke} d="M14 7.7 v0.6" />
  </S>
)

const IconDelay = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2 13 v-9" />
    <path {...stroke} d="M6.5 13 v-6" />
    <path {...stroke} d="M11 13 v-3.6" />
    <path {...stroke} d="M14.5 13 v-2" />
    <path {...stroke} d="M1 13.5 h14" strokeWidth={0.9} />
  </S>
)

const IconPitch = (): JSX.Element => (
  <S>
    <path {...stroke} d="M1.5 11 q2.2 -3 4.4 0 t4.4 0 t4.2 0" />
    <path {...stroke} d="M8 6.6 V1.8" />
    <path {...stroke} d="M6 3.8 L8 1.8 L10 3.8" />
  </S>
)

const IconSetIn = (): JSX.Element => (
  <S>
    <path {...stroke} d="M4 2.5 v11 M4 2.5 h4 M4 13.5 h4" />
    <path {...stroke} d="M14 8 H8.5" />
    <path {...stroke} d="M10.6 5.9 L8.5 8 L10.6 10.1" />
  </S>
)

const IconSetOut = (): JSX.Element => (
  <S>
    <path {...stroke} d="M12 2.5 v11 M12 2.5 h-4 M12 13.5 h-4" />
    <path {...stroke} d="M2 8 H7.5" />
    <path {...stroke} d="M5.4 5.9 L7.5 8 L5.4 10.1" />
  </S>
)

const IconClearRegion = (): JSX.Element => (
  <S>
    <path {...stroke} d="M3 3.5 v9 M3 3.5 h3 M3 12.5 h3" />
    <path {...stroke} d="M13 3.5 v9 M13 3.5 h-3 M13 12.5 h-3" />
    <path {...stroke} d="M5.5 12.8 L10.5 3.2" />
  </S>
)

const IconInsert = (): JSX.Element => (
  <S>
    <path {...stroke} d="M8 1.8 v6.4" />
    <path {...stroke} d="M5.6 6 L8 8.4 L10.4 6" />
    <path {...stroke} d="M2.5 10.5 h11 v3 h-11 z" />
  </S>
)

interface BtnProps {
  icon: JSX.Element
  title: string
  hotkey?: string
  onClick: () => void
  disabled?: boolean
  on?: boolean
}

function Tool({ icon, title, hotkey, onClick, disabled, on }: BtnProps) {
  return (
    <button
      type="button"
      className={'tlb-btn' + (on ? ' on' : '')}
      onClick={onClick}
      disabled={disabled}
      title={hotkey ? `${title} (${hotkey})` : title}
      aria-label={title}
      aria-pressed={on === undefined ? undefined : on}
      onMouseDown={(e) => e.preventDefault()}
    >
      {icon}
      {hotkey && <span className="tlb-k">{hotkey}</span>}
    </button>
  )
}

interface Props {
  onCut: () => void
  canCut: boolean
  onHeal: () => void
  canHeal: boolean
  onDelete: () => void
  canDelete: boolean
  onUndo: () => void
  canUndo: boolean
  onRedo: () => void
  canRedo: boolean
  onZoomIn: () => void
  canZoomIn: boolean
  onZoomOut: () => void
  canZoomOut: boolean
  onFit: () => void
  snap: boolean
  onSnap: () => void
  onFragment: () => void
  canFragment: boolean
  onAb: () => void
  canAb: boolean
  onCrossfade: () => void
  canCrossfade: boolean
  crossfadeOn: boolean
  onReverb: () => void
  reverbOn: boolean
  onDelay: () => void
  delayOn: boolean
  onPitch: () => void
  pitchOn: boolean
  canFx: boolean
  onInsert: () => void
  canInsert: boolean
  onSetIn: () => void
  onSetOut: () => void
  onClearRegion: () => void
  canRegion: boolean
  hasRegion: boolean
}

export function TimelineBar(p: Props) {
  return (
    <div className="tlb" role="toolbar" aria-label="Timeline">
      <Tool
        icon={<IconCut />}
        title="Cut at the playhead"
        hotkey="C"
        onClick={p.onCut}
        disabled={!p.canCut}
      />
      <Tool
        icon={<IconHeal />}
        title="Heal the cut back into one clip"
        hotkey="H"
        onClick={p.onHeal}
        disabled={!p.canHeal}
      />
      <Tool
        icon={<IconXfade />}
        title="Cross-fade into the next clip (80 ms)"
        hotkey="X"
        onClick={p.onCrossfade}
        disabled={!p.canCrossfade}
        on={p.crossfadeOn}
      />
      <Tool
        icon={<IconDelete />}
        title="Delete the selected clip"
        hotkey="Del"
        onClick={p.onDelete}
        disabled={!p.canDelete}
      />

      <span className="tlb-sep" />

      {}
      <Tool
        icon={<IconReverb />}
        title="Reverb on the selected clip"
        onClick={p.onReverb}
        disabled={!p.canFx}
        on={p.reverbOn}
      />
      <Tool
        icon={<IconDelay />}
        title="Delay / echo on the selected clip"
        onClick={p.onDelay}
        disabled={!p.canFx}
        on={p.delayOn}
      />
      <Tool
        icon={<IconPitch />}
        title="Pitch on the selected clip — semitones, length unchanged"
        onClick={p.onPitch}
        disabled={!p.canFx}
        on={p.pitchOn}
      />

      <span className="tlb-sep" />

      <Tool
        icon={<IconInsert />}
        title="Insert the shown take at the playhead"
        onClick={p.onInsert}
        disabled={!p.canInsert}
      />
      <Tool
        icon={<IconSetIn />}
        title="Set the render region IN at the playhead"
        onClick={p.onSetIn}
        disabled={!p.canRegion}
      />
      <Tool
        icon={<IconSetOut />}
        title="Set the render region OUT at the playhead"
        onClick={p.onSetOut}
        disabled={!p.canRegion}
      />
      <Tool
        icon={<IconClearRegion />}
        title="Clear the render region"
        onClick={p.onClearRegion}
        disabled={!p.hasRegion}
      />

      <span className="tlb-sep" />

      <Tool
        icon={<IconUndo />}
        title="Undo"
        hotkey="Ctrl+Z"
        onClick={p.onUndo}
        disabled={!p.canUndo}
      />
      {}
      <Tool icon={<IconRedo />} title="Redo (Ctrl+Shift+Z)" onClick={p.onRedo} disabled={!p.canRedo} />

      <span className="tlb-sep" />

      <Tool
        icon={<IconZoomOut />}
        title="Zoom out"
        onClick={p.onZoomOut}
        disabled={!p.canZoomOut}
      />
      <Tool icon={<IconZoomIn />} title="Zoom in" onClick={p.onZoomIn} disabled={!p.canZoomIn} />
      <Tool icon={<IconFit />} title="Fit the whole cue" onClick={p.onFit} />
      <Tool icon={<IconSnap />} title="Snap to edges" onClick={p.onSnap} on={p.snap} />

      <span className="tlb-sep" />

      {}
      <Tool
        icon={<IconSpark />}
        title="Regenerate the selected clip (Ctrl+G)"
        onClick={p.onFragment}
        disabled={!p.canFragment}
      />
      <Tool
        icon={<IconAB />}
        title="Play both — original left, composition right"
        hotkey="B"
        onClick={p.onAb}
        disabled={!p.canAb}
      />
    </div>
  )
}
