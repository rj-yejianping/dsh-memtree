/**
 * QwenPaw-style long-term memory for DeepSeek Harness.
 *
 * Ports the mechanism described in QwenPaw's long-term memory cycle into one Host
 * plugin: memory-as-file (`MEMORY.md`, daily notes, `digest/` knowledge), on-demand
 * summaries written by the Agent itself, Auto Dream consolidation, and hybrid search.
 *
 * Runtime shape:
 * - one {@link MemoryRuntime} per memory root (resolved from the session working directory);
 * - `memory_search` / `memory_dream` / `memory_status` / `memory_write` / `memory_edit`
 *   tools registered once;
 * - a system-prompt guidance section plus an Agent-scoped core-memory section;
 * - no scheduled capture: the Agent decides what to record, and only Auto Dream runs
 *   on a daily clock (as detached background work, never inside a turn).
 *
 * @module dsh-memtree
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { CREDENTIAL_GROUPS, DEFAULT_CONFIG, applyOverrides, isCredentialRefName, normalizeApiKeyEnv, repairOverridesDocument, resolveBaseRoot, resolveConfig, resolvePresetRoot } from './src/config.js'
import { MemoryStore } from './src/store.js'
import { MemoryIndexer } from './src/indexer.js'
import { MemorySearch } from './src/search.js'
import { LlmHelper } from './src/llm.js'
import { AutoDream } from './src/auto-dream.js'
import { buildMemoryGuidance, resolveLanguage } from './src/prompts.js'
import { createMemoryTools } from './src/tools.js'
import { registerWebApi } from './src/web-api.js'
import { PresetSettings, overridesFile, readOverridesSync, writeOverrides } from './src/settings.js'
import { stringifyFrontmatter } from './src/markdown.js'
import { coreBudgetMessage, coreUsage } from './src/core-budget.js'
import { dailyDue, epochMs, localDate } from './src/time.js'

/** Loader plugin name. */
export const name = 'long-term-memory'

/** Required registries; optional capabilities are wired through `ctx.inject`. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Credential slot used when a group has no explicit name configured. */
const CREDENTIAL_FALLBACK = 'DSH_LONG_TERM_MEMORY_KEY'

const GUIDANCE_SECTION = 'long-term-memory:guidance'
const CORE_SECTION = 'long-term-memory:core'

/** Schemastery schema surfaced by `Config.listConfigs` and the settings UI. */
export const Config = z.object({
  root: z.string().default(DEFAULT_CONFIG.root).description('Memory root; relative paths resolve against the session working directory.'),
  language: z.string().default('auto').description("Prompt and report language: 'auto' | 'zh' | 'en'."),
  dailyDir: z.string().default(DEFAULT_CONFIG.dailyDir).description('Daily-note directory inside the memory root.'),
  digestDir: z.string().default(DEFAULT_CONFIG.digestDir).description('Consolidated-knowledge directory inside the memory root.'),
  metaDir: z.string().default(DEFAULT_CONFIG.metaDir).description('Derived index/cache directory inside the memory root.'),
  scope: z.object({
    mode: z.string().default('all').description("'all' = enabled for every Agent mode except `presets`; 'selected' = only the listed ones."),
    presets: z.array(z.string()).description('Exception list: excluded modes under all, enabled modes under selected.').default([...DEFAULT_CONFIG.scope.presets]),
    subagents: z.string().default(DEFAULT_CONFIG.scope.subagents).description("'exclude' = subagent sessions record no memory and get no prompt injection (any Agent mode); 'include' = treat them like top-level sessions."),
  }),
  perPreset: z.boolean().default(true).description('Keep one memory tree per Agent mode under the working directory.'),
  backgroundModel: z.object({
    baseURL: z.string().default('').description('OpenAI-compatible base URL for background summarization; empty uses the Host llm route.'),
    apiKeyEnv: z.string().default('UNIAPI_API_KEY').description('Credential name resolved through the Host credential service.'),
    provider: z.string().default('').description('Registered Host provider route (used when baseURL is empty).'),
    model: z.string().default('').description('Background model id.'),
    maxTokens: z.number().step(1).default(8192).description('Default output budget for background calls; reasoning models need headroom.'),
    temperature: z.number().default(0.2).description('Default sampling temperature for background calls.'),
    timeoutMs: z.number().step(1).default(240000).description('Direct-endpoint request timeout; scaled up automatically for large output budgets.'),
  }),
  autoDream: z.object({
    enabled: z.boolean().default(true).description('Allow Auto Dream consolidation.'),
    autoRun: z.boolean().default(true).description('Run Auto Dream on the daily clock below instead of only on demand.'),
    intervalMinutes: z.number().step(1).default(0).description('Additional Auto Dream interval in minutes (0 = off).'),
    dailyAt: z.string().default('04:00').description("Local daily time 'HH:MM' for Auto Dream; empty disables the daily schedule."),
    minChangedNotes: z.number().step(1).default(1).description('Minimum changed daily notes before an automatic run.'),
    maxNotesPerRun: z.number().step(1).default(4).description('Maximum daily notes consolidated in one run (bounds one night of spend).'),
    maxDigestNodes: z.number().step(1).default(40).description('Maximum digest candidates considered per note.'),
    model: z.object({
      baseURL: z.string().description('Override base URL for Auto Dream only.'),
      apiKeyEnv: z.string().description('Override credential name for Auto Dream only.'),
      provider: z.string().description('Override Host provider for Auto Dream only.'),
      model: z.string().description('Override model id for Auto Dream only.'),
      maxTokens: z.number().step(1).description('Override output budget.'),
      temperature: z.number().description('Override temperature.'),
      timeoutMs: z.number().step(1).description('Override request timeout.'),
    }),
  }),
  search: z.object({
    maxResults: z.number().step(1).default(8).description('Maximum ranked files returned by memory_search.'),
    maxSnippetLines: z.number().step(1).default(18).description('Maximum snippet lines rendered per result.'),
    expandLinks: z.boolean().default(true).description('Expand outlinks/inlinks of matched notes.'),
    maxExpansions: z.number().step(1).default(4).description('Maximum linked notes added by expansion.'),
    bm25: z.object({
      k1: z.number().default(1.5).description('BM25 term-frequency saturation.'),
      b: z.number().default(0.75).description('BM25 length normalization.'),
    }),
    embeddings: z.object({
      enabled: z.boolean().default(false).description('Enable optional OpenAI-compatible embedding search.'),
      baseURL: z.string().default('').description('Embedding endpoint base URL (POST /embeddings).'),
      apiKeyEnv: z.string().default('DEEPSEEK_API_KEY').description('Environment variable holding the embedding API key.'),
      model: z.string().default('').description('Embedding model id.'),
      timeoutMs: z.number().step(1).default(15000).description('Embedding request timeout.'),
    }),
  }),
  inject: z.object({
    guidance: z.boolean().default(true).description('Inject the memory guidance section into the system prompt.'),
    memoryMd: z.boolean().default(true).description('Inject a bounded MEMORY.md excerpt into the system prompt.'),
    memoryMdMaxBytes: z.number().step(1).default(4096).description('Maximum MEMORY.md bytes injected.'),
    edit: z.boolean().default(true).description('Expose memory_write / memory_edit so the agent can edit memory directly (any session permission mode, memory tree only).'),
  }),
  debug: z.boolean().default(false).description('Verbose plugin logging.'),
})

