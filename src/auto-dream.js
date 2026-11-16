/**
 * Auto Dream: consolidate changed daily notes into digest knowledge nodes.
 *
 * Faithful to QwenPaw/ReMe Auto Dream:
 * - only daily topic notes newer than the watermark are considered;
 * - each note is classified into `personal` / `procedure` / `wiki`;
 * - existing digest nodes are retrieved with the hybrid search and given to the
 *   model as candidates;
 * - the model returns exactly one decision: CREATE / CORROBORATE / REFINE /
 *   CORRECT / SKIP;
 * - updates are additive merges that keep existing valid sections, merge the
 *   `## Sources` list, and never rewrite daily notes or `MEMORY.md`;
 * - failures are logged and skipped so one bad note cannot stop the run.
 *
 * All dependencies are injected; only `./prompts.js` is imported.
 *
 * @module dsh-long-term-memory/auto-dream
 */

import { buildAutoDreamPrompt, resolveLanguage } from './prompts.js'

const DEFAULT_DAILY_DIR = 'memory'
const DEFAULT_DIGEST_DIR = 'digest'
const DEFAULT_MAX_NOTES = 8
const DEFAULT_MIN_CHANGED_NOTES = 1
const MAX_SLUG_LENGTH = 80
const MAX_CANDIDATES = 5
const ALLOWED_CATEGORIES = Object.freeze(['personal', 'procedure', 'wiki'])
const ALLOWED_CATEGORY_SET = new Set(ALLOWED_CATEGORIES)
const UPPER_ACTIONS = new Set(['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT', 'SKIP'])

const SOURCES_HEADING_RE = /^#{2,3}[ \t]*(?:sources|来源)[ \t]*$/im
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function firstString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim()
  }
  return ''
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function normalizeDir(value, fallback) {
  const text = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : ''
  if (text.length === 0 || text.includes('..')) return fallback
  return text
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse a watermark value (ISO string, date string, or epoch ms) to ms. */
function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : 0
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : 0
  }
  return 0
}

/** Parse the optional `since` argument to epoch ms. */
function parseSince(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : undefined
  }
  const text = String(value).trim()
  if (text.length === 0) return undefined
  if (/^\d{10,}$/.test(text)) return Number(text)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const time = Date.parse(`${text}T00:00:00`)
    return Number.isFinite(time) ? time : undefined
  }
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : undefined
}

