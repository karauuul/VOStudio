# Data model for the redesign

The screens in this folder are built on the existing project format. New concepts map onto existing types; every new field is optional and absent until used, so a project written by an older build reads and saves byte-identical (AGENTS.md rule 2). No schema version bump.

## Mapping

| Screen concept | Type | Notes |
|---|---|---|
| Line | `Cue` | Unchanged. `sourceText` is the original, `text` the translation. |
| Original source of a line | `Cue.referenceAudio` | Whole-file region. For a video line see `Cue.region`. |
| Library source | `Take` | Already carries file, duration, `meta.text`, `meta.voiceSettings`, `kind`, source-level `edits` (effects travel with the source). |
| Version label (v1, v2, take 1) | derived | Live takes of the line with identical `meta.text` (trimmed) ordered by `createdAt`; `recording` kind counts separately as `take N`. Not stored. |
| Pinned source | `Take.pinned?: true` | Shows in the library of every line. The library `Project` tab and pinned groups read takes of all cues. |
| Word timings | `Take.words?: WordTiming[]` | `{ text, start, end }` in source seconds. Present for TTS sources generated with timestamps; absent for recordings and imports. A clip with no words shows the source text as one word. |
| Composition | `Cue.comp` (`CueComp`) | Unchanged: `clips`, `region` (the line's own in/out). |
| Track | `CueComp.tracks?: CompTrack[]` | `{ id, name, characterId?, gainDb, muted, solo, effects? }`. Absent means one implicit track named `Track 1` with default values. |
| Clip on a track | `CompClip.trackId?: string` | Absent means the first track. |
| Clip words | derived | `Take.words` cut to `[srcIn, srcOut]`. |
| Target track | UI state | `ui.json`, per line: `targetTrackId`. Never in `project.json`. |
| Original lane controls | `Cue.original?: OriginalLane` | `{ exportMode: 'off' \| 'on', duckDb?: number, previewMuted?: true }`. Absent = Off, preview audible. Duck applies when `exportMode` is `on` and `duckDb` is set. |
| Stems | `Cue.stems?: Stem[]` | Milestone 12. `{ id, name, file: AudioRef, exportMode, duckDb? }`. |
| Long source (video or long audio) | `Project.sources?: ProjectSource[]` | `{ id, file: AudioRef, kind: 'audio' \| 'video', duration, name }`. |
| Region of a long source | `Cue.region?: { sourceId, in, out }` | When present the original lane plays `[in, out]` of that source; `referenceAudio` stays undefined. |
| Project version | folder `versions/` | `Save version` copies `project.json` to `versions/v<N>.json` and records `{ n, name?, createdAt }` in `project.json` `versions?: ProjectVersion[]`. Export writes the version it used. |
| Characters and voices | `Character` | Unchanged. `Character.color` drives the Lines group label only; track colors come from the track index. |
| Rooms | `Route` | `'import' \| 'work' \| 'export'` replaces `'work' \| 'project' \| 'deliver'`. |

## Audio engine

All audible behavior stays inside `scheduleComp` / `buildClipGraph`. Per-track gain, mute, solo and track effects are applied there by grouping clip voices per track into one gain node per track. The Original lane in preview is a separate voice scheduled by the same function with `previewMuted` honoured. Export of a line with `original.exportMode === 'on'` mixes the original at `duckDb` and therefore always renders offline (`export-plan.ts` treats it as `hasEdits`). No new DSP. `transport.ts` and `offline-render.ts` stay consumers.

## Sanitizers and schemas

Each new field gets: a clamp or sanitize function in `src/shared/`, a zod mirror in `src/main/schemas.ts` (zod strips unknown keys), a serialization roundtrip test, and a test proving a project without the field behaves exactly as before.

## Word timings from ElevenLabs

`POST /v1/text-to-speech/{voice}/with-timestamps` returns base64 audio plus character alignment (`characters`, `character_start_times_seconds`, `character_end_times_seconds`). Words are built by grouping characters at whitespace. The plain endpoint stays for speech-to-speech; recordings get no words.
