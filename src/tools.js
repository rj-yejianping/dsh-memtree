/**
 * Model-facing tools for the long-term memory plugin.
 *
 * The tools mirror QwenPaw's memory surface, minus the timer:
 * - `memory_search` retrieves hybrid-ranked snippets from the personal knowledge base.
 * - `memory_dream` consolidates changed daily notes into long-term digest nodes.
 * - `memory_status` reports the on-disk memory layout and index health.
 * - `memory_write` / `memory_edit` let the Agent record what it judges worth keeping.
 *
 * Nothing here runs on a schedule: there is no every-N-turns summarizer any more,
 * so the Agent itself decides when a piece of conversation deserves a note.
 *
 * All tools resolve their per-session runtime lazily from the calling Agent, so one
 * registration serves every workspace in the profile.
 *
 * @module dsh-long-term-memory/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatCoreUsage } from './core-budget.js'

const SEARCH_CALL_TITLE = { en: 'Search memory', zh: '检索长期记忆' }
const DREAM_CALL_TITLE = { en: 'Consolidate memory', zh: '整理长期记忆' }
const STATUS_CALL_TITLE = { en: 'Memory status', zh: '长期记忆状态' }
const WRITE_CALL_TITLE = { en: 'Write memory', zh: '写长期记忆' }
const EDIT_CALL_TITLE = { en: 'Edit memory', zh: '改长期记忆' }

function textOf(value) {
  return [{ type: 'text', text: value }]
}

/**
 * Build the three memory tools bound to one plugin instance.
 *
 * @param {object} options - tool factory inputs.
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent | undefined) => any} options.runtimeFor
 *   resolves (and lazily creates) the memory runtime owned by one Agent's working directory.
 * @param {object} options.config - normalized plugin configuration.
 * @param {string} options.language - resolved prompt language (`zh` | `en`).
 * @param {boolean} [options.editEnabled] - also register the two memory-editing tools.
 * @returns {Array<object>} tool definitions ready for `ctx.tools.register(...)`.
 */
