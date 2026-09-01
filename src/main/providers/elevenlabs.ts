import type { UsageInfo, VoiceSettings } from '@shared/domain'
import { getApiKey } from '../secrets'

const BASE = 'https://api.elevenlabs.io/v1'

async function key(): Promise<string> {
  const k = await getApiKey()
  if (!k) throw new Error('ElevenLabs API key is not set')
  return k
}

export async function tts(req: {
  text: string
  voiceId: string
  model: string
  settings: VoiceSettings
}): Promise<Buffer> {
  const r = await fetch(`${BASE}/text-to-speech/${req.voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': await key(),
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: req.text,
      model_id: req.model,
      voice_settings: {
        stability: req.settings.stability,
        similarity_boost: req.settings.similarity,
        style: req.settings.style,
        speed: req.settings.speed,
        use_speaker_boost: req.settings.boost,
      },
    }),
  })
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return Buffer.from(await r.arrayBuffer())
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
