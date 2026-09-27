# Agent API

VO Studio runs an MCP server inside the app. An AI agent (Claude Code, Codex, Claude Desktop or any MCP client) drives the same project the user sees: every change goes through the app's project commands, shows up in the window live and is undoable. There is no separate backend and no cloud relay.

The server speaks MCP (JSON-RPC 2.0, protocol versions 2025-11-25, 2025-06-18 and 2025-03-26) with the `tools` and `prompts` capabilities. Clients reach it through the bridge `bridge.js`, a small stdio process that connects to the running app and launches it when it is not running.

## Enabling

- **Settings → Agent access**: the server runs while the app is open. The setting persists.
- **`--agent`**: start the app with the server on for this run, regardless of the setting.
- **`--headless`**: start the app without a window, with the server on. Rendering and export use a hidden render window created on demand. `status` reports `mode: "headless"`, `screenshot` is unavailable. Launching the app again without `--headless` opens the normal window in the same process. A headless app keeps running until `app_quit` (or `bridge.js stop`); closing a window opened later does not quit it.

The app is single-instance: a second launch with `--agent` or `--headless` turns the server on in the running app.

## Connecting

The Windows installer places `vostudio-mcp.cmd` next to `VO Studio.exe` (per-user install: `%LOCALAPPDATA%\Programs\VO Studio`). It runs the bundled bridge with the app's own runtime; no Node.js install is needed.

### Claude Code

```
claude mcp add -s user vostudio -- "<install dir>\vostudio-mcp.cmd"
```

### Codex

```
codex mcp add vostudio -- "<install dir>\vostudio-mcp.cmd"
```

Generation and export calls can wait up to 45 s per call; raise the tool timeout in `~/.codex/config.toml`:

```toml
[mcp_servers.vostudio]
tool_timeout_sec = 120
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vostudio": {
      "command": "<install dir>\\vostudio-mcp.cmd",
      "args": []
    }
  }
}
```

Add `"--headless"` to `args` to have the bridge start the app without a window when it is not running. By default the bridge starts the visible app.

## CLI

The bridge doubles as a command line client:

```
vostudio-mcp.cmd call <tool> '<json arguments>'
vostudio-mcp.cmd stop
```

`call` prints the tool's structured result as JSON (an image result is saved to a temporary PNG and its path printed) and exits 1 with the error on stderr when the tool fails. `stop` calls `app_quit`; it quits only a headless app with no window open and does nothing when the app is not running.

Bridge options: `--user-data-dir <dir>` (or `VOSTUDIO_USER_DATA`) selects the app profile to connect to and launch; `--headless` launches the app headless when it has to start it.

### From a checkout

```
npx electron-vite build
node out/main/bridge.js --user-data-dir /tmp/vo-profile --headless call status
node out/main/bridge.js --user-data-dir /tmp/vo-profile call project_open '{"create":"Test"}'
node out/main/bridge.js --user-data-dir /tmp/vo-profile stop
```

Without a packaged app the bridge launches `node_modules/electron` with the checkout. `VOSTUDIO_PROJECTS_ROOT` sets the projects folder of the launched app.

## Safety model

- **Local only.** The server listens on a Unix socket inside the user data folder (a named pipe keyed by it on Windows). The first line of every connection must be the random token the app writes to `agent-token` in the user data folder on each start (owner-only file mode on macOS and Linux). Without Agent access or `--agent`/`--headless` nothing listens.
- **No keys.** API keys stay in the OS keychain (`safeStorage`); no tool returns them. `status` only says whether one is stored.
- **Budget.** Voice generation through the agent is capped per connection by Settings → Agent budget (characters, default 20 000, 0 = unlimited). `generate` refuses a batch that would exceed it; `generate` with `dryRun` shows the cost first.
- **Before agent versions.** Before an agent's first change to a project the app saves a version named "Before agent" (unless any version was saved in the last 10 minutes), restorable from Versions.
- **Reviewable.** Inferred characters, row links and glossary terms are stored as proposals with confidence and reason; translations are pending suggestions. The user accepts or rejects them in the app, or the agent does through `proposals`.
- **Non-destructive.** Takes are never deleted; generation adds takes and places them on the timeline.

## Tools

Project

- `status` — app version, provider, headless or live mode, open project, selected line
- `projects` — projects in the projects folder
- `project_open` — open, create, or import a template
- `project_close` — save and close
- `versions` — list, save, restore versions
- `command` — run one raw project command

Lines and characters

- `lines` — paged line list with the app's filters
- `line` — one line in full
- `lines_edit` — add, delete, set text or character, exclude, mark done
- `characters` — characters with voice settings
- `character_set` — create or change a character
- `characters_assign` — propose or set characters for lines
- `voices` — voices and models of the provider

Bin and linking

- `asset_add` — add files or folders to the bin as they are
- `assets` — bin contents with link counts
- `asset_read` — read an asset as the app parses it
- `lines_build` — lines from audio files or from asset rows
- `link` — link asset rows to existing lines
- `proposals` — list, accept, reject inferred proposals and suggestions
- `import` — legacy import of audio, a table or a template

Text and translation

- `transcribe` — speech-to-text into the original text
- `translate_context` — everything needed to translate a page of lines
- `translations_suggest` — store translations as pending suggestions
- `glossary` — list, upsert, remove terms
- `glossary_check` — translations missing a glossary term
- `rules` — pronunciation rules

Generation

- `generate` — queue voice generation, with `dryRun` for cost
- `jobs` — list, wait for, cancel generation jobs
- `take_use` — place an existing take on the timeline

Editing

- `timeline` — a line's tracks, clips and word timings in seconds
- `edit` — split, cut, move, gaps, speed, gain, fades, crossfades as one change; takes are never modified
- `effects` — clip, track or take effect stacks and presets
- `align` — plan (or apply) edits that fit the dub to the original's phrase rhythm

Check and export

- `render` — render a line exactly like export and measure it
- `verify` — render, transcribe and compare with the line text
- `analyze` — intonation, rhythm and emphasis of a line as numbers and a prosody transcript
- `compare` — timing and intonation of the voiced line against the original, with edit suggestions
- `export` — export ready lines, with `dryRun` for the plan

App

- `diagnostics` — recent renderer and main process errors
- `screenshot` — PNG of the app window
- `app_quit` — save and quit a headless app once running calls finish

## Prompts

- `localize` — arguments `folder`, `targetLanguage`: from a folder of audio and scripts to exported localized lines
- `voice_lines` — argument `filter` (a line filter, default `notgen`): dry run, budget, generate, check, fix
- `smoke_test` — app self-check through the tools with the mock provider

## Testing with the mock provider

`VOSTUDIO_PROVIDER=mock` swaps the voice provider for an offline one: voices `mock-alto`, `mock-bass`, `mock-tenor`, synthetic speech whose length follows the text, and transcription that reads back text the mock generated. Nothing leaves the machine and nothing costs money.

`scripts/agent-e2e.mjs` runs the whole flow against a headless app with the mock provider (bin, lines, linking, proposals, characters, generation, render, compare, export, diagnostics, quit). Run it manually after a build:

```
npx electron-vite build
xvfb-run -a node scripts/agent-e2e.mjs
```
