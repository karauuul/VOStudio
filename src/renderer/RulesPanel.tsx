import { useEffect, useState } from 'react'
import type { Cue } from '@shared/domain'
import { applyRules } from '@shared/pronunciation'
import { api } from './api'
import { Confirm, Overlay } from './Overlay'

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
    <Overlay
      label="Pronunciation rules"
      onClose={attemptClose}
      drawer
      title={
        <>
          Pronunciation rules
          <span className="sp" />
          <span className={dirty ? 't-warn mono' : 't-ok mono'}>
            {dirty ? 'Unsaved' : '✓ Saved'}
          </span>
        </>
      }
    >
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
          <div className={'rules-prev-tx' + (output !== input ? ' on' : '')}>{output || '—'}</div>
        </div>

        {error && <div className="t-err">{error}</div>}
      </div>

      <div className="modal-foot">
        <span className="dim mono">{countRules(draft)} rules</span>
        {confirmClose ? (
          <Confirm
            operation="Close with unsaved rules"
            choices={[
              { label: 'Save', kind: 'primary', disabled: saving, onClick: save },
              { label: 'Discard', kind: 'danger', onClick: onClose },
              { label: 'Cancel', safe: true, onClick: () => setConfirmClose(false) },
            ]}
          />
        ) : (
          <button className="btn primary" onClick={save} disabled={!dirty || saving}>
            Save
          </button>
        )}
      </div>
    </Overlay>
  )
}
