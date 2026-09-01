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

const MODELS = [ELEVENLABS_TTS_MODEL, ELEVENLABS_STS_MODEL]

const modelOptions = (current: string): string[] =>
  MODELS.includes(current) ? MODELS : [current, ...MODELS]

interface Props {
  characters: Character[]
  cues: Cue[]
  onVoiceSettings: (characterId: string, settings: VoiceSettings) => void
  dispatch: (command: ProjectCommand) => Promise<void>
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onClose: () => void
}

export function CharactersDialog({ characters, cues, onVoiceSettings, dispatch, onStatus, onClose }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [del, setDel] = useState<{ id: string; to: string } | null>(null)
  const [testing, setTesting] = useState('')
  const testUrl = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (testUrl.current) URL.revokeObjectURL(testUrl.current)
    },
    []
  )

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

  const clearDraft = (key: string): void =>
    setDraft((d) => {
      const { [key]: _drop, ...rest } = d
      return rest
    })

  const commitName = (character: Character): void => {
    const key = 'n:' + character.id
    const value = draft[key]
    clearDraft(key)
    if (value === undefined || value.trim() === character.name) return
    run({ type: 'character.rename', characterId: character.id, name: value })
  }

  const commitVoiceId = (character: Character): void => {
    const key = 'v:' + character.id
    const value = draft[key]
    clearDraft(key)
    if (value === undefined || value.trim() === character.provider.voiceId) return
    run({
      type: 'character.setProvider',
      characterId: character.id,
      voiceId: value,
      ttsModel: character.provider.ttsModel,
      stsModel: character.provider.stsModel,
    })
  }

  const setModel = (character: Character, patch: { ttsModel?: string; stsModel?: string }): void =>
    run({
      type: 'character.setProvider',
      characterId: character.id,
      voiceId: character.provider.voiceId,
      ttsModel: patch.ttsModel ?? character.provider.ttsModel,
      stsModel: patch.stsModel ?? character.provider.stsModel,
    })

  const test = async (character: Character): Promise<void> => {
    setTesting(character.id)
    try {
      const bytes = await api['provider:testVoice'](character.id)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
      if (testUrl.current) URL.revokeObjectURL(testUrl.current)
      testUrl.current = url
      void transport.playClip({ id: 'test:' + character.id, url }, 0)
    } catch (e) {
      onStatus('err', String(e))
    } finally {
      setTesting('')
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
              const v = character.voiceSettings
              return (
                <div className="coll" key={character.id}>
                  <div className="row">
                    <span className="char-dot" style={{ background: character.color }} />
                    <input
                      type="text"
                      aria-label="Name"
                      value={draft['n:' + character.id] ?? character.name}
                      onChange={(e) => setDraft((d) => ({ ...d, ['n:' + character.id]: e.target.value }))}
                      onBlur={() => commitName(character)}
                      onKeyDown={(e) => {
                        if (e.code === 'Enter' || e.code === 'NumpadEnter') e.currentTarget.blur()
                      }}
                    />
                    <input
                      type="text"
                      aria-label="Voice ID"
                      placeholder="voice id"
                      value={draft['v:' + character.id] ?? character.provider.voiceId}
                      onChange={(e) => setDraft((d) => ({ ...d, ['v:' + character.id]: e.target.value }))}
                      onBlur={() => commitVoiceId(character)}
                      onKeyDown={(e) => {
                        if (e.code === 'Enter' || e.code === 'NumpadEnter') e.currentTarget.blur()
                      }}
                    />
                    <span className="dim">{count} cues</span>
                  </div>

                  <div className="row">
                    <select
                      aria-label="TTS model"
                      value={character.provider.ttsModel}
                      onChange={(e) => setModel(character, { ttsModel: e.target.value })}
                    >
                      {modelOptions(character.provider.ttsModel).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="STS model"
                      value={character.provider.stsModel}
                      onChange={(e) => setModel(character, { stsModel: e.target.value })}
                    >
                      {modelOptions(character.provider.stsModel).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <span className="sp" />
                    <button
                      className="btn ghost"
                      onClick={() => void test(character)}
                      disabled={testing === character.id || !character.provider.voiceId}
                      title={character.provider.voiceId ? 'Test' : 'No voice configured'}
                    >
                      {testing === character.id ? <span className="spin" /> : '▶'} Test
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (count > 0) {
                          setDel({ id: character.id, to: '' })
                          return
                        }
                        if (confirm(`Delete ${character.name}?`)) {
                          run({ type: 'character.delete', characterId: character.id, reassignTo: '' })
                        }
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
                      <button
                        className="btn danger"
                        onClick={() =>
                          run({ type: 'character.delete', characterId: character.id, reassignTo: del.to }, () =>
                            setDel(null)
                          )
                        }
                      >
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
