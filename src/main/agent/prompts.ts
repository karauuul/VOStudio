import { LINE_FILTERS } from '@shared/agent-lines'
import type { McpPrompt } from '@shared/mcp'

const steps = (head: string, items: string[]): string => [head, ...items.map((item, i) => `${i + 1}. ${item}`)].join('\n')

export const agentPrompts: McpPrompt[] = [
  {
    name: 'localize',
    title: 'Localize a folder',
    description: 'Checklist to turn a folder of original audio and scripts into voiced, exported lines in another language.',
    arguments: [
      { name: 'folder', description: 'Absolute path of the folder with the original audio and scripts', required: true },
      { name: 'targetLanguage', description: 'Language to translate and voice into', required: true },
    ],
    text: (a) =>
      steps(`Localize the voice-over in ${a.folder} into ${a.targetLanguage} with VO Studio. Work through the steps in order and report counts after each.`, [
        '`status`, then `project_open` to create a project or open the one the user names.',
        `\`asset_add\` ${a.folder}; \`assets\` and \`asset_read\` to learn the format of each file.`,
        '`lines_build` with strategy perFile for the audio; `link` scripts, tables and subtitles to the lines, first without apply, then with apply.',
        '`transcribe` lines that still have no original text (costs money), or `lines_build` from a subtitle asset.',
        '`characters`, then `characters_assign` from speakers, folders and context with confidence and reason; review with `proposals`.',
        `\`translate_context\` page by page, then \`translations_suggest\` into ${a.targetLanguage} within each line's length budget.`,
        '`glossary` upsert recurring names and terms with proposed true; `glossary_check` the translations.',
        '`voices`, then `character_set` a voice for each character.',
        '`generate` with dryRun true; show the user the characters, quota and budget and wait for approval; then `generate` with wait and `jobs` until every job finishes.',
        '`render` with withOriginal to compare each length with the original; `compare` each line for timing and intonation and apply its suggestions; `verify` a sample to compare the words (costs money); fix with `lines_edit` and `generate` again.',
        '`export` with dryRun true, then `export`.',
      ]),
  },
  {
    name: 'voice_lines',
    title: 'Voice lines',
    description: 'Checklist to generate, check and fix voice for lines of the open project.',
    arguments: [{ name: 'filter', description: `Line filter, default notgen: ${LINE_FILTERS.join(', ')}`, required: false, values: LINE_FILTERS }],
    text: (a) => {
      const filter = a.filter ?? 'notgen'
      return steps(`Voice the lines matching filter ${filter} in the open VO Studio project.`, [
        `\`status\` and \`lines\` with filter ${filter}; every line needs text and a character with a voice (\`characters\`, \`character_set\`).`,
        `\`generate\` with filter ${filter} and dryRun true: text, characters and skip reason per line, provider quota and agent budget. Show the user the total and wait for approval.`,
        'If the batch exceeds the budget, pass fewer lines or ask the user to raise Agent budget in Settings.',
        '`generate` with the same selection and wait, following nextCursor; `jobs` with wait until every job finishes.',
        'Check each line with `render`: length against the original, loudness, clipping, silence; `compare` timing and intonation against the original; `verify` doubtful ones.',
        'Fix: text with `lines_edit` or `rules`, voice settings with `character_set`, then `generate` again; `take_use` returns to an earlier take.',
      ])
    },
  },
  {
    name: 'smoke_test',
    title: 'Smoke test',
    description: 'App self-check through the tools; needs the app started with VOSTUDIO_PROVIDER=mock so nothing costs money.',
    arguments: [],
    text: () =>
      steps('Self-check VO Studio through its tools. Stop at the first failure and report it.', [
        '`status`: provider is mock; otherwise stop, because generation would cost money.',
        '`project_open` with create "Smoke test".',
        '`lines_edit` add three lines with short text; `voices`; `character_set` create a character with the first voice; `characters_assign` with apply set for every line.',
        '`generate` with filter all and dryRun true, then with wait; `jobs`: every job done without error.',
        '`render` one line: duration above 0 and finite LUFS.',
        '`export` with dryRun true: every line ready and no collisions.',
        '`diagnostics`: no entries.',
        '`project_close`.',
      ]),
  },
]
