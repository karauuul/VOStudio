import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  DEFAULT_VOICE_SETTINGS,
  ELEVENLABS_STS_MODEL,
  ELEVENLABS_TTS_MODEL,
  characterColor,
  type Character,
  type Cue,
  type Project,
  type ProjectSource,
} from '@shared/domain'
import type { ChangeSet } from '@shared/project-commands'
import type { DetectResult } from '@shared/ipc'
import {
  mergeRegionCues,
  parseSilence,
  regionCues,
  regionsBetween,
  transcriptRegions,
  type DetectedRegion,
} from '@shared/sources'
import { ffmpegStderr, probeMedia, runFfmpeg } from './ffmpeg'
import { sttWords } from './providers/elevenlabs'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv'])
const MEDIA_EXT = new Set([...VIDEO_EXT, '.m4a'])
const LONG_AUDIO_SECONDS = 60
const SILENCE_DB = -35
const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024

function isMediaContainer(file: string): boolean {
  return MEDIA_EXT.has(path.extname(file).toLowerCase())
}

export async function splitMediaPaths(paths: string[]): Promise<{ media: string[]; rest: string[] }> {
  const media: string[] = []
  const rest: string[] = []
  for (const p of paths) {
    const stat = await fs.stat(p).catch(() => null)
    if (!stat?.isFile()) {
      rest.push(p)
      continue
    }
    if (isMediaContainer(p)) {
      media.push(p)
      continue
    }
    const probe = await probeMedia(p).catch(() => null)
    if (probe && (probe.duration ?? 0) > LONG_AUDIO_SECONDS) media.push(p)
    else rest.push(p)
  }
  return { media, rest }
}

function sourcesDir(projectDir: string): string {
  return path.join(projectDir, 'audio', 'sources')
}

export async function importSources(
  project: Project,
  projectDir: string,
  paths: string[]
): Promise<{ added: ProjectSource[]; changes: ChangeSet }> {
  const dir = sourcesDir(projectDir)
  await fs.mkdir(dir, { recursive: true })
  const added: ProjectSource[] = []
  for (const file of paths) {
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) continue
    if (stat.size > MAX_SOURCE_BYTES) throw new Error(`"${path.basename(file)}" is too large to import`)
    const probe = await probeMedia(file)
    if (!probe.hasAudio) throw new Error(`"${path.basename(file)}" has no audio track`)
    const id = randomUUID()
    const wav = path.join(dir, `${id}.wav`)
    await runFfmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav])
    const duration = probe.duration ?? (await probeMedia(wav)).duration ?? 0
    added.push({
      id,
      name: path.basename(file),
      kind: probe.hasVideo ? 'video' : 'audio',
      file: { fileId: id, relPath: wav, format: 'wav', sampleRate: 48000, channels: 1 },
      duration,
      media: file,
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      ...(probe.channels ? { channels: probe.channels } : {}),
    })
  }
  if (added.length === 0) return { added, changes: {} }
  project.sources = [...(project.sources ?? []), ...added]
  return { added, changes: { sources: structuredClone(project.sources) } }
}

function sourceById(project: Project, sourceId: string): ProjectSource {
  const source = project.sources?.find((s) => s.id === sourceId)
  if (!source) throw new Error('Source not found')
  return source
}

async function silenceRegions(source: ProjectSource): Promise<DetectedRegion[]> {
  const stderr = await ffmpegStderr([
    '-i',
    source.file.relPath,
    '-af',
    `silencedetect=noise=${SILENCE_DB}dB:d=0.6`,
    '-f',
    'null',
    '-',
  ])
  return regionsBetween(parseSilence(stderr), source.duration).map((r) => ({ in: r.start, out: r.end }))
}

async function speechRegions(source: ProjectSource): Promise<DetectedRegion[]> {
  const audio = await fs.readFile(source.file.relPath)
  return transcriptRegions(await sttWords({ audio, filename: `${source.id}.wav` }))
}

function speakerCharacters(project: Project, regions: DetectedRegion[]): Character[] {
  const fresh: Character[] = []
  for (const speaker of new Set(regions.map((r) => r.speaker).filter(Boolean) as string[])) {
    const known = [...project.characters, ...fresh].some(
      (c) => c.name.toLowerCase() === speaker.toLowerCase()
    )
    if (known) continue
    fresh.push({
      id: randomUUID(),
      name: speaker,
      color: characterColor(project.characters.length + fresh.length),
      provider: {
        providerId: 'elevenlabs',
        voiceId: '',
        ttsModel: ELEVENLABS_TTS_MODEL,
        stsModel: ELEVENLABS_STS_MODEL,
      },
      voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
    })
  }
  return fresh
}

export async function detectLines(
  project: Project,
  sourceId: string,
  mode: 'silence' | 'transcribe'
): Promise<{ result: DetectResult; changes: ChangeSet }> {
  const source = sourceById(project, sourceId)
  const regions = mode === 'silence' ? await silenceRegions(source) : await speechRegions(source)
  const fresh = speakerCharacters(project, regions)
  project.characters.push(...fresh)
  const byName = new Map(project.characters.map((c) => [c.name.toLowerCase(), c.id]))
  const merge = mergeRegionCues(project.cues, sourceId)
  const baseName = source.name.replace(/\.[^.]+$/, '')
  const seeds = regionCues(baseName, regions, (speaker) =>
    speaker ? (byName.get(speaker.toLowerCase()) ?? '') : ''
  )
  const added: Cue[] = seeds.map((seed) => ({
    id: randomUUID(),
    characterId: seed.characterId,
    key: seed.key,
    fields: { EventName: seed.key },
    sourceText: seed.sourceText,
    text: '',
    status: 'empty',
    notes: '',
    takes: [],
    referenceDuration: seed.out - seed.in,
    region: { sourceId, in: seed.in, out: seed.out },
  }))
  const removed = new Set(merge.removedIds)
  project.cues = [...project.cues.filter((c) => !removed.has(c.id)), ...added]
  return {
    result: { added: added.length, kept: merge.keep.length, removed: merge.removedIds.length },
    changes: {
      ...(merge.removedIds.length > 0 ? { removedCueIds: merge.removedIds } : {}),
      ...(fresh.length > 0 ? { characters: structuredClone(project.characters), charactersReplace: true } : {}),
      cues: structuredClone(added),
    },
  }
}

export async function muxVideo(
  outPath: string,
  videoPath: string | null,
  raw: string,
  sampleRate: number,
  channels: number
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const input = ['-f', 'f32le', '-ar', String(sampleRate), '-ac', String(channels), '-i', raw]
  if (!videoPath) {
    await runFfmpeg([...input, '-c:a', 'pcm_s24le', outPath])
    return
  }
  await runFfmpeg([
    '-i',
    videoPath,
    ...input,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    outPath,
  ])
}
