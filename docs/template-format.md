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

- Column names are unique, not purely numeric and not JavaScript object property names such as `__proto__`.
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
2. Fatal errors block the import:
   - `project-meta.json` missing, not valid JSON, failing the schema, or naming a project that already exists
   - `index.csv` missing, malformed (unterminated quoted field), missing a required column, or containing no data rows
   - a row whose cell count differs from the header
   - empty `cueId`, empty `exportName`, empty `sourceText`
   - duplicate `cueId`; duplicate `exportName` (compared case-insensitively)
   - `exportName` that is not a safe file name (path separators, `..`, `<>:"|?*`, control characters, trailing dot or space)
   - `status` other than empty or `excluded`
   - `refAudio` outside `audio/`, in an unsupported format, or resolving through a link outside `audio/`
3. A `refAudio` that does not resolve is not fatal; the cue is imported and flagged as missing audio.
4. The first rows are shown as a preview before the project is created.
5. Re-importing `index.csv` into an existing project matches rows on `cueId`: unknown `cueId` is added, changed `sourceText` and `translation` are updated, takes, comps and approvals are left untouched.

## Export package

```
<name>.vostudio/export/
  audio/<exportName>.<ext>
  index.updated.csv
  report.json
```

- `audio/<exportName>.<ext>` — rendered files; extension follows the take format.
- `index.updated.csv` — `index.csv` in the original column order with current `translation` and `status` (`approved`, `excluded` or empty); `translation` and `status` columns are appended when the original header lacks them. Written only for projects created from a template.
- `report.json` — `{ formatVersion, project, createdAt, scope, exported[], failed[], skipped[] }`; `exported` entries carry `cueId`, `exportName`, `file`, `bytes`, `sha256`; `failed` entries carry a `reason`; `skipped` entries list cues dropped by a collision strategy.
