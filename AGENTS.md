# Agent rules — VO Studio

Canon for any AI agent working in this repo. Read README.md first for architecture.

## Gates (mandatory before claiming done)

```
npx tsc --noEmit          # clean
npx vitest run            # ALL green, no skips
npx electron-vite build   # passes
```

For UI/audio changes: also start the built app and verify zero JS errors (CDP run of the packaged app is the norm for worklet/asar-sensitive changes). Show gate output in your report.

## Hard rules

1. **Parity.** All audible behavior goes through `scheduleComp`/`buildClipGraph` (`src/renderer/audio/clip-graph.ts`). Never add audio logic to `offline-render.ts`, `transport.ts` or UI components directly — those are consumers of the one scheduler. If live and export can diverge, the design is wrong.
2. **Byte-identical old projects.** New model fields are optional and absent until used. Every new field: clamp/sanitize function in `src/shared/`, zod mirror in `src/main/schemas.ts` (zod strips unknown keys — missing this silently destroys the field on save), serialization roundtrip test, and a test that old data behaves exactly as before.
3. **No new runtime dependencies.** DSP is hand-written on Web Audio/AudioWorklet. Worklet code ships as an embedded string via Blob URL (see `pitch-node.ts`) — `?url`/`?worker` imports break under `file://` inside asar.
4. **Non-destructive audio.** Takes are never overwritten or deleted by edits; everything is parametric and undoable. Slider drags commit as ONE undo step on release.
5. **Hotkeys: `e.code` only** — hotkeys must use `e.code`, not `e.key`; layouts other than QWERTY (e.g. Cyrillic) break `e.key`. Check for conflicts with the existing map (`src/renderer/keyboard.ts`) before adding.
6. **UI: English, zero explanatory text.** Everything discoverable visually — buttons, badges, hotkey badges. No prose in the UI.
7. **Secrets.** API keys only via `safeStorage` (`src/main/secrets.ts`). Never in code, project files, logs or test fixtures.
8. **Zero comments in code.** No comments of any kind in source files — no explanations, no doc blocks, no TODO/ponytail markers, no commented-out code. Code must carry its meaning through names and structure; anything that needs prose goes into the PR description or docs/. When touching a file that still has legacy comments, delete the ones inside the lines you change.

## YAGNI ladder (ponytail) — before writing ANY code

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line.
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write.
3. **Stdlib / native platform covers it?** Web platform feature, CSS over JS, Electron built-in, DB/schema constraint over app code.
4. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do (rule 3 above already forbids new runtime deps).
5. **Can it be one line?** One line.
6. **Only then:** the minimum code that works.

No unrequested abstractions (interface with one implementation, factory for one product, config for a constant). No scaffolding "for later". Deletion over addition; shortest working diff — but only after reading every file the change touches and tracing the real flow. Bug fix = root cause in the shared path, not a guard in one caller. Never simplify away: input validation at trust boundaries, error handling preventing data loss, security, or anything the spec explicitly requires. Deliberate ceilings and their upgrade paths are named in the PR description, not in code comments (rule 8).

## Working style

- Do not commit unless explicitly asked; the orchestrator verifies gates independently and commits one feature per commit.
- Do not touch unrelated subsystems (recorder, CSV, migration, jobs) unless the task says so.
- Testing against real project data: never open a real project in place — copy it to a temp dir, use an isolated `--user-data-dir`, kill all electron processes and delete the sandbox afterwards.
- Packaging: kill any running "VO Studio" process first (`Access denied` otherwise), then `npm run package`.
- Pure logic lives in `src/shared/` and gets unit tests; keep Web Audio/DOM out of it so vitest can run it.
