import { useEffect, useState } from 'react'
import { api } from './api'

export function countRules(text: string): number {
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes(' → ')).length
}

interface Props {
  rules: string
  onSaved: (text: string) => void
}

export function RulesPanel({ rules, onSaved }: Props) {
  const [draft, setDraft] = useState(rules)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(rules)
    setDirty(false)
  }, [rules])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await api['project:command']({ type: 'rules.set', text: draft })
      onSaved(draft)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rules">
      <div className="rules-head">
        Pronunciation rules
        <span className={dirty ? 't-warn' : 't-ok'} style={{ font: '11px var(--mono)' }}>
          {dirty ? 'Unsaved' : '✓ Saved'}
        </span>
      </div>
      <textarea
        className="rules-ta"
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        placeholder="find → replace"
      />
      <div className="rules-foot">
        <span className="dim mono">{countRules(draft)} rules</span>
        <button className="btn ghost" onClick={() => void save()} disabled={!dirty || saving}>
          Save
        </button>
      </div>
    </div>
  )
}
