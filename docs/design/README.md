# Design spec

Frozen reference for the redesign. Every UI change is measured against these mocks and rules. The mocks are static HTML (1920x1080) with their PNG renders; open the HTML in a browser to inspect exact sizes and colors. `model.md` describes the data model behind the screens.

| State | Files |
|---|---|
| Work, line selected, clip selected | `work-line-selected.html` / `.png` |
| Work, nothing selected | `work-nothing-selected.html` / `.png` |
| Work, library source selected (Source monitor) | `work-library-source.html` / `.png` |
| Work, line that is a region of a video | `work-video-line.html` / `.png` |
| Import room | `import.html` / `.png` |
| Export room | `export.html` / `.png` |
| Context menus (all six, drawn on the Work screen) | `context-menus.html` / `.png` |
| Logo | `logo.svg` |

## One law

Everything imported is a **source** with time. A **line** is a **region** on a source: for separate files the region is the whole file, for a long video there are hundreds of regions on one source. The same screen serves both.

A line is a mini project: original audio, original text, translation text, and a **composition** (timeline) for the translation.

**Generate** and **Record** produce new sources. A new source lands in the **library** and, at the same moment, as a clip on the line's timeline. Removing a clip from the timeline never removes the source from the library.

A **clip** is a piece of a library source (source + in/out) placed on a track. Pieces of different sources sit side by side. A source carries the text it was generated from and per-word timings, so a clip shows its words wherever it came from.

Sources with identical text inside one line are **versions** of each other (v1, v2, v3 by creation order). Recorded sources are numbered `take 1`, `take 2`. A source can be **pinned**: it shows in the library of every line.

**Effects** live on two levels: on a source (travels with the source) and on a track (applies to every clip on it). Both are stacks with an add control. Fades and gain are edited on the clip on the timeline and as numbers in Properties, never with sliders.

The **Original** lane is heard through a headphone toggle (preview only) and exported according to its own mode: Off (default), On, with a Duck level. Stems can be split on demand; each stem gets the same controls.

The composition has one or more **tracks**. Exactly one track is the **target** (blue numbered badge); Generate and Record land there. Each track has mute, solo, gain and its own voice.

A line has its own in and out on the ruler; out may extend beyond the original.

Three **rooms**: Import, Work, Export (`Ctrl+1/2/3`). Progress counters live in Export, not in the top bar.

Video is the same model with a picture in the Program monitor. Without video the monitor is black and shows the current sentence as subtitles (original above, translation below).

The project file stays readable and editable by external agents.

## Generation rule

What is generated: the selection. A selected clip regenerates its own text; a text selection in the translation generates those words; nothing selected generates the whole translation. The translation text underlines what the next Generate will produce.

Where it lands: a selected clip is replaced in place (its old source stays in the library, the clip shows the version chip `v1 v2 v3`); otherwise at the playhead on the target track; if that place is occupied, on the next free track below, which becomes the target.

Record follows the same rule.

## Visual standard

Neutral surfaces, color only where it carries meaning: the track strip, the waveform, the selection.

```
--bg      #191b1e   window and gutters
--panel   #222428   panel surface
--raise   #2b2e33   raised controls, group headers
--raise2  #34383e   hover
--line    #35383e   hairlines inside a panel
--line2   #42464d   control borders
--tx      #e3e6eb   primary text
--tx2     #a3aab5   secondary text
--tx3     #6f7680   tertiary text, units, ids
--ac      #82acec   interaction only: selection, focus, target badge, primary button
--ac-bg   #243247   selected row background
--err     #e5655f   record dot, errors
--ok      #46c98c   ready
--orig    #8f97a8   original lane waveform
--l1      #3fb8a8   track 1 waveform and strip
--l2      #a58cf0   track 2 waveform and strip, recordings
--mono    "Cascadia Mono", Consolas, monospace
--sans    "Segoe UI", system-ui, sans-serif
--ctl     28px      control height
--hd      36px      panel header height
--r       4px       control radius
```

Layout rules:

- Panels are rounded (6px) surfaces separated by 8px gutters of `--bg`; the window has an 8px padding. Splitters live in the gutters.
- Inside a panel only 1px `--line` hairlines. No borders around panels.
- Panel header: 36px, bold 13px title, optional mono counter in `--tx3`, tabs right-aligned with a 2px accent underline.
- Controls are 28px high, 4px radius. Fields have `--bg` background and `--line2` border. Buttons have `--raise` background. Primary button is `--ac` with dark text.
- Group labels are short uppercase 11px (`VOICE`, `GENERATE`, `RECORD`, `MICROPHONE`, `STABILITY`). Nothing else is labeled.
- Numbers are monospace. Units sit inside the field in `--tx3`.
- No sentences, hints, tooltips with prose, status pills, kind badges or tags that restate what the eye sees. No hotkey badges; hotkeys show only on hover.
- Ids, durations and timecodes are mono `--tx3`.
- Top bar: logo, project name (editable), version picker, Save version, rooms centered, gear right. Nothing else.

## Work room

Grid: Lines 280px | 8px | center | 8px | right column 380px. Center: upper row 410px (Text | 8px | Program 620px) then 8px then Timeline. Right column: Library on top, Properties below.

**Lines**: search field, groups by character (uppercase label), rows 52px: original text, id in mono below, duration right; a 5px status dot on the left (none: nothing, yellow: has composition, green: exported). Selected row: `--ac-bg` background and a 3px accent bar.

**Text**: header `Text` + line id. Two blocks, `ORIGINAL` and `TRANSLATION`, each with a color square, language and length on the right (`EN · 8.20s`, `UK · 84`). Whole text in 17px, editable as one block. Underline (2px accent) marks the part the next Generate produces. Generator grid below in four columns: Voice, Generate (split button), Record, Microphone, then Stability, Similarity, Style, Speed as numeric fields.

