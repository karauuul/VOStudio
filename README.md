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
- `src/shared/` — pure logic, no Electron and no DOM: data model (`domain.ts`), composition math (`comp.ts`), effect params and clamps (`effects.ts`), pitch math (`pitch.ts`), export planning (`export-plan.ts`), export preflight (`export-preflight.ts`), preview/output selectors (`workspace-source.ts`), generation target and clip placement (`generation.ts`), queue filters (`cue-filter.ts`), IPC types (`ipc.ts`).
- `src/renderer/` — React UI and audio engine.
  - Shell and rooms: `App.tsx` (project lifetime, shared state), `useProjectSession.ts` (snapshot, dispatch, draft flush), `shell/TopBar.tsx`, `shell/Logo.tsx`, `rooms/ImportRoom.tsx`, `rooms/WorkRoom.tsx`, `rooms/ExportRoom.tsx`, `ProjectTable.tsx`, `DeliverScreen.tsx`, `ProjectHome.tsx`, `StatusToast.tsx`.
  - Work centre: `work/LinesPanel.tsx` (lines list), `work/TextPanel.tsx` (original, translation and the generator grid), `CueEditor.tsx` (text/audio split), `Waveform.tsx` (peaks cache), `playback.ts` (shared playback intent), `keyboard.ts` (`e.code` dispatcher with focus scopes).
  - Overlays: `Overlay.tsx` (one manager), `SettingsDialog.tsx`, `ShortcutsDialog.tsx`, `CharactersDialog.tsx`, `JobsDrawer.tsx`, `RulesPanel.tsx`, `TemplatePreviewDialog.tsx`, `TemplateReimport.tsx`, `MigrationDialog.tsx` (legacy recovery, unmounted).
  - `cue/` — cue workspace: take source menu, lanes, timeline editor, inspector, recording hook.
  - `audio/` — `clip-graph.ts` (`buildClipGraph` / `scheduleComp`, the only place audio node chains are built), `transport.ts` (live playback), `offline-render.ts` (export rendering), `comp-source.ts`, `recorder.ts`, `duration-queue.ts`, `lru.ts`; `audio/worklets/` and `worklets/` (AudioWorklet sources, delivered as Blob URLs).
  - `export/run-export.ts` (`runJob` / `runPlan`), `jobs/` (queue and store), `api.ts` (typed IPC bridge and audio URLs).
  - `styles/` — `tokens.css`, `shell.css`, `base.css`, `work.css`, `import.css`, `export.css`, `overlays.css`; `app.css` imports them in that order.
- `tests/` — vitest, pure logic only.

## Project data

A project is a folder `<name>.vostudio/` containing `project.json` (cues, takes, compositions) and `ui.json` (view state). Audio takes are stored beside it.

## Documentation

- [docs/design/README.md](docs/design/README.md) — design spec: mocks, rules, hotkeys; [docs/design/model.md](docs/design/model.md) — data model behind the screens
- [docs/template-format.md](docs/template-format.md) — project template import/export format
- [AGENTS.md](AGENTS.md) — contributor and agent rules, including the invariants any change must preserve