export function createMemoryTools({ runtimeFor, config, language, editEnabled = false }) {
  const lang = language === 'zh' ? 'zh' : 'en'

  const memorySearch = defineTool({
    name: 'memory_search',
    description:
      'Search the personal knowledge base (daily memory notes and consolidated long-term knowledge) of the current '
      + 'Agent mode — memory is split per mode, so this searches only this session\'s tree. '
      + 'Use it whenever a request depends on the user\'s past facts, preferences, decisions, or experience, '
      + 'before answering from general knowledge. Results are ranked snippets with file paths and outlink/inlink '
      + 'relations; when a snippet is not enough, read its path with `read` to expand only what the task needs '
      + '(result paths are relative to the memory tree — prefix the tree root reported by `memory_status`).',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Natural-language question or keywords describing what to recall.',
      },
      limit: {
        type: 'integer',
        description: `Maximum number of ranked files to return (default ${config.search.maxResults}).`,
      },
      expand: {
        type: 'boolean',
        description: 'Also include snippets of directly linked notes (outlinks and inlinks). Defaults to true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          formatted: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                relPath: { type: 'string', required: true },
                startLine: { type: 'integer', required: true },
                endLine: { type: 'integer', required: true },
                score: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textOf(value.formatted),
    },
    async execute(args, exec) {
      const runtime = await runtimeFor(exec.agent)
      if (runtime === undefined) throw new Error('memory_search requires an owning agent session')
      const result = await runtime.searchMemory(args.query, {
        limit: args.limit,
        expand: args.expand,
        signal: exec.signal,
      })
      return {
        count: result.results.length,
        formatted: result.formatted,
        results: result.results.map((item) => ({
          relPath: item.relPath,
          startLine: item.startLine,
          endLine: item.endLine,
          score: Number(item.score.toFixed(6)),
          text: item.text,
        })),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: SEARCH_CALL_TITLE[lang],
      kind: 'other',
      rawInput: args.query,
    }),
  })

  const memoryDream = defineTool({
    name: 'memory_dream',
    description:
      'Consolidate recent daily memory notes into long-term knowledge nodes under the digest directory '
      + '(personal / procedure / wiki). Each affected node receives exactly one action: CREATE, CORROBORATE, '
      + 'REFINE, or CORRECT, with Auto Link wikilinks and a Sources section. Daily notes and MEMORY.md are never '
      + 'rewritten. Run it when the user asks to tidy memory, or after several days of accumulated notes; use '
      + 'dryRun to preview the planned actions without writing.',
    parameters: {
      dryRun: {
        type: 'boolean',
        description: 'Plan only; report the actions that would be taken without writing any file.',
      },
      force: {
        type: 'boolean',
        description: 'Process every daily note, ignoring the last-run watermark.',
      },
      maxNotes: {
        type: 'integer',
        description: 'Maximum number of daily notes to process in this run.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processed: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          actions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', required: true },
                category: { type: 'string', required: true },
                relPath: { type: 'string', required: true },
                name: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOf(value.summary),
    },
    async execute(args, exec) {
      const runtime = await runtimeFor(exec.agent)
      if (runtime === undefined) throw new Error('memory_dream requires an owning agent session')
      const outcome = await runtime.dream({
        dryRun: args.dryRun === true,
        force: args.force === true,
        maxNotes: args.maxNotes,
        signal: exec.signal,
      })
      return {
        processed: outcome.processed,
        skipped: outcome.skipped,
        actions: outcome.actions.map((action) => ({
          action: action.action,
          category: action.category ?? '',
          relPath: action.relPath ?? '',
          name: action.name ?? '',
          reason: action.reason ?? '',
        })),
        summary: outcome.summary,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: DREAM_CALL_TITLE[lang],
      kind: 'other',
      rawInput: args.dryRun === true ? 'dry run' : 'run',
    }),
  })

  const memoryStatus = defineTool({
    name: 'memory_status',
    description:
      'Report the long-term memory layout, file counts, index size, and last consolidation watermark for the '
      + 'current Agent mode; `root` is the memory tree this session reads and writes. '
      + 'Use it to verify that memory is enabled, to see where files live, or before cleaning up stale memory.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          memoryMdBytes: { type: 'integer', required: true },
          dailyNotes: { type: 'integer', required: true },
          topicNotes: { type: 'integer', required: true },
          digestNodes: { type: 'integer', required: true },
          chunks: { type: 'integer', required: true },
          lastDreamAt: { type: 'string', required: true },
          embeddings: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOf(value.summary),
    },
    async execute(_args, exec) {
      const runtime = await runtimeFor(exec.agent)
      if (runtime === undefined) throw new Error('memory_status requires an owning agent session')
      return await runtime.status()
    },
    presentCall: () => ({
      card: 'generic',
      title: STATUS_CALL_TITLE[lang],
      kind: 'other',
      rawInput: 'status',
    }),
  })

  const memoryWrite = defineTool({
    name: 'memory_write',
    description:
      'Create or update a file in the personal knowledge base (MEMORY.md, a daily note or journal page, or a digest node). '
      + 'Use it when the user asks you to remember, record, or update something long-lived. '
      + 'It writes the memory tree directly, so it works in any session permission mode, and it may only '
      + 'touch the memory tree of the current Agent mode: paths resolve inside that tree, and derived metadata is refused. '
      + 'Nothing is summarized automatically: when the conversation produced something durable (a preference, a decision, '
      + 'a settled fact, a runbook step), decide yourself that it is worth keeping and write it here.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path relative to this session\'s memory tree (an absolute path is accepted only inside that tree), ending in .md — `MEMORY.md`, `memory/<YYYY-MM-DD>.md`, `memory/<YYYY-MM-DD>/<topic>.md`, or `digest/<personal|procedure|wiki>/<topic>.md`.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Markdown to store. Existing frontmatter is preserved; a new file gets `name`/`description`, and you may supply your own frontmatter block.',
      },
      append: {
        type: 'boolean',
        description: 'Append to the existing body instead of replacing it. Defaults to false (replace).',
      },
      description: {
        type: 'string',
        description: 'One-line summary shown on the day index page. Only used when the file is new.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          action: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOf(value.summary),
    },
    async execute(args, exec) {
      const runtime = await runtimeFor(exec.agent)
      if (runtime === undefined) throw new Error('memory_write requires an owning agent session')
      const append = args.append === true
      const outcome = await runtime.writeMemoryFile(args.path, args.content, {
        append,
        description: typeof args.description === 'string' ? args.description : '',
      })
      await runtime.refreshAfterEdit(outcome.path)
      const label = lang === 'zh'
        ? { created: '已创建', updated: '已更新', appended: '已追加' }[outcome.action]
        : { created: 'Created', updated: 'Updated', appended: 'Appended' }[outcome.action]
      const coreNote = outcome.core ? ` · ${formatCoreUsage(lang, outcome.core)}` : ''
      return {
        path: outcome.path,
        action: outcome.action,
        bytes: outcome.bytes,
        summary: lang === 'zh'
          ? `${label}记忆文件 ${outcome.path}（${outcome.bytes} 字节），检索索引已刷新${coreNote}`
          : `${label} memory file ${outcome.path} (${outcome.bytes} bytes); search index refreshed${coreNote}`,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: WRITE_CALL_TITLE[lang],
      kind: 'other',
      rawInput: String(args?.path ?? ''),
    }),
  })

  const memoryEdit = defineTool({
    name: 'memory_edit',
    description:
      'Replace an exact string inside one existing memory file — for correcting a wrong conclusion or updating a '
      + 'preference in place. The text must be unique unless `replaceAll` is set; a missing or ambiguous match fails '
      + 'instead of guessing. Works in any session permission mode, only inside the current Agent mode\'s memory tree.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path relative to this session\'s memory tree (an absolute path is accepted only inside that tree), ending in .md — `MEMORY.md`, `memory/<YYYY-MM-DD>.md`, `memory/<YYYY-MM-DD>/<topic>.md`, or `digest/<personal|procedure|wiki>/<topic>.md`.',
      },
      oldString: {
        type: 'string',
        required: true,
        description: 'Exact text to replace, including surrounding words that make it unique.',
      },
      newString: {
        type: 'string',
        required: true,
        description: 'Replacement text; may be empty to delete the snippet.',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          replaced: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOf(value.summary),
    },
    async execute(args, exec) {
      const runtime = await runtimeFor(exec.agent)
      if (runtime === undefined) throw new Error('memory_edit requires an owning agent session')
      const outcome = await runtime.editMemoryFile(args.path, args.oldString, args.newString, {
        replaceAll: args.replaceAll === true,
      })
      await runtime.refreshAfterEdit(outcome.path)
      const coreNote = outcome.core ? ` · ${formatCoreUsage(lang, outcome.core)}` : ''
      return {
        path: outcome.path,
        replaced: outcome.replaced,
        bytes: outcome.bytes,
        summary: lang === 'zh'
          ? `已修改 ${outcome.path} 中 ${outcome.replaced} 处（${outcome.bytes} 字节），检索索引已刷新${coreNote}`
          : `Replaced ${outcome.replaced} occurrence(s) in ${outcome.path} (${outcome.bytes} bytes); search index refreshed${coreNote}`,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: EDIT_CALL_TITLE[lang],
      kind: 'other',
      rawInput: String(args?.path ?? ''),
    }),
  })

  const tools = [memorySearch, memoryDream, memoryStatus]
  if (editEnabled) tools.push(memoryWrite, memoryEdit)
  return tools
}