**Program**: header `Program` + `no video` or timecode, Fit and aspect fields on the right. Black frame with subtitles. Transport row: timecode `00:05.12 / 00:08.62`, go-in, step back, Play (40px), step forward, go-out, and on the right Loop toggle, full screen, volume.

**Timeline**: header `Timeline` with `in`, `out`, `Δ` mono values, zoom slider and unit picker (Seconds / Timecode) on the right. Ruler. Lanes with a 190px strip. Original strip: `0` badge, name, S, M, headphone toggle; rows Gain, Export Off/On, Duck dB, Stems Split. Track strip: numbered badge (blue when target), name, S, M; row Gain. Clips carry a version chip (`v1`) or `take 1`, their words, the waveform in the track color, duration bottom right, fade handles as dark triangles. Selected clip: accent border and the version chips `v1 v2 v3` top right. Bottom bar: `+ Add track`, tools (select, razor, trim, fade, slip), Snap toggle and snap unit (`words`).

**Library**: tabs `This line` / `Project`, search icon. Groups by text (raised header with the text; pinned groups show a pin and the use count `21×`). Rows 40px: version label, waveform in the source color, duration, menu. A green 3px bar on the left marks sources used on this timeline. Selected row: `--ac-bg`.

**Properties**: tabs `Clip` / `Track` / `Line`. Head: name of the selection and a subtitle in mono (`Track 1 · v3 · ADA / Rachel`). Sections `Audio` (Gain dB, Speed ×), `Timing` (Start s, End s, Fade in s, Fade out s), `Clip effects` and `Track effects` as stacks with checkbox, name, expander and a `+` in the section header.

**Nothing selected**: Text empty with the generator still visible, Program black with no subtitles, Timeline with the Original lane only and an empty target track, Library `This line` empty, Properties `Line`.

**Library source selected**: Program switches to the `Source` tab: waveform with in/out, caption with the text and generation settings; transport gets `Insert` and `Replace` buttons. Properties shows `Source`: Generated with (Voice, Speed, Stability, Similarity, Style, Model), Used in, Source effects.

**Video line**: Lines lists regions ordered by time under scene headers, each with character and timecode. Text header shows the region timecodes. Program shows the frame with a timecode overlay. Timeline gets a navigator strip under the header (whole source, regions as ticks, current region in accent, viewport box) and a Timecode ruler; the Original lane shows the region as a clip with the surrounding audio dimmed.

## Import room

Grid: Sources 340px | 8px | Lines | 8px | right column 380px.

**Sources**: drop zone with `Files` and `Folder`, list of sources (folder of audio, video, text tables) with counts; footer with the language pair.

**Lines**: header with counter and filter tabs (`All`, `No transcript`, `No translation`, `Unmatched`), toolbar with search, `Detect lines`, `Transcribe`, `Translate` (split buttons with a provider menu) and `Import text`. Table: `#`, `SOURCE` (id, mono), `LENGTH`, `ORIGINAL · EN`, `TRANSLATION · UK`, `CHARACTER`. Status dot per row. Footer with counts and `Open in Work`.

**Project**: Languages, Match by, Output name. **Characters**: name, line count, voice picker; `no character` row; `+` in the header.

## Export room

Grid: Output 340px | 8px | Lines | 8px | Summary 380px.

**Output**: Folder, Name pattern, Format, Loudness, Length; Video: Container, Name; footer with the last export version and time.

**Lines**: header counter and tabs `All`, `Ready`, `Changed`, `Not ready`; search and `Open in Work`. Table: `SOURCE`, `OUTPUT`, `ORIGINAL` length, `OUTPUT` length, `STATUS` (dot + words: Ready, Ready · changed, Longer by 0.42s, No audio, Name collision), `EXPORTED` version.

**Summary**: progress rows Translated / Voiced / Done with bars and counts; Will export with the size; Unchanged, Changed; Not ready split by reason; Video. Buttons `Export changed N` and primary `Export N`.

## Context menus

Menus are 230px wide, 26px rows, hotkeys mono on the right, separators between groups, destructive item red at the bottom.

- **Clip**: Play clip `Shift+Space`, Regenerate `Ctrl+G`, Version ▸ (v1 4.88s, v2 5.02s, ✓ v3 4.70s, New from text…) | Split at playhead `C`, Split by words, Fit to original length, Reset fades and gain | Move to track ▸, Pin source to all lines, Show in Library | Delete `Del`.
- **Library source**: Audition `Space`, Insert at playhead `,`, Replace selected clip `.` | Regenerate with same settings, Pin to all lines, Show where used | Copy text, Reveal file | Delete `Del`.
- **Line**: Open `Enter`, Play original, Play translation | Generate `Ctrl+G`, Copy original, Copy translation, Copy as prompt | Exclude from export, Reveal source file | Reset line.
- **Track strip**: Rename, Set as target, Mute `M`, Solo | Track effects…, Duplicate track, Move up, Move down | Delete track.
- **Translation text**: Generate selection `Ctrl+G`, Find on timeline, Split clip here | Cut, Copy, Paste.

## Hotkeys

`Space` play/pause always, in every focus state except while typing in a text field. `Shift+Space` plays the selected clip. `Ctrl+G` generate. `C` razor, `V` select, `Del` delete. `M` mute on the hovered track. `S` cuts the clip under the playhead on the target track. `,` insert, `.` replace from the Source monitor. `Ctrl+1/2/3` rooms. `I`/`O` set in/out from anywhere in Work. Hotkeys use `e.code`.
