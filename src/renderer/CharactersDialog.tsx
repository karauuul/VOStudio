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
import { ConfirmDialog, Overlay } from './Overlay'

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
  hasKey: boolean
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
  hasKey,
  onVoiceSettings,
  onProvider,
  onFlushVoice,
  onCancelVoice,
  dispatch,
  onStatus,
  onClose,
}: Props) {
  const [selectedId, setSelectedId] = useState(characters[0]?.id ?? '')
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

  const selected = characters.find((c) => c.id === selectedId) ?? characters[0]

  const run = (command: ProjectCommand, done?: () => void): void => {
    void dispatch(command).then(
      () => done?.(),
      (e: unknown) => onStatus('err', String(e))
    )
  }

  const remove = (characterId: string, reassignTo: string): void => {
    onCancelVoice(characterId)
    setDel(null)
    run({ type: 'character.delete', characterId, reassignTo }, () => {
      if (selectedId === characterId) setSelectedId('')
    })
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
    const id = crypto.randomUUID()
    run({ type: 'character.create', id, name }, () => {
      setNewName('')
      setSelectedId(id)
    })
  }

  const busy = selected ? testing.has(selected.id) : false
  const count = selected ? (counts.get(selected.id) ?? 0) : 0
  const others = characters.filter((c) => c.id !== selected?.id)
  const v = selected?.voiceSettings

  return (
    <Overlay title="Characters & Voices" label="Characters and voices" onClose={onClose} drawer wide>
      <div className="modal-body md">
        <div className="md-list">
          {characters.length === 0 && <div className="home-empty">No characters</div>}
          {characters.map((c) => (
            <button
              key={c.id}
              className={'md-item' + (c.id === selected?.id ? ' on' : '')}
              onClick={() => setSelectedId(c.id)}
            >
              <span className="char-dot" style={{ background: c.color }} />
              <span className="md-name">{c.name}</span>
              <span className="dim">{counts.get(c.id) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="md-detail">
          {!selected || !v ? (
            <div className="insp-empty">Select a character</div>
          ) : (
            <>
              <div className="row">
                <DraftField
                  label="Name"
                  value={selected.name}
                  onCommit={(name) =>
                    run({ type: 'character.rename', characterId: selected.id, name })
                  }
                />
                <span className="dim">{count} cues</span>
              </div>

              <div className="sec-h">Voice</div>
              <div className="row">
                <DraftField
                  label="Voice ID"
                  value={selected.provider.voiceId}
                  placeholder="voice id"
                  onCommit={(voiceId) => onProvider(selected.id, { voiceId })}
                />
                <button
                  className="btn ghost"
                  onClick={() => void test(selected)}
                  disabled={busy || !hasKey || !selected.provider.voiceId}
                  title={
                    !hasKey
                      ? 'API key missing'
                      : selected.provider.voiceId
                        ? 'Test voice'
                        : 'No voice configured'
                  }
                >
                  {busy ? <span className="spin" /> : '▶'} Test voice
                </button>
              </div>

              <div className="row">
                <select
                  aria-label="TTS model"
                  value={selected.provider.ttsModel}
                  onChange={(e) => onProvider(selected.id, { ttsModel: e.target.value })}
                >
                  {modelOptions(TTS_MODELS, selected.provider.ttsModel).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="STS model"
                  value={selected.provider.stsModel}
                  onChange={(e) => onProvider(selected.id, { stsModel: e.target.value })}
                >
                  {modelOptions(STS_MODELS, selected.provider.stsModel).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sec-h">Character defaults</div>
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
                        onVoiceSettings(selected.id, {
                          ...v,
                          [k.key]: fromSlider(Number(e.target.value)),
                        })
                      }
                    />
                    <span className="knob-v">{knobText(k, v[k.key])}</span>
                  </label>
                ))}
                <label className="knob tgl">
                  <input
                    type="checkbox"
                    checked={v.boost}
                    onChange={(e) => onVoiceSettings(selected.id, { ...v, boost: e.target.checked })}
                  />
                  Boost
                </label>
              </div>

              <div className="row md-actions">
                <button
                  className="btn danger"
                  onClick={() => setDel({ id: selected.id, to: '' })}
                >
                  Delete
                </button>
              </div>
            </>
          )}
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

      {del && selected && (
        <ConfirmDialog
          operation="Delete character"
          name={selected.name}
          onClose={() => setDel(null)}
          detail={
            count > 0 ? (
              <select
                aria-label="Reassign cues"
                value={del.to}
                onChange={(e) => setDel({ id: del.id, to: e.target.value })}
              >
                <option value="">Unassign {count} cues</option>
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    Reassign {count} cues to {c.name}
                  </option>
                ))}
              </select>
            ) : undefined
          }
          choices={[
            { label: 'Delete', kind: 'danger', onClick: () => remove(del.id, del.to) },
            { label: 'Cancel', safe: true, onClick: () => setDel(null) },
          ]}
        />
      )}
    </Overlay>
  )
}
