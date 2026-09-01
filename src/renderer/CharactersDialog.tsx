import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ELEVENLABS_STS_MODEL,
  ELEVENLABS_TTS_MODEL,
  type Character,
  type Cue,
  type VoiceSettings,
} from '@shared/domain'
import type { ProjectCommand } from '@shared/project-commands'
import { api } from './api'
import { transport } from './audio/transport'
import { fromSlider, knobText, KNOBS, toSlider } from './cue/voice'

const TTS_MODELS = [ELEVENLABS_TTS_MODEL]
const STS_MODELS = [ELEVENLABS_STS_MODEL]

const modelOptions = (known: string[], current: string): string[] =>
  known.includes(current) ? known : [current, ...known]

interface ProviderPatch {
  voiceId?: string
  ttsModel?: string
  stsModel?: string
}

function DraftField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  value: string
  placeholder?: string
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="text"
      aria-label={label}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft
        setDraft(null)
        if (next !== null && next.trim() !== value) onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') e.currentTarget.blur()
      }}
    />
  )
}

interface Props {
  characters: Character[]
  cues: Cue[]
  onVoiceSettings: (characterId: string, settings: VoiceSettings) => void
  onProvider: (characterId: string, patch: ProviderPatch) => void
  onFlushVoice: () => Promise<unknown>
  onCancelVoice: (characterId: string) => void
  dispatch: (command: ProjectCommand) => Promise<void>
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onClose: () => void
}

export function CharactersDialog({
  characters,
  cues,
  onVoiceSettings,
  onProvider,
  onFlushVoice,
  onCancelVoice,
  dispatch,
  onStatus,
  onClose,
}: Props) {
  const [newName, setNewName] = useState('')
  const [del, setDel] = useState<{ id: string; to: string } | null>(null)
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set())
  const testUrl = useRef<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (testUrl.current) URL.revokeObjectURL(testUrl.current)
    }
  }, [])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const cue of cues) map.set(cue.characterId, (map.get(cue.characterId) ?? 0) + 1)
    return map
  }, [cues])

  const run = (command: ProjectCommand, done?: () => void): void => {
    void dispatch(command).then(
      () => done?.(),
      (e: unknown) => onStatus('err', String(e))
    )
  }

  const remove = (characterId: string, reassignTo: string, done?: () => void): void => {
    onCancelVoice(characterId)
    run({ type: 'character.delete', characterId, reassignTo }, done)
  }

  const test = async (character: Character): Promise<void> => {
    if (testing.has(character.id)) return
    setTesting((s) => new Set(s).add(character.id))
    try {
      await onFlushVoice()
      const bytes = await api['provider:testVoice'](character.id)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
      if (!mounted.current) {
        URL.revokeObjectURL(url)
        return
      }
      if (testUrl.current) URL.revokeObjectURL(testUrl.current)
      testUrl.current = url
      void transport.playClip({ id: 'test:' + character.id, url }, 0)
    } catch (e) {
      onStatus('err', String(e))
    } finally {
      setTesting((s) => {
        const next = new Set(s)
        next.delete(character.id)
        return next
      })
    }
  }

  const create = (): void => {
    const name = newName.trim()
    if (!name) return
    run({ type: 'character.create', id: crypto.randomUUID(), name }, () => setNewName(''))
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Characters
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="coll-list">
            {characters.map((character) => {
              const count = counts.get(character.id) ?? 0
              const others = characters.filter((c) => c.id !== character.id)
              const busy = testing.has(character.id)
              const v = character.voiceSettings
              return (
                <div className="coll" key={character.id}>
                  <div className="row">
                    <span className="char-dot" style={{ background: character.color }} />
                    <DraftField
                      label="Name"
                      value={character.name}
                      onCommit={(name) => run({ type: 'character.rename', characterId: character.id, name })}
                    />
                    <DraftField
                      label="Voice ID"
                      value={character.provider.voiceId}
                      placeholder="voice id"
                      onCommit={(voiceId) => onProvider(character.id, { voiceId })}
                    />
                    <span className="dim">{count} cues</span>
                  </div>

                  <div className="row">
                    <select
                      aria-label="TTS model"
                      value={character.provider.ttsModel}
                      onChange={(e) => onProvider(character.id, { ttsModel: e.target.value })}
                    >
                      {modelOptions(TTS_MODELS, character.provider.ttsModel).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="STS model"
                      value={character.provider.stsModel}
                      onChange={(e) => onProvider(character.id, { stsModel: e.target.value })}
                    >
                      {modelOptions(STS_MODELS, character.provider.stsModel).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <span className="sp" />
                    <button
                      className="btn ghost"
                      onClick={() => void test(character)}
                      disabled={busy || !character.provider.voiceId}
                      title={character.provider.voiceId ? 'Test' : 'No voice configured'}
                    >
                      {busy ? <span className="spin" /> : '▶'} Test
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (count > 0) {
                          setDel({ id: character.id, to: '' })
                          return
                        }
                        if (confirm(`Delete ${character.name}?`)) remove(character.id, '')
                      }}
                    >
                      Delete
                    </button>
                  </div>

                  <div className="knobs">
                    {KNOBS.map((k) => (
                      <label key={k.key} className="knob" title={k.title}>
                        <span className="knob-l">{k.label}</span>
                        <input
                          type="range"
                          min={k.min}
                          max={k.max}
                          value={toSlider(v[k.key])}
                          onChange={(e) =>
                            onVoiceSettings(character.id, { ...v, [k.key]: fromSlider(Number(e.target.value)) })
                          }
                        />
                        <span className="knob-v">{knobText(k, v[k.key])}</span>
                      </label>
                    ))}
                    <label className="knob tgl">
                      <input
                        type="checkbox"
                        checked={v.boost}
                        onChange={(e) => onVoiceSettings(character.id, { ...v, boost: e.target.checked })}
                      />
                      Boost
                    </label>
                  </div>

                  {del?.id === character.id && (
                    <div className="row">
                      <select value={del.to} onChange={(e) => setDel({ id: character.id, to: e.target.value })}>
                        <option value="">Unassign cues</option>
                        {others.map((c) => (
                          <option key={c.id} value={c.id}>
                            Reassign to {c.name}
                          </option>
                        ))}
                      </select>
                      <button className="btn danger" onClick={() => remove(character.id, del.to, () => setDel(null))}>
                        Confirm delete
                      </button>
                      <button className="btn ghost" onClick={() => setDel(null)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="modal-foot">
          <input
            type="text"
            aria-label="New character"
            placeholder="new character"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === 'Enter' || e.code === 'NumpadEnter') create()
            }}
          />
          <button className="btn primary" onClick={create} disabled={!newName.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
