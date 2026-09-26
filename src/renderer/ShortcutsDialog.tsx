import { BINDINGS, groupOf, keyText, labelText, SHORTCUT_GROUPS } from './keyboard'
import { Overlay } from './Overlay'

export function ShortcutsDialog({ ai, onClose }: { ai: boolean; onClose: () => void }) {
  const labelled = BINDINGS.filter((b) => b.label)

  return (
    <Overlay title="Shortcuts" label="Shortcuts" onClose={onClose} wide>
      <div className="modal-body keymap">
        {SHORTCUT_GROUPS.map((g) => {
          const rows = labelled.filter((b) => groupOf(b) === g.title)
          if (rows.length === 0) return null
          return (
            <div className="keymap-grp" key={g.title}>
              <div className="sec-h">{g.title}</div>
              {rows.map((b) => (
                <div className="keymap-row" key={b.action}>
                  <span>{labelText(b, ai)}</span>
                  <kbd>{keyText(b)}</kbd>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </Overlay>
  )
}
