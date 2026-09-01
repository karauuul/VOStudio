# VO Studio project template — format v1

Import format accepted by the app, and the export package it produces.

## Source structure

```
<name>.vostudio-src/
  project-meta.json
  index.csv
  terms.csv
  audio/
```

`terms.csv` may contain only the header row. `audio/` may be nested to any depth.

## project-meta.json

```json
{
  "formatVersion": 1,
  "name": "Satisfactory UA",
  "sourceLang": "en",
  "targetLang": "uk"
}
```

## index.csv

UTF-8. First row is the header. One cue per row.

| Column | Required | Value |
|---|---|---|
| `cueId` | yes | Unique stable cue id, unchanged across re-imports |
| `character` | yes | Character/voice name; empty = unassigned |
| `sourceText` | yes | Original text of the cue |
| `translation` | no | Translated text; empty = not translated |
| `refAudio` | yes | Path to the original audio, relative to `audio/`; may be empty |
| `exportName` | yes | File name of the exported file, without extension; unique |
| `status` | no | Empty, or `excluded`. All other states are set by the app |
| `durationHint` | no | Duration of the original in seconds (number) |
| `note` | no | Free-form text |

Validation rules:

- `cueId` is unique within the file.
- `exportName` is unique within the file.
- Every non-empty `refAudio` resolves to an existing file under `audio/`.
- Supported reference formats: wav, mp3, ogg.

## terms.csv

| Column | Required | Value |
|---|---|---|
| `term` | yes | Term in the source language |
| `translation` | yes | Translation of the term |
| `note` | no | Free-form text |

## Import behavior

1. The structure and the validation rules above are checked. Errors are reported as a list of row + reason.
2. Fatal errors block the import: duplicate `cueId`, duplicate `exportName`, malformed CSV.
3. A `refAudio` that does not resolve is not fatal; the cue is imported and flagged as missing audio.
4. The first rows are shown as a preview before the project is created.
5. Re-importing `index.csv` into an existing project matches rows on `cueId`: unknown `cueId` is added, changed `sourceText` and `translation` are updated, takes, comps and approvals are left untouched.

## Export package

```
<name>-export/
  audio/<exportName>.<ext>
  index.updated.csv
  report.json
```

- `audio/<exportName>.<ext>` — rendered files; extension is set by the Export Profile.
- `index.updated.csv` — `index.csv` with current `translation` and `status`.
- `report.json` — per cue: `exported` or `failed` with a reason.
