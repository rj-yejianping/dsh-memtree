/**
 * Incremental memory index: chunk cache + BM25 + wikilink graph, persisted to
 * `mem_metadata/index.json`. The cache is derived state and may be rebuilt at
 * any time; only `{mtimeMs, size}` per file decides whether re-chunking happens.
 *
 * @module dsh-long-term-memory/indexer
 */

import { Bm25Index } from './bm25.js'
import { WikilinkGraph } from './graph.js'
import { extractWikilinks, splitChunks, tokenize } from './markdown.js'

/** On-disk cache format version; bumping it forces a full rebuild. */
export const INDEX_VERSION = 1

const DEFAULT_DIRS = { dailyDir: 'memory', digestDir: 'digest' }

/**
 * @typedef {ReturnType<typeof splitChunks>[number] & {id: string}} IndexedChunk
 */

/** Memory index orchestrator. */
export class MemoryIndexer {
  /**
   * @param {{store: import('./store.js').MemoryStore, config?: Record<string, any>, logger?: any}} options - dependencies.
   */
  constructor({ store, config, logger } = {}) {
    if (!store) throw new Error('MemoryIndexer requires a store')
    this.store = store
    this.config = config ?? {}
    this.logger = logger
    const bm25Config = this.config?.search?.bm25 ?? {}
    this._bm25 = new Bm25Index({ k1: bm25Config.k1 ?? 1.5, b: bm25Config.b ?? 0.75 })
    this._graph = new WikilinkGraph()
    /** @type {Map<string, {mtimeMs: number, size: number}>} */
    this._files = new Map()
    /** @type {Map<string, IndexedChunk>} */
    this._chunks = new Map()
    /** @type {Map<string, string[]>} relPath -> chunk ids in file order */
    this._chunkIds = new Map()
    this._loaded = false
    this._inflight = null
    this._ensurePromise = null
  }

  /** @returns {WikilinkGraph} current wikilink graph. */
  get graph() {
    return this._graph
  }

  /** @returns {number} number of indexed chunks. */
  get chunkCount() {
    return this._chunks.size
  }

  /**
   * Load the persisted cache (when valid) and refresh against the file system.
   * Safe to call repeatedly; concurrent calls share one run.
   *
   * @returns {Promise<{refreshed: boolean, chunks: number}>} whether anything changed and the chunk count.
   */
  async ensure() {
    if (this._ensurePromise) return this._ensurePromise
    this._ensurePromise = (async () => {
      if (!this._loaded) await this._load()
      const stats = await this.refresh()
      return { refreshed: stats.added + stats.updated + stats.removed > 0, chunks: stats.chunks }
    })().finally(() => {
      this._ensurePromise = null
    })
    return this._ensurePromise
  }

  /**
   * Compare the file system against the cache and update only what changed.
   * Concurrent calls share a single in-flight run.
   *
   * @param {{force?: boolean}} [options] - force re-chunking of every file.
   * @returns {Promise<{added: number, updated: number, removed: number, chunks: number}>} refresh summary.
   */
  refresh({ force = false } = {}) {
    if (this._inflight) return this._inflight
    const run = (async () => {
      if (!this._loaded) await this._load()
      return this._refreshInternal(force === true)
    })()
    this._inflight = run.finally(() => {
      this._inflight = null
    })
    return this._inflight
  }

  /**
   * Search the BM25 side of the index.
   * @param {string} query - user query text.
   * @param {{limit?: number}} [options] - maximum hits.
   * @returns {{relPath: string, startLine: number, endLine: number, text: string, headingPath: string[], headingLevels: number[], score: number}[]} ranked chunks.
   */
  searchBM25(query, { limit = 50 } = {}) {
    const hits = this._bm25.search(tokenize(query), { limit })
    const results = []
    for (const hit of hits) {
      const chunk = this._chunks.get(hit.docId)
      if (!chunk) continue
      results.push({
        relPath: chunk.relPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        headingPath: [...(chunk.headingPath ?? [])],
        headingLevels: [...(chunk.headingLevels ?? [])],
        score: hit.score,
      })
    }
    return results
  }

  /**
   * Chunks of one file, ordered by position in the file.
   * @param {string} relPath - file path relative to the memory root.
   * @returns {IndexedChunk[]} chunk list (empty when the file is not indexed).
   */
  chunksFor(relPath) {
    const ids = this._chunkIds.get(relPath) ?? []
    const chunks = ids.map((id) => this._chunks.get(id)).filter(Boolean)
    return chunks.sort((left, right) => left.startLine - right.startLine)
  }

  /**
   * All indexed chunks, ordered by file and position. Used by vector search.
   * @returns {IndexedChunk[]} chunk list.
   */
  allChunks() {
    return [...this._chunks.values()].sort(compareChunks)
  }