/** Build a safe single filename component (CJK-safe, no path separators). */
function slugifyName(name, fallback = 'memory-node') {
  let text = typeof name === 'string' ? name.trim() : ''
  text = text.replace(/[\\/:*?"<>|]+/g, '-')
  text = text.replace(/[\u0000-\u001f\u007f]+/g, '')
  text = text.replace(/\s+/g, '-')
  text = text.replace(/-{2,}/g, '-')
  text = text.replace(/^[-.]+|[-.]+$/g, '')
  if (text.length > MAX_SLUG_LENGTH) text = text.slice(0, MAX_SLUG_LENGTH).replace(/[-.]+$/g, '')
  if (text.length === 0 || text === '.' || text === '..') return fallback
  return text
}

/** Split a Markdown body into its main content and its `## Sources` lines. */
function splitSources(body) {
  const text = String(body ?? '')
  const match = SOURCES_HEADING_RE.exec(text)
  if (match === null) return { main: text.trim(), sources: [] }
  const main = text.slice(0, match.index).trim()
  const rest = text.slice(match.index + match[0].length)
  const sources = []
  for (const rawLine of rest.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('#')) continue
    sources.push(line)
  }
  return { main, sources }
}

/** Wikilink targets contained in one source line. */
function wikilinkTargets(line) {
  const targets = []
  WIKILINK_RE.lastIndex = 0
  let match = WIKILINK_RE.exec(line)
  while (match !== null) {
    targets.push(match[1].trim())
    match = WIKILINK_RE.exec(line)
  }
  return targets
}

/**
 * Normalize one model-provided source into a Markdown source line.
 * @param {unknown} source - path, wikilink, or contextual sentence.
 * @returns {string} normalized source line, or '' when unusable.
 */
function normalizeSourceLine(source) {
  const text = String(source ?? '').trim()
  if (text.length === 0) return ''
  if (text.includes('[[')) return text
  if (/^(?:https?:)?\/\//i.test(text)) return text
  const path = text.replace(/^\/+/, '').trim()
  if (path.length === 0 || path.includes('..')) return ''
  // A prose-only source cannot become a useful provenance link.
  if (!path.includes('/') && !/\.md$/i.test(path)) return ''
  return `[[${path}]]`
}

/**
 * Merge source lines, keeping existing lines untouched and appending new ones.
 * Uniqueness is keyed by wikilink target (or the normalized line when bare).
 */
function mergeSources(existing, incoming) {
  const seen = new Set()
  const out = []
  const add = (line, allowBullet) => {
    const targets = wikilinkTargets(line)
    const keys = targets.length > 0 ? targets : [line.toLowerCase()]
    if (keys.every((key) => seen.has(key))) return
    for (const key of keys) seen.add(key)
    out.push(allowBullet && !/^[-*+]\s/.test(line) ? `- ${line}` : line)
  }
  for (const line of existing) add(line, false)
  for (const line of incoming) add(line, true)
  return out
}

/**
 * Merge new material into an existing digest body.
 *
 * Existing content is preserved verbatim; new material is appended (under an
 * `## Update (<date>)` heading for REFINE / CORRECT, inline for CORROBORATE),
 * and `## Sources` is rebuilt as the unique union of old and new entries.
 *
 * @param {string} existingBody - current node body (may be empty for a create).
 * @param {object} options - merge inputs.
 * @param {string} options.action - normalized action (`create`, `corroborate`, ...).
 * @param {string} options.body - model-provided body (delta for updates).
 * @param {string[]} [options.sources] - extra normalized source lines.
 * @param {string} [options.noteRelPath] - originating daily note path.
 * @param {string} [options.date] - note date, used in the update heading.
 * @param {'zh'|'en'} [options.language] - prompt language for the heading.
 * @returns {string} the merged body.
 */
function mergeDigestBody(existingBody, { action, body, sources = [], noteRelPath = '', date = '', language = 'en' } = {}) {
  const existing = splitSources(existingBody)
  const incoming = splitSources(body)
  const addition = incoming.main.trim()

  let main = existing.main
  if (addition.length > 0) {
    if (main.length === 0) {
      main = addition
    } else if (!main.includes(addition)) {
      if (action === 'corroborate') {
        main = `${main}\n\n${addition}`
      } else if (/^#{1,6}\s/.test(addition)) {
        // The model already supplied its own section headings; a date heading
        // would only sit empty above them.
        main = `${main}\n\n${addition}`
      } else {
        const heading = language === 'zh'
          ? `## 更新（${date.length > 0 ? date : '最新'}）`
          : `## Update (${date.length > 0 ? date : 'latest'})`
        main = `${main}\n\n${heading}\n\n${addition}`
      }
    }
  }
  main = main.trim()

  const incomingSources = [...incoming.sources]
  for (const source of sources) {
    const line = normalizeSourceLine(source)
    if (line.length > 0) incomingSources.push(line)
  }
  if (noteRelPath.length > 0) incomingSources.push(`[[${noteRelPath}]]`)

  const mergedSources = mergeSources(existing.sources, incomingSources)
  const sections = []
  if (main.length > 0) sections.push(main)
  if (mergedSources.length > 0) sections.push(`## Sources\n\n${mergedSources.join('\n')}`)
  return `${sections.join('\n\n').trim()}\n`
}

/** Normalize an UPDATE target path, rejecting anything outside the digest dir. */
function normalizeDigestTarget(target, digestDir) {
  if (!isNonEmptyString(target)) return ''
  let text = target.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (text.startsWith('/')) text = text.slice(1)
  if (text.length === 0 || text.includes('..')) return ''
  if (!text.startsWith(`${digestDir}/`)) return ''
  if (!/\.md$/i.test(text)) return ''
  return text
}

/** Digest bucket inferred from a node path. */
function categoryFromPath(relPath, digestDir) {
  const prefix = `${digestDir}/`
  if (!relPath.startsWith(prefix)) return ''
  const bucket = relPath.slice(prefix.length).split('/')[0]
  return ALLOWED_CATEGORY_SET.has(bucket) ? bucket : ''
}

/**
 * Background Auto Dream pass.
 */
export class AutoDream {
  /**
   * @param {object} options - dependencies.
   * @param {object} options.store - `MemoryStore` (or compatible stub).
   * @param {object} [options.indexer] - `MemoryIndexer`; kept for wiring symmetry.
   * @param {{ search: Function }} [options.search] - hybrid memory search.
   * @param {{ json: Function }} options.llm - `LlmHelper` (or compatible stub).
   * @param {object} [options.config] - normalized plugin configuration.
   * @param {{ debug?: Function, warn?: Function }} [options.logger] - Cordis logger.
   */
  constructor({ store, indexer, search, llm, config, logger } = {}) {
    if (store === undefined || store === null) throw new Error('AutoDream requires a memory store')
    if (llm === undefined || llm === null || typeof llm.json !== 'function') {
      throw new Error('AutoDream requires an LLM helper')
    }
    this.store = store
    this.indexer = indexer
    this.search = search
    this.llm = llm
    this.config = config ?? {}
    this.logger = logger
  }

  /**
   * Retrieve existing digest nodes related to one daily note.
   * Search failures degrade to "no candidates"; they never fail the run.
   * @param {string} query - note text (or query built from it).
   * @param {string} digestDir - digest directory name.
   * @returns {Promise<Array<object>>} candidates under the digest directory.
   */
  async collectCandidates(query, digestDir) {
    if (this.search === undefined || this.search === null || typeof this.search.search !== 'function') {
      return []
    }
    const text = String(query ?? '').trim()
    if (text.length === 0) return []
    let raw
    try {
      raw = await this.search.search(text, { limit: MAX_CANDIDATES })
    } catch (error) {
      this.logger?.debug?.(
        `[long-term-memory] dream candidate search failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
    const results = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : []
    const prefix = `${digestDir}/`
    const candidates = []
    for (const item of results) {
      const relPath = typeof item === 'string' ? item : item?.relPath
      if (typeof relPath !== 'string') continue
      const normalized = relPath.trim()
      if (!normalized.startsWith(prefix)) continue
      if (candidates.some((candidate) => candidate.relPath === normalized)) continue
      const data = item !== null && typeof item === 'object' && item.data !== null && typeof item.data === 'object' ? item.data : {}
      candidates.push({
        relPath: normalized,
        name: firstString(item?.name, data.name),
        description: firstString(item?.description, data.description),
        snippet: firstString(item?.snippet, item?.text),
      })
      if (candidates.length >= MAX_CANDIDATES) break
    }
    return candidates
  }

  /**
   * Validate and normalize one model decision.
   * @param {unknown} reply - parsed model reply.
   * @param {string} digestDir - digest directory name.
   * @returns {object | undefined} normalized decision, or undefined when invalid.
   */
  normalizeDecision(reply, digestDir) {
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return undefined
    const action = String(reply.action ?? '').trim().toUpperCase()
    if (!UPPER_ACTIONS.has(action)) return undefined
    const reason = firstString(reply.reason)
    const description = firstString(reply.description)
    const name = firstString(reply.name)

    if (action === 'SKIP') {
      return {
        action: 'skip',
        category: '',
        target: '',
        name,
        description,
        body: '',
        sources: [],
        reason,
      }
    }

    const category = String(reply.category ?? '').trim().toLowerCase()
    if (!ALLOWED_CATEGORY_SET.has(category)) return undefined
    const body = typeof reply.body === 'string' ? reply.body.trim() : ''
    if (body.length === 0) return undefined
    const sources = Array.isArray(reply.sources) ? reply.sources : []

    if (action === 'CREATE') {
      if (name.length === 0) return undefined
      return { action: 'create', category, target: '', name, description, body, sources, reason }
    }

    const target = normalizeDigestTarget(reply.target, digestDir)
    if (target.length === 0) return undefined
    return { action: action.toLowerCase(), category, target, name, description, body, sources, reason }
  }

  /**
   * Run one Auto Dream pass.
   *
   * @param {object} [options] - run inputs.
   * @param {string|number|Date} [options.since] - lower bound overriding `lastRunAt`.
   * @param {number} [options.maxNotes] - maximum notes to process this run.
   * @param {AbortSignal} [options.signal] - cancellation signal.
   * @param {boolean} [options.dryRun] - plan only; never write or advance the watermark.
   * @param {boolean} [options.force] - process every topic note, ignoring the watermark.
   * @returns {Promise<{ processed: string[], actions: object[], skipped: string[] }>}
   *   the run outcome.
   */
  async run({ since, maxNotes, signal, dryRun = false, force = false } = {}) {
    const config = this.config ?? {}
    const dailyDir = normalizeDir(config.dailyDir, DEFAULT_DAILY_DIR)
    const digestDir = normalizeDir(config.digestDir, DEFAULT_DIGEST_DIR)
    const language = resolveLanguage(config.language)
    const logger = this.logger

    await this.store.ensureLayout?.()

    const state = await this.store.loadMeta('dream-state')
    const previous = state !== null && typeof state === 'object' && !Array.isArray(state) ? state : {}
    const processedMap = previous.processed !== null && typeof previous.processed === 'object' && !Array.isArray(previous.processed)
      ? { ...previous.processed }
      : {}
    const sinceMs = parseSince(since)
    const watermarkMs = sinceMs !== undefined ? sinceMs : parseTime(previous.lastRunAt)

    const topicPattern = new RegExp(`^${escapeRegExp(dailyDir)}/\\d{4}-\\d{2}-\\d{2}/[^/]+\\.md$`)
    const listed = (await this.store.listMarkdown([dailyDir])) ?? []
    const entries = []
    for (const item of listed) {
      const relPath = typeof item === 'string' ? item : item?.relPath
      if (typeof relPath !== 'string') continue
      const normalized = relPath.trim()
      if (!topicPattern.test(normalized)) continue
      const rawMtime = typeof item === 'object' && item !== null ? Number(item.mtimeMs) : Number.NaN
      entries.push({ relPath: normalized, mtimeMs: Number.isFinite(rawMtime) ? rawMtime : 0 })
    }

    // Fall back to stat() when a store implementation does not report mtimes.
    if (typeof this.store.stat === 'function') {
      for (const entry of entries) {
        if (entry.mtimeMs > 0) continue
        try {
          const stat = await this.store.stat(entry.relPath)
          if (stat !== undefined && Number.isFinite(Number(stat.mtimeMs))) entry.mtimeMs = Number(stat.mtimeMs)
        } catch {
          /* leave the mtime unknown */
        }
      }
    }

    const changed = entries.filter((entry) => {
      if (force) return true
      if (sinceMs !== undefined) return entry.mtimeMs > sinceMs
      if (Object.prototype.hasOwnProperty.call(processedMap, entry.relPath)) {
        return entry.mtimeMs > (Number(processedMap[entry.relPath]) || 0)
      }
      // A note without a processed entry has never been consolidated (or the
      // previous attempt failed). Treat it as changed so capped or failed runs
      // pick it up again; fall back to the global watermark only for a legacy
      // state that has no per-path entries at all.
      if (Object.keys(processedMap).length === 0 && watermarkMs > 0) return entry.mtimeMs > watermarkMs
      return entry.mtimeMs > 0
    })
    changed.sort((left, right) => left.mtimeMs - right.mtimeMs || left.relPath.localeCompare(right.relPath))

    const minChanged = clampInt(config.autoDream?.minChangedNotes, DEFAULT_MIN_CHANGED_NOTES, 1, 100)
    if (!force && changed.length < minChanged) {
      logger?.debug?.(
        `[long-term-memory] auto dream skipped: ${changed.length} changed note(s) < ${minChanged}`,
      )
      return { processed: [], actions: [], skipped: [] }
    }
    if (changed.length === 0) return { processed: [], actions: [], skipped: [] }

    const limit = clampInt(maxNotes ?? config.autoDream?.maxNotesPerRun, DEFAULT_MAX_NOTES, 1, 100)
    const selected = changed.slice(0, limit)

    const processed = []
    const actions = []
    const skipped = []
    const advanced = new Map()

    for (const entry of selected) {
      processed.push(entry.relPath)
      try {
        const note = await this.store.readNote(entry.relPath)
        if (note === undefined || note === null) {
          skipped.push(entry.relPath)
          logger?.warn?.(`[long-term-memory] auto dream could not read ${entry.relPath}`)
          continue
        }
        const noteData = note.data !== null && typeof note.data === 'object' ? note.data : {}
        const noteBody = firstString(note.body, note.text)
        if (noteBody.length === 0) {
          skipped.push(entry.relPath)
          logger?.debug?.(`[long-term-memory] auto dream skipped empty note ${entry.relPath}`)
          continue
        }

        const candidates = await this.collectCandidates(noteBody, digestDir)
        const prompt = buildAutoDreamPrompt({
          language,
          note: {
            relPath: entry.relPath,
            date: firstString(noteData.date),
            name: firstString(noteData.name),
            description: firstString(noteData.description),
            body: noteBody,
          },
          existingCandidates: candidates,
          categories: [...ALLOWED_CATEGORIES],
          dailyDir,
          digestDir,
        })
        // No explicit budget: the configured route's `maxTokens` is authoritative,
        // and a reasoning model needs room to think before it writes the JSON.
        const reply = await this.llm.json({ system: prompt.system, prompt: prompt.prompt, signal })
        const decision = this.normalizeDecision(reply, digestDir)
        if (decision === undefined) {
          skipped.push(entry.relPath)
          logger?.warn?.(`[long-term-memory] auto dream skipped ${entry.relPath}: invalid model decision`)
          continue
        }
        if (decision.action === 'skip') {
          skipped.push(entry.relPath)
          advanced.set(entry.relPath, entry.mtimeMs)
          logger?.debug?.(`[long-term-memory] auto dream model skipped ${entry.relPath}`)
          continue
        }

        if (dryRun) {
          const plannedPath = decision.action === 'create'
            ? `${digestDir}/${decision.category}/${slugifyName(decision.name)}.md`
            : decision.target
          actions.push({
            action: decision.action,
            category: decision.category,
            relPath: plannedPath,
            name: decision.name,
            reason: decision.reason,
          })
          continue
        }

        if (decision.action === 'create') {
          const slug = slugifyName(decision.name)
          const body = mergeDigestBody('', {
            action: 'create',
            body: decision.body,
            sources: decision.sources,
            noteRelPath: entry.relPath,
            date: firstString(noteData.date),
            language,
          })
          const written = await this.store.writeDigest(decision.category, slug, {
            name: decision.name,
            description: decision.description,
            body,
          })
          const relPath = isNonEmptyString(written) ? written.trim() : `${digestDir}/${decision.category}/${slug}.md`
          actions.push({
            action: 'create',
            category: decision.category,
            relPath,
            name: decision.name,
            reason: decision.reason,
          })
          advanced.set(entry.relPath, entry.mtimeMs)
          logger?.debug?.(`[long-term-memory] auto dream created ${relPath}`)
          continue
        }

        // CORROBORATE / REFINE / CORRECT: additive merge into an existing node.
        const target = await this.store.readNote(decision.target)
        if (target === undefined || target === null) {
          skipped.push(entry.relPath)
          logger?.warn?.(
            `[long-term-memory] auto dream skipped ${entry.relPath}: target not found ${decision.target}`,
          )
          continue
        }
        const targetData = target.data !== null && typeof target.data === 'object' ? target.data : {}
        const mergedBody = mergeDigestBody(target.body ?? '', {
          action: decision.action,
          body: decision.body,
          sources: decision.sources,
          noteRelPath: entry.relPath,
          date: firstString(noteData.date),
          language,
        })
        const data = {
          ...targetData,
          name: firstString(targetData.name, decision.name) || slugifyName(decision.name),
          description: firstString(decision.description, targetData.description),
          kind: firstString(targetData.kind, categoryFromPath(decision.target, digestDir), decision.category),
          updated: new Date().toISOString(),
        }
        await this.store.writeNote(decision.target, { data, body: mergedBody })
        actions.push({
          action: decision.action,
          category: decision.category,
          relPath: decision.target,
          name: firstString(data.name, decision.name),
          reason: decision.reason,
        })
        advanced.set(entry.relPath, entry.mtimeMs)
        logger?.debug?.(`[long-term-memory] auto dream ${decision.action} ${decision.target}`)
      } catch (error) {
        skipped.push(entry.relPath)
        logger?.warn?.(
          `[long-term-memory] auto dream failed on ${entry.relPath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (!dryRun) {
      const livePaths = new Set(entries.map((entry) => entry.relPath))
      const nextProcessed = {}
      for (const [relPath, mtimeMs] of Object.entries(processedMap)) {
        if (livePaths.has(relPath)) nextProcessed[relPath] = mtimeMs
      }
      for (const [relPath, mtimeMs] of advanced) nextProcessed[relPath] = mtimeMs
      // Only move the wall-clock watermark when something was actually
      // consolidated; otherwise keep the previous value so failed notes remain
      // eligible for a retry in a legacy state with no per-path entries.
      const lastRunAt = advanced.size > 0 || Object.keys(nextProcessed).length > 0
        ? new Date().toISOString()
        : previous.lastRunAt !== undefined && previous.lastRunAt !== null
          ? previous.lastRunAt
          : ''
      await this.store.saveMeta('dream-state', { lastRunAt, processed: nextProcessed })
    }

    return { processed, actions, skipped }
  }
}