/**
 * Merge one task's model overrides over the shared background model route.
 *
 * The task config only carries explicitly written fields, so undefined entries
 * must not erase the shared defaults.
 *
 * @param {object} config - normalized plugin configuration.
 * @param {'autoDream'} task - task name.
 * @returns {object} effective route for that task.
 */
function mergedModel(config, task) {
  const base = config.backgroundModel ?? {}
  const override = config[task]?.model ?? {}
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value
  }
  return merged
}

/** Truncate a string to a byte-ish budget on a line boundary. */
function truncateText(text, maxBytes) {
  if (maxBytes <= 0 || text.length === 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let budget = maxBytes
  let out = ''
  for (const line of text.split('\n')) {
    const next = out.length === 0 ? line : `${out}\n${line}`
    const bytes = Buffer.byteLength(next, 'utf8')
    if (bytes > budget) break
    out = next
  }
  return out.length > 0 ? `${out}\n…` : ''
}

/**
 * One memory runtime bound to an absolute root. Instances are cached so search,
 * dream, tools, and prompt sections share the same index and caches.
 */
export class MemoryRuntime {
  /**
   * @param {string} root - absolute memory root.
   * @param {object} deps - plugin-scoped dependencies.
   */
  constructor(root, deps) {
    this.root = root
    this.config = deps.config
    this.language = deps.language
    this.logger = deps.logger
    this.store = new MemoryStore({
      root,
      dailyDir: deps.config.dailyDir,
      digestDir: deps.config.digestDir,
      metaDir: deps.config.metaDir,
    })
    this.indexer = new MemoryIndexer({ store: this.store, config: deps.config, logger: deps.logger })
    this.search = new MemorySearch({
      store: this.store,
      indexer: this.indexer,
      config: deps.config,
      logger: deps.logger,
      resolveApiKey: deps.resolveApiKey,
    })
    /**
     * Route for one background task, with its credential name normalized.
     *
     * The route is only given a key name when it calls an explicit endpoint: a
     * route without `baseURL` goes through the Host LLM service and needs none.
     * The name comes from the plugin rather than the raw config so a rejected
     * `apiKeyEnv` can never leak into a request.
     */
    const routeFor = (task, group) => {
      const route = mergedModel(deps.config, task)
      if (typeof route.baseURL === 'string' && route.baseURL.length > 0) {
        const name = typeof deps.credentialName === 'function' ? deps.credentialName(group) : ''
        if (typeof name === 'string' && name.length > 0) route.apiKeyEnv = name
      }
      return route
    }
    this.dreamLlm = new LlmHelper({
      llm: deps.llm,
      defaultModel: deps.defaultModel,
      logger: deps.logger,
      config: deps.config,
      taskModel: () => routeFor('autoDream', 'dream'),
      resolveApiKey: deps.resolveCredential,
    })
    this.autoDream = new AutoDream({
      store: this.store,
      indexer: this.indexer,
      search: this.search,
      llm: this.dreamLlm,
      config: deps.config,
      logger: deps.logger,
    })
    /** Created lazily: reading or browsing a disabled mode must not create files. */
    this.layoutReady = undefined
    this.coreCache = { text: '', mtimeMs: -1, bytes: 0 }
  }

  /** Create the memory layout only (seeds MEMORY.md and the directory skeleton). */
  async ensureLayout() {
    if (this.layoutReady === undefined) this.layoutReady = this.store.ensureLayout()
    await this.layoutReady
  }

  /** Create the memory layout and make the index usable. */
  async ensure() {
    await this.ensureLayout()
    await this.indexer.ensure()
  }

  /** Rebuild the index in the background (new/updated files picked up on next search). */
  ensureIndexInBackground() {
    void this.indexer.refresh().catch((error) => {
      this.logger?.debug?.(`[long-term-memory] background index refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Read MEMORY.md through an mtime cache for synchronous prompt assembly. */
  coreMemoryText() {
    const limit = this.config.inject.memoryMdMaxBytes
    if (limit <= 0) return ''
    const path = join(this.root, 'MEMORY.md')
    try {
      const stat = statSync(path)
      if (stat.mtimeMs !== this.coreCache.mtimeMs) {
        const text = readFileSync(path, 'utf8')
        this.coreCache = { text, mtimeMs: stat.mtimeMs, bytes: Buffer.byteLength(text, 'utf8') }
      }
    } catch {
      return this.coreCache.text
    }
    return truncateText(this.coreCache.text, limit)
  }

  /** Search the personal knowledge base. */
  async searchMemory(query, { limit, expand, signal } = {}) {
    await this.ensure()
    return this.search.search(query, { limit, expand, signal })
  }

  /** Consolidate changed daily notes into long-term knowledge. */
  async dream({ dryRun = false, force = false, maxNotes, signal } = {}) {
    await this.ensure()
    const outcome = await this.autoDream.run({ dryRun, force, maxNotes, signal })
    if (!dryRun && outcome.processed.length > 0) this.ensureIndexInBackground()
    return { ...outcome, summary: this.formatDreamSummary(outcome, dryRun) }
  }

  /** Human-readable consolidation summary. */
  formatDreamSummary(outcome, dryRun) {
    const zh = this.language === 'zh'
    const lines = []
    lines.push(zh ? `记忆整理${dryRun ? '（预演，未写入）' : '完成'}：处理 ${outcome.processed.length} 条每日笔记，跳过 ${outcome.skipped.length} 条。` : `Memory dream ${dryRun ? 'dry run' : 'finished'}: ${outcome.processed.length} daily note(s) processed, ${outcome.skipped.length} skipped.`)
    for (const action of outcome.actions) {
      const target = action.relPath !== undefined && action.relPath.length > 0 ? action.relPath : '(new)'
      lines.push(`- ${String(action.action).toUpperCase()} ${target}${action.reason ? ` — ${action.reason}` : ''}`)
    }
    if (outcome.actions.length === 0) lines.push(zh ? '- 没有需要整理的新记忆。' : '- Nothing new to consolidate.')
    return lines.join('\n')
  }

  /** Memory layout and index health (tool/command payload). */
  async status() {
    await this.ensure()
    const files = await this.store.listMarkdown()
    const dailyPrefix = `${this.config.dailyDir}/`
    const digestPrefix = `${this.config.digestDir}/`
    const dailyNotes = files.filter((file) => file.relPath.startsWith(dailyPrefix) && /\/\d{4}-\d{2}-\d{2}\.md$/.test(file.relPath)).length
    const topicNotes = files.filter((file) => file.relPath.startsWith(dailyPrefix) && !/\/\d{4}-\d{2}-\d{2}\.md$/.test(file.relPath)).length
    const digestNodes = files.filter((file) => file.relPath.startsWith(digestPrefix)).length
    const meta = await this.store.loadMeta('dream-state')
    const dreamAt = epochMs(meta?.lastRunAt)
    const chunks = (await this.indexer.ensure()).chunks ?? 0
    const memoryMd = this.coreMemoryText()
    const embeddingsReady = await this.search.embeddingsReady()
    const zh = this.language === 'zh'
    const summary = zh
      ? [
          `记忆根目录：${this.root}`,
          `MEMORY.md：${Buffer.byteLength(memoryMd, 'utf8')} 字节（注入上限 ${this.config.inject.memoryMdMaxBytes}）`,
          `每日索引：${dailyNotes} 个；主题笔记：${topicNotes} 个；长期知识节点：${digestNodes} 个`,
          `索引片段：${chunks} 个；向量检索：${embeddingsReady ? this.config.search.embeddings.model : '未启用'}`,
          `上次整理：${dreamAt > 0 ? new Date(dreamAt).toISOString() : '从未'}`,
        ].join('\n')
      : [
          `Memory root: ${this.root}`,
          `MEMORY.md: ${Buffer.byteLength(memoryMd, 'utf8')} bytes (injection limit ${this.config.inject.memoryMdMaxBytes})`,
          `Daily index pages: ${dailyNotes}; topic notes: ${topicNotes}; digest nodes: ${digestNodes}`,
          `Indexed chunks: ${chunks}; embeddings: ${embeddingsReady ? this.config.search.embeddings.model : 'disabled'}`,
          `Last dream: ${dreamAt > 0 ? new Date(dreamAt).toISOString() : 'never'}`,
        ].join('\n')
    return {
      root: this.root,
      memoryMdBytes: Buffer.byteLength(memoryMd, 'utf8'),
      dailyNotes,
      topicNotes,
      digestNodes,
      chunks,
      lastDreamAt: dreamAt > 0 ? new Date(dreamAt).toISOString() : '',
      embeddings: embeddingsReady ? this.config.search.embeddings.model : 'disabled',
      summary,
    }
  }

  /**
   * Normalize a model-supplied path and refuse everything the agent must not write.
   *
   * The memory root lives outside the session workspace, so a model-supplied path
   * is the only thing standing between "update a note" and "rewrite a state file":
   * derived caches are refused here, not merely discouraged in a description.
   *
   * Day index pages are deliberately *allowed*: only their managed `notes:auto`
   * block and the auto `description` are maintained by the plugin, while the prose
   * around it belongs to the user and the agent. Refusing the page also
   * contradicted the guidance, which tells the agent it may keep that journal.
   *
   * @param {string} relPath - memory-relative path from the tool call.
   * @returns {string} normalized memory-relative path.
   */
  editableRelPath(relPath) {
    const input = String(relPath ?? '').trim().replace(/^\.\//, '')
    const treeRoot = this.root.replace(/\/+$/, '')
    // The guidance names the tree with an absolute path, so an Agent may echo it
    // back into `path`. Accepting that form while it stays inside this tree keeps
    // the common slip from failing; an absolute path to a *sibling* mode is
    // refused with the tree name instead of being mangled into `root/.dsh/...`
    // and reported as "only MEMORY.md, memory/** and digest/** are editable".
    let stripped = input
    if (isAbsolute(input)) {
      const normalized = normalize(input)
      if (normalized !== treeRoot && !normalized.startsWith(`${treeRoot}/`)) {
        throw new Error(`memory paths are relative to this session's memory tree (${treeRoot}); an absolute path outside it is refused`)
      }
      stripped = normalized.slice(treeRoot.length)
    }
    const raw = stripped.replace(/^\/+/, '')
    if (raw.length === 0) throw new Error('a memory path is required (for example MEMORY.md or memory/2026-10-22/topic.md)')
    if (raw.includes('..')) throw new Error('memory paths must not contain ".."')
    if (!raw.toLowerCase().endsWith('.md')) throw new Error('memory paths must end with .md')
    const parts = raw.split('/').filter((part) => part.length > 0 && part !== '.')
    if (parts.length === 0) throw new Error('a memory path is required')
    const [head] = parts
    if (head === this.config.metaDir) {
      throw new Error(`${this.config.metaDir}/ holds derived state (index, caches); edit memory notes instead`)
    }
    const isCore = parts.length === 1 && head === 'MEMORY.md'
    if (!isCore && head !== this.config.dailyDir && head !== this.config.digestDir) {
      throw new Error(`only MEMORY.md, ${this.config.dailyDir}/** and ${this.config.digestDir}/** are editable`)
    }
    return parts.join('/')
  }

  /**
   * Create or update one memory file.
   *
   * Frontmatter is preserved for files that already have it, so appending to
   * `MEMORY.md` cannot lose its `summary`/`read_when` header. A brand-new file
   * gets `name` (from its filename) and `description`, which is what the daily
   * index page shows.
   *
   * @param {string} relPath - memory-relative path.
   * @param {string} content - Markdown to store; may carry its own frontmatter.
   * @param {{append?: boolean, description?: string}} [options] - write options.
   * @returns {Promise<{path: string, action: 'created'|'updated'|'appended', bytes: number}>} outcome.
   */
  /**
   * Enforce the `MEMORY.md` byte budget at write time.
   *
   * The core memory is injected on every turn, so an oversized file is a silent
   * per-turn cost until someone notices. Refusing the write keeps that cost
   * bounded and points the agent at the daily notes instead.
   *
   * @param {string} relPath - normalized memory-relative path.
   * @param {string} text - the exact text that would be written.
   * @returns {{bytes: number, limit: number, remaining: number, over: boolean} | undefined} usage for MEMORY.md.
   * @throws {Error} when the write would exceed the budget.
   */
  guardCoreBudget(relPath, text) {
    if (relPath !== 'MEMORY.md') return undefined
    const usage = coreUsage(Buffer.byteLength(text, 'utf8'), this.config.inject.memoryMdMaxBytes)
    if (usage.over) throw new Error(coreBudgetMessage(this.language === 'zh' ? 'zh' : 'en', usage))
    return usage
  }

  async writeMemoryFile(relPath, content, { append = false, description = '' } = {}) {
    const rel = this.editableRelPath(relPath)
    const incoming = String(content ?? '')
    if (incoming.trim().length === 0) throw new Error('content must not be empty')
    // Seeding the layout first means MEMORY.md exists with its template header
    // instead of being created here with note-style frontmatter.
    await this.ensureLayout()
    const existing = await this.store.readNote(rel)
    const hasOwnFrontmatter = /^---\r?\n/.test(incoming.trimStart())
    let text
    if (hasOwnFrontmatter) {
      text = incoming.endsWith('\n') ? incoming : `${incoming}\n`
    } else {
      const stem = rel.split('/').pop()?.replace(/\.md$/i, '') ?? 'note'
      const data = existing !== undefined && Object.keys(existing.data ?? {}).length > 0
        ? { ...existing.data }
        : { name: stem, description: typeof description === 'string' ? description.trim() : '' }
      if (Object.keys(data).length === 1 && data.name === stem && typeof description === 'string' && description.trim().length > 0) {
        data.description = description.trim()
      }
      const body = append && existing !== undefined
        ? `${String(existing.body ?? '').trimEnd()}\n\n${incoming.trim()}\n`
        : `${incoming.trim()}\n`
      text = stringifyFrontmatter(data, body)
    }
    const core = this.guardCoreBudget(rel, text)
    await this.store.writeRaw(rel, text)
    const action = existing === undefined ? 'created' : (append && !hasOwnFrontmatter ? 'appended' : 'updated')
    return { path: rel, action, bytes: Buffer.byteLength(text, 'utf8'), core }
  }

  /**
   * Replace an exact string inside one memory file.
   *
   * Ambiguity is an error rather than a best guess: silently editing the first of
   * several matches is how a correction lands in the wrong section.
   *
   * @param {string} relPath - memory-relative path.
   * @param {string} oldString - exact text to replace.
   * @param {string} newString - replacement text.
   * @param {{replaceAll?: boolean}} [options] - replace every occurrence.
   * @returns {Promise<{path: string, replaced: number, bytes: number}>} outcome.
   */
  async editMemoryFile(relPath, oldString, newString, { replaceAll = false } = {}) {
    const rel = this.editableRelPath(relPath)
    const needle = String(oldString ?? '')
    if (needle.length === 0) throw new Error('oldString is required')
    const note = await this.store.readNote(rel)
    if (note === undefined) throw new Error(`memory file not found: ${rel}`)
    const text = String(note.text ?? '')
    let occurrences = 0
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) occurrences += 1
    if (occurrences === 0) throw new Error(`oldString was not found in ${rel}`)
    if (occurrences > 1 && replaceAll !== true) {
      throw new Error(`oldString occurs ${occurrences} times in ${rel}; pass a longer unique snippet or replaceAll: true`)
    }
    const next = replaceAll === true ? text.split(needle).join(String(newString ?? '')) : text.replace(needle, String(newString ?? ''))
    const core = this.guardCoreBudget(rel, next)
    await this.store.writeRaw(rel, next)
    return { path: rel, replaced: replaceAll === true ? occurrences : 1, bytes: Buffer.byteLength(next, 'utf8'), core }
  }

  /**
   * Bring derived state back in line after an agent edit.
   *
   * Two different things are repaired here. A note under `<daily>/<date>/` changes
   * that day's *list*, so the page is rebuilt. Editing the page itself changes its
   * *prose*, and the rebuild keeps the `notes:auto` block correct — including
   * restoring the markers when a write dropped them.
   *
   * @param {string} relPath - memory-relative path that changed.
   * @returns {Promise<void>} resolves once the index (and day page) are updated.
   */
  /**
   * Rebuild one day's `<!-- notes:auto -->` block from the notes on disk.
   *
   * Writes used to delegate this to the summarizer object; there is no
   * summarizer any more, so the runtime owns the small index-page pass.
   *
   * @param {string} date - `YYYY-MM-DD`.
   * @returns {Promise<void>}
   */
  async refreshDayIndex(date) {
    const prefix = `${this.config.dailyDir}/${date}/`
    const notes = []
    let entries = []
    try {
      entries = await this.store.listMarkdown([`${this.config.dailyDir}/${date}`])
    } catch {
      entries = []
    }
    for (const entry of entries ?? []) {
      const relPath = typeof entry === 'string' ? entry : entry?.relPath
      if (typeof relPath !== 'string' || !relPath.startsWith(prefix) || !relPath.endsWith('.md')) continue
      const note = await this.store.readNote(relPath)
      if (note === undefined || note === null) continue
      const data = note.data !== null && typeof note.data === 'object' ? note.data : {}
      const fileStem = relPath.split('/').pop()?.replace(/\.md$/i, '') ?? ''
      const name = typeof data.name === 'string' && data.name.trim().length > 0 ? data.name.trim() : fileStem
      notes.push({
        relPath,
        name,
        description: typeof data.description === 'string' ? data.description.trim() : '',
      })
    }
    notes.sort((left, right) => left.relPath.localeCompare(right.relPath))
    await this.store.refreshDailyIndex(date, notes)
  }

  async refreshAfterEdit(relPath) {
    const parts = String(relPath ?? '').split('/')
    if (parts[0] === this.config.dailyDir) {
      const isDayPage = parts.length === 2 && /^\d{4}-\d{2}-\d{2}\.md$/.test(parts[1])
      const date = isDayPage ? parts[1].replace(/\.md$/i, '') : parts[1]
      if (isDayPage || (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
        await this.refreshDayIndex(date)
      }
    }
    await this.indexer.refresh()
  }
}

/**
 * Register the long-term memory plugin on one Cordis context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context.
 * @param {Record<string, unknown>} [rawConfig] - the Loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  /** Panel-editable overrides (semantic search endpoint, background models). */
  let overrides = readOverridesSync({ logger: ctx.logger })
  applyOverrides(config, overrides)
  const language = resolveLanguage(config.language)
  const logger = ctx.logger
  const runtimes = new Map()
  const agentRuntimes = new WeakMap()
  const agentDisposers = new Map()
  /**
   * Per-Agent cache for the mode (`agentPreset`) resolution only.
   *
   * It used to also hold the Auto Memory turn window; that mechanism is gone,
   * so this map no longer carries any conversation accounting.
   */
  const turnStates = new WeakMap()
  /** Groups already warned about an illegal `apiKeyEnv`, so one bad value warns once. */
  const warnedCredentialNames = new Set()
  /**
   * Groups whose configured `apiKeyEnv` was not a reference at all.
   *
   * Such a group must never fall back to the *default* reference name: a pasted
   * key would then be stored over an unrelated credential (`DEEPSEEK_API_KEY`,
   * say). It gets the plugin's own slot instead.
   */
  const rejectedCredentialGroups = new Set()
  /**
   * Record every source that supplied an illegal `apiKeyEnv`.
   * @param {{embeddings?: object, memory?: object, dream?: object} | undefined} source - route map to inspect.
   */
  const noteRejectedNames = (source) => {
    for (const group of CREDENTIAL_GROUPS) {
      const value = source?.[group]?.apiKeyEnv
      if (typeof value === 'string' && value.trim().length > 0 && !isCredentialRefName(value)) rejectedCredentialGroups.add(group)
    }
  }
  noteRejectedNames({
    embeddings: rawConfig?.search?.embeddings,
    dream: rawConfig?.autoDream?.model,
  })
  noteRejectedNames(overrides)
  /** Most recently used memory root, used as the panel's default target. */
  let lastRuntimeRoot
  /** Most recently used working directory. */
  let lastCwd
  /** Most recently used Agent mode. */
  let lastPreset
  /** Working directories this process has seen, for the panel's switch list. */
  const knownCwds = new Set()
  /** Agent modes seen this process, for the panel list. */
  const knownPresets = new Set()
  const rememberCwd = (cwd) => {
    if (typeof cwd === 'string' && cwd.length > 0) {
      knownCwds.add(cwd)
      lastCwd = cwd
    }
  }
  /** Per-Agent-mode switches; `scope.mode` decides the default. */
  const settings = new PresetSettings({
    defaultEnabled: config.scope.mode !== 'selected',
    logger,
  })

  const debug = (...args) => {
    if (config.debug) logger?.info?.(`[long-term-memory] ${args.join(' ')}`)
  }

  const defaultModelSelection = () => {
    const service = ctx.get('agentDefaultModel')
    const selection = service?.currentSelection?.()
    if (selection !== undefined && selection !== null) {
      return { provider: selection.provider, model: selection.model }
    }
    return undefined
  }

  /**
   * Resolve one named credential through the Host credential service.
   *
   * The name is a `CredentialRef`, so the provider-managed store (the profile's
   * credential file) wins over the ambient process environment. Resolution is
   * per operation, never cached, so a rotated key takes effect without restart.
   *
   * @param {string} name - credential name, usually an `apiKeyEnv`.
   * @returns {Promise<string | undefined>} the key, when configured.
   */
  const resolveCredential = async (name) => {
    const reference = typeof name === 'string' ? name.trim() : ''
    if (reference.length === 0) return undefined
    // A name outside the reference grammar cannot be stored, so there is
    // nothing to miss: report "not set" instead of asking the service to throw.
    if (!isCredentialRefName(reference)) return undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(reference)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value.length > 0) {
          return resolved.value
        }
      } catch (error) {
        debug(`credential resolve failed for ${reference}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ambient = process.env[reference]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  const resolveEmbeddingKey = () => resolveCredential(credentialName('embeddings'))

  /**
   * Whether the feature is switched on for one Agent mode.
   * @param {string} preset - Agent preset id.
   * @returns {Promise<boolean>} effective switch.
   */
  /**
   * Default switch for one mode before any stored override.
   * @param {string} preset - Agent preset id.
   * @returns {boolean} default enabled state.
   */
  const defaultEnabledFor = (preset) => {
    const listed = config.scope.presets.includes(preset)
    return config.scope.mode === 'selected' ? listed : !listed
  }

  /**
   * Whether the feature is switched on for one Agent mode (stored override, else policy).
   * @param {string} preset - Agent preset id.
   * @returns {Promise<boolean>} effective switch.
   */
  const enabledFor = async (preset) => settings.isEnabled(preset, defaultEnabledFor(preset))

  const sessionCwd = (agent) => {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && agent !== undefined) {
      try {
        return workingDirectory.get(agent.session)
      } catch {
        /* fall through to the header cwd */
      }
    }
    return agent?.session?.header?.cwd ?? process.cwd()
  }

  /**
   * Whether one Agent runs a delegated (subagent) session.
   *
   * Three independent markers, because any one of them can be absent: the
   * persisted `delegationDepth` (parent + 1), `origin: 'subagent'`, and a
   * `parentSession` id. A subagent's conversation exists to serve its parent,
   * so recording it would fill the daily notes with work-in-progress filed under
   * whichever mode spawned it — the caller asked for that to stay out, for
   * *every* Agent mode.
   *
   * @param {any} agent - live Agent.
   * @returns {boolean} true for a delegated session.
   */
  const isSubagent = (agent) => {
    const header = agent?.session?.header
    if (header === undefined || header === null) return false
    const depth = Number(header.delegationDepth ?? 0)
    if (Number.isFinite(depth) && depth > 0) return true
    if (header.origin === 'subagent') return true
    const parent = header.parentSession ?? header.parentSessionId
    return typeof parent === 'string' && parent.length > 0
  }

  /**
   * Resolve the Agent mode (preset) one Agent is running *now*.
   *
   * Three sources, in order of authority:
   *
   * 1. the latest `agent-preset/selected` session event — switching mode inside a
   *    live session appends that event and leaves the header untouched, so a
   *    header-only read keeps filing memory under the mode the session *started*
   *    with;
   * 2. the durable session header — the mode a session was created with;
   * 3. the live composition from the preset registry.
   *
   * The event scan is remembered per Agent (`state.preset` / `state.presetSeq`):
   * a long session can hold thousands of events and this runs every turn.
   *
   * @param {any} agent - live Agent.
   * @returns {string} preset id (never empty).
   */
  const presetFor = (agent) => {
    const state = agent === undefined ? undefined : turnState(agent)
    if (state !== undefined) {
      try {
        const events = agent.session?.snapshotEvents?.(0) ?? []
        for (const event of events) {
          const seq = Number(event?.seq ?? -1)
          if (seq < (state.presetSeq ?? 0)) continue
          if (event?.type !== 'agent-preset/selected') continue
          const next = String(event.data?.agentPreset ?? '').trim()
          if (next.length > 0) state.preset = next
          state.presetSeq = seq + 1
        }
      } catch {
        /* a session without events keeps the cached value */
      }
      if (typeof state.preset === 'string' && state.preset.length > 0) {
        knownPresets.add(state.preset)
        return state.preset
      }
    }

    const header = agent?.session?.header?.agentPreset
    if (typeof header === 'string' && header.trim().length > 0) {
      const preset = header.trim()
      knownPresets.add(preset)
      return preset
    }
    const registry = ctx.get('agentPresets')
    if (registry !== undefined && typeof registry.composedPreset === 'function' && agent?.ctx !== undefined) {
      try {
        const composed = registry.composedPreset(agent.ctx)
        if (typeof composed === 'string' && composed.length > 0) {
          knownPresets.add(composed)
          return composed
        }
      } catch {
        /* fall through to the default */
      }
    }
    knownPresets.add('default')
    return 'default'
  }

  const runtimeForRoot = (root) => {
    let runtime = runtimes.get(root)
    if (runtime === undefined) {
      runtime = new MemoryRuntime(root, {
        config,
        language,
        logger,
        llm: ctx.get('llm'),
        defaultModel: defaultModelSelection,
        resolveApiKey: resolveEmbeddingKey,
        resolveCredential,
        credentialName,
      })
      runtimes.set(root, runtime)
    }
    lastRuntimeRoot = root
    return runtime
  }

  const runtimeForCwd = (cwd, preset) => {
    const targetPreset = typeof preset === 'string' && preset.length > 0 ? preset : (lastPreset ?? 'default')
    if (typeof cwd === 'string' && cwd.length > 0) {
      rememberCwd(cwd)
      return runtimeForRoot(resolvePresetRoot(config, targetPreset))
    }
    if (lastCwd !== undefined) return runtimeForRoot(resolvePresetRoot(config, targetPreset))
    if (lastRuntimeRoot !== undefined) return runtimeForRoot(lastRuntimeRoot)
    const workingDirectory = ctx.get('workingDirectory')
    const fallback = typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory.length > 0
      ? workingDirectory.defaultDirectory
      : process.cwd()
    return runtimeForRoot(resolvePresetRoot(config, targetPreset))
  }

  const runtimeFor = (agent) => {
    if (agent === undefined) return undefined
    const cached = agentRuntimes.get(agent)
    const preset = presetFor(agent)
    // The cache is keyed by Agent, but the memory tree is chosen by mode: a
    // session that switches mode mid-flight must move to the other tree on its
    // next operation, so a cached runtime for another preset is not reused.
    if (cached !== undefined && cached.preset === preset) return cached
    const cwd = sessionCwd(agent)
    rememberCwd(cwd)
    lastPreset = preset
    const runtime = runtimeForRoot(resolvePresetRoot(config, preset))
    runtime.preset = preset
    agentRuntimes.set(agent, runtime)
    return runtime
  }

  // Guidance is registered per Agent (not globally) so a workspace that the user
  // switched off never receives memory instructions in its prompt.
  //
  // It must name the tree this very session writes to, not the base directory:
  // memory is split per Agent mode, so `$DSH_HOME/long-term-memory` holds only
  // `<mode>/` subdirectories. An Agent told the base directory looked for
  // `MEMORY.md` there, found nothing, and reported "no memory"; the same mistake
  // let a pass file its note into a neighbouring mode's tree.
  const guidanceFor = (treeRoot, preset) => buildMemoryGuidance({
    language,
    dailyDir: config.dailyDir,
    digestDir: config.digestDir,
    memoryRoot: treeRoot,
    baseRoot: resolveBaseRoot(config),
    preset,
    perPreset: config.perPreset,
    searchEnabled: true,
    editEnabled: config.inject.edit,
    coreBudgetBytes: config.inject.memoryMdMaxBytes,
  })

  const tools = createMemoryTools({
    runtimeFor,
    config,
    language,
    editEnabled: config.inject.edit,
  })
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `long-term-memory.tool.${tool.name}`)
  }

  /**
   * Current editable routes, for the settings tab.
   * @returns {{embeddings: object, dream: object}} effective values.
   */
  const editableSettings = async () => {
    const embeddings = { ...config.search.embeddings }
    const dream = mergedModel(config, 'autoDream')
    return {
      embeddings,
      dream,
      rhythm: {
        autoDream: {
          enabled: config.autoDream.enabled,
          autoRun: config.autoDream.autoRun,
          intervalMinutes: config.autoDream.intervalMinutes,
          dailyAt: config.autoDream.dailyAt,
        },
      },
      // Only presence is reported; neither the name nor the secret leaves the Host.
      credentials: {
        embeddings: { configured: await credentialConfigured(credentialName('embeddings')) },
        dream: { configured: await credentialConfigured(credentialName('dream')) },
      },
    }
  }

  /**
   * Persist panel edits and apply them to the live config.
   *
   * Only the three editable routes are written. The shared config object is
   * mutated in place, so running searches pick up a new embedding endpoint on
   * their next call and the background model helpers re-read their route lazily.
   *
   * @param {{embeddings?: object, memory?: object, dream?: object}} patch - fields to merge.
   * @returns {Promise<object>} the applied values.
   */
  const saveEditableSettings = async (patch) => {
    // `apiKeyEnv` is a credential reference, never a value: refuse a key body
    // here so it can never be written to the overrides file, and with it never
    // become an illegal `refs` key in the Host credential store.
    const clearedGroups = []
    for (const group of CREDENTIAL_GROUPS) {
      const value = patch?.[group]?.apiKeyEnv
      if (value === undefined || value === null) continue
      const text = typeof value === 'string' ? value.trim() : ''
      if (text.length === 0) continue
      if (!isCredentialRefName(text)) {
        throw new TypeError(language === 'zh'
          ? `${group}.apiKeyEnv 是凭据名（如 UNIAPI_API_KEY），不能填密钥本体；密钥请填在密钥输入框里。`
          : `${group}.apiKeyEnv is a credential name such as UNIAPI_API_KEY, not the key itself; put the key in the secret field.`)
      }
      clearedGroups.push(group)
    }
    const next = { ...overrides }
    for (const key of ['embeddings', 'dream', 'rhythm']) {
      if (patch?.[key] === null || patch?.[key] === undefined) continue
      next[key] = { ...(next[key] ?? {}), ...patch[key] }
    }
    overrides = await writeOverrides(next)
    const fresh = resolveConfig(rawConfig)
    applyOverrides(fresh, overrides)
    // Mutate the shared object rather than replacing it: every runtime holds a
    // reference and must observe the change.
    config.search.embeddings = fresh.search.embeddings
    config.autoDream.model = fresh.autoDream.model
    config.autoDream.enabled = fresh.autoDream.enabled
    config.autoDream.autoRun = fresh.autoDream.autoRun
    config.autoDream.intervalMinutes = fresh.autoDream.intervalMinutes
    config.autoDream.dailyAt = fresh.autoDream.dailyAt
    // A group whose name was just corrected stops using the plugin-private slot.
    for (const group of clearedGroups) rejectedCredentialGroups.delete(group)
    debug('settings saved')
    return await editableSettings()
  }

  /**
   * Resolve the credential name used for one panel group.
   *
   * The name is an implementation detail: the panel exposes only a write-only
   * secret field. A group without a configured name — or one configured with
   * something that is not a reference at all, such as a pasted key — falls back
   * to the plugin's own slot in the Host credential store. The illegal value is
   * never echoed: it may be a secret.
   *
   * @param {'embeddings'|'dream'} group - settings group.
   * @returns {string} credential reference name.
   */
  const credentialName = (group) => {
    if (rejectedCredentialGroups.has(group)) {
      if (!warnedCredentialNames.has(group)) {
        warnedCredentialNames.add(group)
        logger?.warn?.(`[long-term-memory] ${group}.apiKeyEnv is not a credential name (expected e.g. UNIAPI_API_KEY); using ${CREDENTIAL_FALLBACK}`)
      }
      return CREDENTIAL_FALLBACK
    }
    const source = group === 'embeddings'
      ? config.search.embeddings.apiKeyEnv
      : config.autoDream.model.apiKeyEnv
    const name = typeof source === 'string' ? source.trim() : ''
    if (isCredentialRefName(name)) return name
    if (name.length > 0 && !warnedCredentialNames.has(group)) {
      warnedCredentialNames.add(group)
      logger?.warn?.(`[long-term-memory] ${group}.apiKeyEnv is not a credential name (expected e.g. UNIAPI_API_KEY); using ${CREDENTIAL_FALLBACK}`)
    }
    return CREDENTIAL_FALLBACK
  }

  /** Whether one reference is configured in the Host credential store. */
  const credentialConfigured = async (name) => {
    const reference = typeof name === 'string' ? name.trim() : ''
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.describe !== 'function') return false
    if (!isCredentialRefName(reference)) return false
    try {
      const info = await credentials.describe(reference)
      return info?.configured === true
    } catch {
      return false
    }
  }

  /**
   * Store one secret under one reference name.
   *
   * The name is validated here, one step before `credentials.set`: the Host
   * service admits only POSIX identifiers as `refs` keys, and a bad key written
   * into the store makes the whole credentials document fail to load at the
   * next start — which would look like "my keys disappeared after a restart".
   *
   * @param {string} name - credential reference name.
   * @param {string} value - secret value.
   * @returns {Promise<boolean>} whether the value was stored.
   */
  const storeCredentialByName = async (name, value) => {
    const reference = typeof name === 'string' ? name.trim() : ''
    const secret = typeof value === 'string' ? value.trim() : ''
    if (!isCredentialRefName(reference) || secret.length === 0) return false
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.set !== 'function') return false
    try {
      await credentials.set(reference, secret)
    } catch (error) {
      logger?.warn?.(`[long-term-memory] credential not stored for ${reference}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    debug('credential stored for ' + reference)
    return true
  }

  /**
   * Store one group's secret in the Host credential store.
   *
   * The value is write-only from the panel's perspective: it is never returned,
   * logged, or persisted in the plugin's own files.
   *
   * @param {'embeddings'|'dream'} group - settings group.
   * @param {string} value - secret value.
   * @returns {Promise<boolean>} whether the value was stored.
   */
  const storeCredential = async (group, value) => {
    const name = credentialName(group)
    const stored = await storeCredentialByName(name, value)
    if (stored) debug('credential stored for ' + group)
    return stored
  }

  /**
   * Repair an overrides document that stored a secret where a name belongs.
   *
   * Runs once at start. A key pasted into the old credential-name field made
   * the plugin treat the key body as a reference name, which is what produced a
   * `sk-…: sk-…` entry in the Host credential store. Here the entry is renamed
   * to a real reference, the value is rescued into the store when that slot is
   * still empty, and the file is rewritten without the secret.
   *
   * @returns {Promise<void>} after the repair attempt.
   */
  const repairStoredCredentials = async () => {
    const { document, repairs } = repairOverridesDocument(overrides)
    if (repairs.length === 0) return
    const target = normalizeApiKeyEnv(config.backgroundModel.apiKeyEnv, CREDENTIAL_FALLBACK)

    for (const repair of repairs) {
      const route = document[repair.group]
      if (route !== null && typeof route === 'object' && !Array.isArray(route)) route.apiKeyEnv = target
    }
    for (const repair of repairs) {
      if (repair.secret.length === 0) continue
      if (await credentialConfigured(target)) continue
      await storeCredentialByName(target, repair.secret)
    }

    overrides = await writeOverrides(document)
    applyOverrides(config, overrides)
    // The stored names are legal again, so the group resolves to its own slot.
    for (const repair of repairs) rejectedCredentialGroups.delete(repair.group)
    const groups = repairs.map((repair) => repair.group).join(', ')
    logger?.warn?.(`[long-term-memory] repaired ${groups} in the overrides file: apiKeyEnv held a secret, not a credential name; renamed to ${target}`)
  }

  registerWebApi({
    ctx,
    config,
    runtimeForCwd,
    debug,
    settings,
    enabledFor,
    listCwds: () => [...knownCwds],
    listPresets: async () => {
      const registry = ctx.get('agentPresets')
      if (registry !== undefined && typeof registry.list === 'function') {
        try {
          const presets = await registry.list()
          if (Array.isArray(presets) && presets.length > 0) {
            return presets
              .filter((preset) => typeof preset?.id === 'string' && preset.id.length > 0)
              .map((preset) => ({
                id: preset.id,
                name: typeof preset.name === 'string' ? preset.name : preset.id,
                description: typeof preset.description === 'string' ? preset.description : '',
                broken: typeof preset.broken === 'string' ? preset.broken : '',
              }))
          }
        } catch (error) {
          debug(`preset list failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return [...knownPresets].map((id) => ({ id, name: id, description: '', broken: '' }))
    },
    currentCwd: () => lastCwd,
    currentPreset: () => lastPreset,
    readSettings: editableSettings,
    saveSettings: saveEditableSettings,
    storeCredential,
    overridesFile,
  })

  // One-shot self-heal for an overrides file that stored a secret as a name.
  void repairStoredCredentials().catch((error) => {
    logger?.warn?.(`[long-term-memory] overrides repair failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  /**
   * Abort scope for detached background work (scheduled dream, on-demand
   * summaries started from a command).
   *
   * Once a job leaves the Agent's maintenance phase nothing else can cancel it,
   * so the plugin keeps its own controller and aborts it on dispose/reload — a
   * stale run must not write into a tree that the next load is already using.
   */
  const background = new AbortController()
  ctx.effect(() => () => {
    background.abort(new Error('long-term-memory disposed'))
  }, 'long-term-memory.background')

  /**
   * Per-Agent cache for Agent-mode resolution only.
   *
   * There is no turn window any more: nothing counts turns, nothing summarizes
   * on a schedule, and no cursor is persisted. Only the mode id is cached here
   * because resolving it scans session events on every call.
   */
  const turnState = (agent) => {
    let state = turnStates.get(agent)
    if (state === undefined) {
      state = { presetSeq: 0 }
      turnStates.set(agent, state)
    }
    return state
  }

  ctx.on('agent/created', async ({ agent }) => {
    const disposers = []
    try {
      const cwd = sessionCwd(agent)
      const preset = presetFor(agent)
      const delegated = config.scope.subagents === 'exclude' && isSubagent(agent)
      debug(`agent/created cwd=${cwd} preset=${preset} subagent=${delegated}`)
      // A delegated session records nothing and receives no memory prompt text:
      // its work belongs to the parent's outcome, not to the user's memory tree.
      // Tools stay registered so an explicit memory_search still works.
      if (delegated) return
      const enabled = await enabledFor(preset)
      debug(`agent/created enabled=${enabled}`)
      const runtime = await runtimeFor(agent)
      debug(`agent/created root=${runtime.root}`)
      await runtime.ensureLayout()
      debug('agent/created layout ready')
      if (!enabled) {
        // Hide the memory tools from this Agent entirely; `restrict` keeps schema
        // presentation, lookup, and execution aligned, unlike a guard.
        disposers.push(
          agent.ctx.tools.restrict({
            deny: [
              'memory_search',
              'memory_dream',
              'memory_status',
              // Editing is gated with the rest of the feature: a mode the user
              // switched off must not keep a write path into its tree.
              'memory_write',
              'memory_edit',
            ],
          }),
        )
        agentDisposers.set(agent, disposers)
        return
      }
      if (config.inject.guidance) {
        disposers.push(
          agent.ctx.effect(
            () =>
              agent.ctx.systemPrompt.section({
                name: GUIDANCE_SECTION,
                order: ctx.systemPrompt.getSectionOrder('TOOL_READ') - 20,
                // Resolved per assembly rather than captured once, so a session
                // that switches Agent mode also switches the tree it is told about.
                text: () => guidanceFor(resolvePresetRoot(config, presetFor(agent)), presetFor(agent)),
              }),
            'long-term-memory.guidance',
          ),
        )
      }
      if (config.inject.memoryMd && config.inject.memoryMdMaxBytes > 0) {
        disposers.push(
          agent.ctx.effect(
            () =>
              agent.ctx.systemPrompt.section({
                name: CORE_SECTION,
                order: ctx.systemPrompt.getSectionOrder('TOOL_READ') - 10,
                text: () => runtime.coreMemoryText(),
              }),
            'long-term-memory.core',
          ),
        )
      }
      void runtime.indexer.ensure().catch((error) => {
        debug(`index build failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      logger?.warn?.(`[long-term-memory] agent initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    agentDisposers.set(agent, disposers)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const disposers = agentDisposers.get(agent) ?? []
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    agentDisposers.delete(agent)
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'memory',
          description: language === 'zh'
            ? '长期记忆：status、search <关键词>、dream [--dry-run] [--force]'
            : 'Long-term memory: status, search <query>, dream [--dry-run] [--force]',
          input: { hint: language === 'zh' ? 'status | search <关键词> | dream [--dry-run] [--force]' : 'status | search <query> | dream [--dry-run] [--force]' },
          handler: async ({ agent, rawInput }) => {
            const zh = language === 'zh'
            const runtime = runtimeFor(agent)
            if (runtime === undefined) return { kind: 'error', text: zh ? '当前会话没有可用的工作目录。' : 'This session has no working directory.' }
            if (!(await enabledFor(presetFor(agent)))) {
              return {
                kind: 'error',
                text: zh
                  ? '长期记忆在当前 Agent 模式未启用。可在 设置 → 长期记忆 → 模式 中开启。'
                  : 'Long-term memory is disabled for this Agent mode. Enable it in Settings → Long-Term Memory → Modes.',
              }
            }
            const input = (rawInput ?? '').trim()
            const [command, ...rest] = input.split(/\s+/)
            try {
              if (command === 'search' || command === 's') {
                const query = rest.join(' ').trim()
                if (query.length === 0) return { kind: 'error', text: zh ? '用法：/memory search <关键词>' : 'Usage: /memory search <query>' }
                const outcome = await runtime.searchMemory(query, {})
                return { kind: 'success', text: outcome.formatted }
              }
              if (command === 'dream' || command === 'd') {
                const dryRun = rest.includes('--dry-run') || rest.includes('dry-run')
                const force = rest.includes('--force') || rest.includes('force')
                const outcome = await runtime.dream({ dryRun, force })
                return { kind: 'success', text: outcome.summary }
              }
              if (command === 'status' || command === 'st' || command === '') {
                const status = await runtime.status()
                return { kind: 'success', text: status.summary }
              }
              return {
                kind: 'success',
                text: zh
                  ? '用法：/memory status | /memory search <关键词> | /memory dream [--dry-run] [--force]'
                  : 'Usage: /memory status | /memory search <query> | /memory dream [--dry-run] [--force]',
              }
            } catch (error) {
              return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
            }
          },
        }),
      'long-term-memory.command',
    )
  })

  ctx.inject(['timer'], (timerCtx) => {
    // One minute tick decides whether Auto Dream is due. Reading the config on
    // every tick means the panel's rhythm settings take effect without a reload,
    // and both the daily clock and the interval schedule share one timer.
    let lastIntervalRun = 0
    // Local date the daily clock last fired in this process. The schedule counts
    // as due from its HH:MM onwards, so this is what keeps it to one pass a day.
    let lastDailyDate = ''

    /** One dream per memory tree at a time: several sessions can share a tree. */
    const dreamsInFlight = new Set()

    /**
     * Whether a tree already consolidated something today.
     *
     * A catch-up tick can land right after a restart, while an earlier process
     * already ran the same night's dream. The persisted watermark is the record
     * of that run, so consult it rather than consolidating the notes twice.
     *
     * @param {any} runtime - runtime owning the memory tree.
     * @returns {Promise<boolean>} true when a dream already ran today.
     */
    const dreamedToday = async (runtime) => {
      try {
        const meta = await runtime.store.loadMeta('dream-state')
        const last = epochMs(meta?.lastRunAt)
        return last > 0 && localDate(new Date(last)) === localDate(new Date())
      } catch {
        return false
      }
    }

    const runDreamForIdleAgents = ({ daily = false } = {}) => {
      for (const agent of ctx.agents.list()) {
        if (agent.status !== 'idle') continue
        void enabledFor(presetFor(agent))
          .then(async (enabled) => {
            if (!enabled) return
            const runtime = runtimeFor(agent)
            if (runtime === undefined) return
            if (dreamsInFlight.has(runtime.root)) return
            if (daily && (await dreamedToday(runtime))) return
            // Re-check after the await: another idle Agent sharing this tree may
            // have started its own dream in the meantime.
            if (dreamsInFlight.has(runtime.root)) return
            // Dream makes several model calls, so it runs detached for the same
            // reason Auto Memory does: holding the Agent's maintenance phase would
            // park the next user message behind it. Nothing here needs the phase —
            // it only reads notes and writes digest files.
            dreamsInFlight.add(runtime.root)
            void runtime
              .dream({ signal: background.signal })
              .catch((error) => {
                debug(`scheduled dream failed: ${error instanceof Error ? error.message : String(error)}`)
              })
              .finally(() => dreamsInFlight.delete(runtime.root))
          })
          .catch(() => {})
      }
    }

    timerCtx.effect(
      () =>
        timerCtx.interval(() => {
          if (!config.autoDream.enabled || !config.autoDream.autoRun) return
          const now = new Date()
          const daily = config.autoDream.dailyAt
          // Due from HH:MM onwards rather than only during that exact minute: a
          // process that was not running at HH:MM takes one catch-up pass
          // instead of dropping the whole day without a trace.
          if (dailyDue(now, daily, lastDailyDate)) {
            lastDailyDate = localDate(now)
            debug(`scheduled dream (daily ${daily})`)
            runDreamForIdleAgents({ daily: true })
          }
          const minutes = config.autoDream.intervalMinutes
          if (minutes > 0) {
            const intervalMs = minutes * 60_000
            if (lastIntervalRun === 0) {
              lastIntervalRun = now.getTime()
            } else if (now.getTime() - lastIntervalRun >= intervalMs) {
              lastIntervalRun = now.getTime()
              debug(`scheduled dream (every ${minutes}m)`)
              runDreamForIdleAgents()
            }
          }
        }, 60_000),
      'long-term-memory.dream-timer',
    )
  })

  debug(`registered (root=${config.root}, language=${language})`)
}