  /**
   * Files currently tracked by the cache.
   * @returns {{relPath: string, mtimeMs: number, size: number}[]} tracked files.
   */
  indexedFiles() {
    return [...this._files.entries()]
      .map(([relPath, info]) => ({ relPath, mtimeMs: info.mtimeMs, size: info.size }))
      .sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0))
  }

  /**
   * Persist the derived cache to `mem_metadata/index.json`.
   * @returns {Promise<void>}
   */
  async persist() {
    /** @type {Record<string, {mtimeMs: number, size: number}>} */
    const files = {}
    for (const relPath of [...this._files.keys()].sort()) files[relPath] = /** @type {{mtimeMs: number, size: number}} */ (this._files.get(relPath))
    const chunks = this.allChunks()
    await this.store.saveMeta('index', {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      files,
      chunks,
      graph: this._graph.toJSON(),
      bm25: this._bm25.toJSON(),
    })
  }

  /**
   * One incremental refresh pass.
   * @param {boolean} force - re-chunk every file.
   * @returns {Promise<{added: number, updated: number, removed: number, chunks: number}>} summary.
   */
  async _refreshInternal(force) {
    const dirs = [this.config?.dailyDir ?? DEFAULT_DIRS.dailyDir, this.config?.digestDir ?? DEFAULT_DIRS.digestDir]
    const entries = await this.store.listMarkdown(dirs)
    const seen = new Set()
    let added = 0
    let updated = 0
    let removed = 0

    for (const entry of entries) {
      seen.add(entry.relPath)
      const cached = this._files.get(entry.relPath)
      if (!force && cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) continue
      let note
      try {
        note = await this.store.readNote(entry.relPath)
      } catch (error) {
        this._warn('failed to read memory note', entry.relPath, error)
        continue
      }
      if (!note) continue
      this._dropFile(entry.relPath)

      const chunks = splitChunks(entry.relPath, note.text)
      const ids = []
      chunks.forEach((chunk, index) => {
        const id = `${entry.relPath}#${index}`
        const indexed = /** @type {IndexedChunk} */ ({ ...chunk, id })
        this._chunks.set(id, indexed)
        ids.push(id)
        this._bm25.add(id, chunkTokens(indexed))
      })
      this._chunkIds.set(entry.relPath, ids)

      const displayName = typeof note.data?.name === 'string' && note.data.name.trim().length > 0 ? note.data.name.trim() : undefined
      this._graph.setOutlinks(entry.relPath, extractWikilinks(note.text), { name: displayName })
      this._files.set(entry.relPath, { mtimeMs: entry.mtimeMs, size: entry.size })
      if (cached) updated += 1
      else added += 1
    }

    for (const relPath of [...this._files.keys()]) {
      if (seen.has(relPath)) continue
      this._dropFile(relPath)
      this._files.delete(relPath)
      removed += 1
    }

    this._graph.finalize()
    if (added + updated + removed > 0) {
      try {
        await this.persist()
      } catch (error) {
        this._warn('failed to persist memory index cache', error)
      }
      this._debug('memory index refreshed', { added, updated, removed, chunks: this._chunks.size })
    }
    return { added, updated, removed, chunks: this._chunks.size }
  }

  /** @param {string} relPath - file to forget. */
  _dropFile(relPath) {
    for (const id of this._chunkIds.get(relPath) ?? []) {
      this._bm25.remove(id)
      this._chunks.delete(id)
    }
    this._chunkIds.delete(relPath)
    this._graph.remove(relPath)
  }

  /** Empty the in-memory index. */
  _reset() {
    const bm25Config = this.config?.search?.bm25 ?? {}
    this._bm25 = new Bm25Index({ k1: bm25Config.k1 ?? 1.5, b: bm25Config.b ?? 0.75 })
    this._graph = new WikilinkGraph()
    this._files = new Map()
    this._chunks = new Map()
    this._chunkIds = new Map()
  }

  /** Load the persisted cache once; corrupt or stale caches are ignored. */
  async _load() {
    this._loaded = true
    let cache
    try {
      cache = await this.store.loadMeta('index')
    } catch (error) {
      this._warn('failed to load memory index cache', error)
      return
    }
    if (!cache || cache.version !== INDEX_VERSION) return
    try {
      for (const [relPath, info] of Object.entries(cache.files ?? {})) {
        if (info && Number.isFinite(info.mtimeMs) && Number.isFinite(info.size)) this._files.set(relPath, { mtimeMs: info.mtimeMs, size: info.size })
      }
      for (const chunk of cache.chunks ?? []) {
        if (!chunk || typeof chunk.id !== 'string' || typeof chunk.relPath !== 'string') continue
        this._chunks.set(chunk.id, chunk)
        const ids = this._chunkIds.get(chunk.relPath) ?? []
        ids.push(chunk.id)
        this._chunkIds.set(chunk.relPath, ids)
      }
      this._bm25 = Bm25Index.fromJSON(cache.bm25)
      this._graph = WikilinkGraph.fromJSON(cache.graph)
      this._debug('memory index cache loaded', { files: this._files.size, chunks: this._chunks.size })
    } catch (error) {
      this._warn('memory index cache was corrupt, rebuilding', error)
      this._reset()
    }
  }

  _debug(...args) {
    if (typeof this.logger?.debug === 'function') this.logger.debug(...args)
  }

  _warn(...args) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(...args)
  }
}

/**
 * Tokens stored per chunk: heading context plus body text.
 * @param {IndexedChunk} chunk - indexed chunk.
 * @returns {string[]} tokens.
 */
function chunkTokens(chunk) {
  return tokenize(`${(chunk.headingPath ?? []).join(' ')}\n${chunk.text ?? ''}`)
}

/** @param {IndexedChunk} left - chunk. @param {IndexedChunk} right - chunk. */
function compareChunks(left, right) {
  if (left.relPath !== right.relPath) return left.relPath < right.relPath ? -1 : 1
  return left.startLine - right.startLine
}
