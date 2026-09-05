import { useEffect, useRef, useState, type ReactNode } from 'react'

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

const IconXfade = (): JSX.Element => (
  <S>
    <path {...stroke} d="M2 12.5 L14 3.5" />
    <path {...stroke} d="M2 3.5 L14 12.5" />
    <path {...stroke} d="M8 1.5 v13" strokeWidth={0.9} strokeDasharray="2 2" />
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

interface ToolProps {
  icon?: JSX.Element
  label?: string
  title?: string
  hotkey?: string
  onClick: () => void
  disabled?: boolean
  on?: boolean
}

function Tool({ icon, label, title, hotkey, onClick, disabled, on }: ToolProps) {
  return (
    <button
      type="button"
      className={'tlb-btn' + (on ? ' on' : '')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label ?? title ?? ''}
      aria-pressed={on === undefined ? undefined : on}
      onMouseDown={(e) => e.preventDefault()}
    >
      {icon}
      {label && <span className="tlb-l">{label}</span>}
      {hotkey && <span className="tlb-k">{hotkey}</span>}
    </button>
  )
}

interface Props {
  onCut: () => void
  canCut: boolean
  onHeal: () => void
  canHeal: boolean
  onCrossfade: () => void
  canCrossfade: boolean
  crossfadeOn: boolean
  insert: ReactNode
  onDelete: () => void
  canDelete: boolean
  onUndo: () => void
  canUndo: boolean
  onRedo: () => void
  canRedo: boolean
  onFragment: () => void
  canFragment: boolean
  onSetIn: () => void
  onSetOut: () => void
  onClearRegion: () => void
  canRegion: boolean
  hasRegion: boolean
  snap: boolean
  onSnap: () => void
  onZoomIn: () => void
  canZoomIn: boolean
  onZoomOut: () => void
  canZoomOut: boolean
  onFit: () => void
}

export function TimelineBar(p: Props) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  return (
    <div className="tlb" role="toolbar" aria-label="Clip tools">
      <Tool
        icon={<IconCut />}
        label="Cut"
        hotkey="C"
        onClick={p.onCut}
        disabled={!p.canCut}
      />
      <Tool
        icon={<IconHeal />}
        label="Heal"
        hotkey="H"
        onClick={p.onHeal}
        disabled={!p.canHeal}
      />
      <Tool
        icon={<IconXfade />}
        label="Crossfade"
        hotkey="X"
        onClick={p.onCrossfade}
        disabled={!p.canCrossfade}
        on={p.crossfadeOn}
      />

      {p.insert}

      <div className="tlb-menu" ref={menuRef}>
        <button
          type="button"
          className="tlb-btn"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label="More clip actions"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMenu((v) => !v)}
        >
          <span className="tlb-l">⋯</span>
        </button>
        {menu && (
          <div className="menu-pop" role="menu">
            <button
              className="menu-item"
              role="menuitem"
              disabled={!p.canDelete}
              onClick={() => {
                setMenu(false)
                p.onDelete()
              }}
            >
              Delete <kbd>Del</kbd>
            </button>
            <button
              className="menu-item"
              role="menuitem"
              disabled={!p.canUndo}
              onClick={() => {
                setMenu(false)
                p.onUndo()
              }}
            >
              Undo <kbd>Ctrl+Z</kbd>
            </button>
            <button
              className="menu-item"
              role="menuitem"
              disabled={!p.canRedo}
              onClick={() => {
                setMenu(false)
                p.onRedo()
              }}
            >
              Redo <kbd>Ctrl+Shift+Z</kbd>
            </button>
            <button
              className="menu-item"
              role="menuitem"
              disabled={!p.canFragment}
              onClick={() => {
                setMenu(false)
                p.onFragment()
              }}
            >
              Generate fragment <kbd>Ctrl+Shift+G</kbd>
            </button>
          </div>
        )}
      </div>

      <span className="tlb-sep" />

      <span className="tlb-label">
        Render range
      </span>
      <Tool
        icon={<IconSetIn />}
        label="In"
        onClick={p.onSetIn}
        disabled={!p.canRegion}
      />
      <Tool
        icon={<IconSetOut />}
        label="Out"
        onClick={p.onSetOut}
        disabled={!p.canRegion}
      />
      <Tool
        icon={<IconClearRegion />}
        label="Clear"
        onClick={p.onClearRegion}
        disabled={!p.hasRegion}
      />

      <span className="tlb-sep" />

      <Tool
        icon={<IconSnap />}
        label="Snap"
        onClick={p.onSnap}
        on={p.snap}
      />
      <Tool label="−" onClick={p.onZoomOut} disabled={!p.canZoomOut} />
      <Tool label="+" onClick={p.onZoomIn} disabled={!p.canZoomIn} />
      <Tool icon={<IconFit />} label="Fit" onClick={p.onFit} />
    </div>
  )
}
