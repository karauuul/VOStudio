# VO Studio

Desktop application for voice-over localization: import original lines and audio, generate or record takes, edit them on a timeline, export localized audio files.

## Stack

Electron 33 · electron-vite · React 18 · TypeScript · zod · zustand · Web Audio API · ffmpeg-static (encoder only). No other runtime dependencies; reverb, delay and pitch shifting are implemented on Web Audio / AudioWorklet.

## Commands

```
npm run dev        # dev app with HMR
npx tsc --noEmit   # typecheck
npm test           # vitest
npm run build      # electron-vite production build
npm run package    # build + electron-builder → release/win-unpacked
```

Example converter — turns a game export into a canonical project template, outside the app:

```
node scripts/convert-satisfactory.ts --csv <master_vo_table.csv> --audio <original_audio dir> --out <name.vostudio-src>
```

## Layout

- `src/main/` — Electron main process: project store (`project-store.ts`, atomic writes, autosave), IPC handlers and zod validation (`index.ts`, `schemas.ts`), export encoding (`export.ts`), provider adapters (`providers/elevenlabs.ts`), API keys via `safeStorage` (`secrets.ts`).
- `src/shared/` — pure logic, no Electron and no DOM: data model (`domain.ts`), composition math (`comp.ts`), effect params and clamps (`effects.ts`), pitch math (`pitch.ts`), export planning (`export-plan.ts`), IPC types (`ipc.ts`).
- `src/renderer/` — React UI and audio engine: `audio/clip-graph.ts` (`buildClipGraph` / `scheduleComp`, the only place audio node chains are built), `audio/transport.ts` (live playback), `audio/offline-render.ts` (export rendering), `audio/worklets/` and `worklets/` (AudioWorklet sources, delivered as Blob URLs), `cue/` (cue workspace).
- `tests/` — vitest, pure logic only.

## Project data

A project is a folder `<name>.vostudio/` containing `project.json` (cues, takes, compositions) and `ui.json` (view state). Audio takes are stored beside it.

## Documentation

- [docs/template-format.md](docs/template-format.md) — project template import/export format
- [AGENTS.md](AGENTS.md) — contributor and agent rules, including the invariants any change must preserve
