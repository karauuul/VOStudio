import type { UsageInfo, VoiceSettings, WordTiming } from '@shared/domain'
import type { ProviderVoice } from '@shared/ipc'
import { wordsFromAlignment } from '@shared/library'
import { getApiKey } from '../secrets'

const BASE = 'https://api.elevenlabs.io/v1'

async function key(): Promise<string> {
  const k = await getApiKey()
  if (!k) throw new Error('ElevenLabs API key is not set')
  return k
}

export interface TtsRequest {
  text: string
  voiceId: string
  model: string
  settings: VoiceSettings
}

const ttsBody = (req: TtsRequest): string =>
  JSON.stringify({
    text: req.text,
    model_id: req.model,
    voice_settings: {
      stability: req.settings.stability,
      similarity_boost: req.settings.similarity,
      style: req.settings.style,
      speed: req.settings.speed,
      use_speaker_boost: req.settings.boost,
    },
  })

export async function tts(req: TtsRequest): Promise<Buffer> {
  const r = await fetch(`${BASE}/text-to-speech/${req.voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': await key(),
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: ttsBody(req),
  })
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return Buffer.from(await r.arrayBuffer())
}

export async function ttsWithTimestamps(
  req: TtsRequest
): Promise<{ audio: Buffer; words?: WordTiming[] }> {
  const r = await fetch(`${BASE}/text-to-speech/${req.voiceId}/with-timestamps`, {
    method: 'POST',
    headers: {
      'xi-api-key': await key(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: ttsBody(req),
  })
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const data = (await r.json()) as { audio_base64?: unknown; alignment?: unknown }
  if (typeof data.audio_base64 !== 'string' || !data.audio_base64) {
    throw new Error('ElevenLabs returned no audio')
  }
  const audio = Buffer.from(data.audio_base64, 'base64')
  const words = wordsFromAlignment(data.alignment)
  return words ? { audio, words } : { audio }
}

export async function sts(req: {
  audio: Buffer
  filename: string
  voiceId: string
  model: string
  settings: VoiceSettings
}): Promise<Buffer> {
  const form = new FormData()
  const view = new Uint8Array(req.audio.byteLength)
  view.set(req.audio)
  form.append('audio', new Blob([view], { type: 'audio/wav' }), req.filename)
  form.append('model_id', req.model)
  form.append(
    'voice_settings',
    JSON.stringify({
      stability: req.settings.stability,
      similarity_boost: req.settings.similarity,
      use_speaker_boost: req.settings.boost,
    })
  )

  let r: Response
  try {
    r = await fetch(`${BASE}/speech-to-speech/${req.voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': await key(), Accept: 'audio/mpeg' },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('ElevenLabs STS: timed out after 120s — try again manually')
    }
    throw e
  }
  if (!r.ok) throw new Error(`ElevenLabs STS ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return Buffer.from(await r.arrayBuffer())
}

export const ELEVENLABS_STT_MODEL = 'scribe_v1'

export async function stt(req: { audio: Buffer; filename: string }): Promise<string> {
  const form = new FormData()
  const view = new Uint8Array(req.audio.byteLength)
  view.set(req.audio)
  form.append('file', new Blob([view]), req.filename)
  form.append('model_id', ELEVENLABS_STT_MODEL)

  let r: Response
  try {
    r = await fetch(`${BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': await key(), Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('ElevenLabs STT: timed out after 120s — try again manually')
    }
    throw e
  }
  if (!r.ok) throw new Error(`ElevenLabs STT ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const data = (await r.json()) as { text?: unknown }
  if (typeof data.text !== 'string') throw new Error('ElevenLabs STT returned no text')
  return data.text.trim()
}

export async function voices(): Promise<ProviderVoice[]> {
  const r = await fetch(`${BASE}/voices`, { headers: { 'xi-api-key': await key() } })
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const data = (await r.json()) as { voices?: unknown }
  if (!Array.isArray(data.voices)) return []
  const out: ProviderVoice[] = []
  for (const raw of data.voices) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { voice_id?: unknown; name?: unknown }
    if (typeof row.voice_id !== 'string' || !row.voice_id) continue
    out.push({ id: row.voice_id, name: typeof row.name === 'string' && row.name ? row.name : row.voice_id })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function usage(): Promise<UsageInfo | null> {
  try {
    const r = await fetch(`${BASE}/user/subscription`, {
      headers: { 'xi-api-key': await key() },
    })
    if (!r.ok) return null
    const d = (await r.json()) as { character_count?: number; character_limit?: number }
    const used = d.character_count ?? 0
    const limit = d.character_limit ?? 0
    return { used, limit, remaining: limit - used, unit: 'chars' }
  } catch {
    return null
  }
}
