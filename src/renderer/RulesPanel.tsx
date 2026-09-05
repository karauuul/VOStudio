import { useEffect, useState } from 'react'
import type { Cue } from '@shared/domain'
import { applyRules } from '@shared/pronunciation'
import { api } from './api'

export function countRules(text: string): number {
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes(' → ')).length
}

interface Props {
  rules: string
  cue?: Cue
  onSaved: (text: string) => void
  onClose: () => void
}

export function RulesDialog({ rules, cue, onSaved, onClose }: Props) {
  const [draft, setDraft] = useState(rules)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    setDraft(rules)
    setDirty(false)
  }, [rules])

  const save = (): void => {
    setSaving(true)
    setError('')
    void api['project:command']({ type: 'rules.set', text: draft })
      .then(
        () => {
          onSaved(draft)
          setDirty(false)
          setConfirmClose(false)
        },
        (e: unknown) => setError(String(e))
      )
      .finally(() => setSaving(false))
  }

  const attemptClose = (): void => {
    if (dirty) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const input = cue?.text ?? ''
  const output = applyRules(input, draft)

  return (
    <div className="modal-bg" onClick={attemptClose}>
      <div
        className="modal rules-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.code !== 'Escape') return
          e.stopPropagation()
          attemptClose()
        }}
      >
        <div className="modal-head">
          Pronunciation rules
          <span className="sp" />
          <span className={dirty ? 't-warn mono' : 't-ok mono'}>
            {dirty ? 'Unsaved' : '✓ Saved'}
          </span>
          <button className="icon-btn" onClick={attemptClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body rules">
          <textarea
            className="rules-ta"
            value={draft}
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value)
              setDirty(true)
              setConfirmClose(false)
            }}
            placeholder="find → replace"
          />

          <div className="rules-prev">
            <div className="script-l">Input</div>
            <div className="rules-prev-tx">{input || '—'}</div>
            <div className="script-l">Spoken</div>
            <div className={'rules-prev-tx' + (output !== input ? ' on' : '')}>
              {output || '—'}
            </div>
          </div>

          {error && <div className="t-err">{error}</div>}
        </div>

        <div className="modal-foot">
          <span className="dim mono">{countRules(draft)} rules</span>
          {confirmClose ? (
            <span className="rules-confirm">
              <span className="t-warn">Unsaved rules</span>
              <button className="btn primary" onClick={save} disabled={saving}>
                Save
              </button>
              <button className="btn danger" onClick={onClose}>
                Discard
              </button>
              <button className="btn ghost" autoFocus onClick={() => setConfirmClose(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="btn primary" onClick={save} disabled={!dirty || saving}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
