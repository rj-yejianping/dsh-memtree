/**
 * Hybrid memory search: BM25 keyword retrieval (+ optional OpenAI-compatible
 * embeddings), reciprocal-rank fusion, one best chunk per file, optional
 * wikilink expansion, and QwenPaw-compatible progressive-disclosure formatting.
 *
 * @module dsh-long-term-memory/search
 */

import { createHash } from 'node:crypto'

import { tokenize } from './markdown.js'

const BM25_CANDIDATES = 50
const VECTOR_CANDIDATES = 50
const RRF_K = 60
const EMBEDDINGS_VERSION = 1
const MAX_EMBEDDING_CHARS = 4000

/**
 * @typedef {object} SearchResult
 * @property {string} relPath
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} score
 * @property {number} [bm25Score]
 * @property {number} [vectorScore]
 * @property {string[]} headingPath
 * @property {number[]} headingLevels
 * @property {string} text
 * @property {{target: string, name: string}[]} outlinks
 * @property {{source: string, name: string}[]} inlinks
 */

/** Memory search service. */
export class MemorySearch {
  /**
   * @param {{
   *   store: import('./store.js').MemoryStore,
   *   indexer: import('./indexer.js').MemoryIndexer,
   *   config?: Record<string, any>,
   *   logger?: any,
   *   resolveApiKey?: () => Promise<string | undefined> | string | undefined,
   * }} options - dependencies. `resolveApiKey` is the Host credential resolver for the
   *   configured `apiKeyEnv` name; when absent, the process environment is used.
   */
  constructor({ store, indexer, config, logger, resolveApiKey } = {}) {
    if (!store) throw new Error('MemorySearch requires a store')
    if (!indexer) throw new Error('MemorySearch requires an indexer')
    this.store = store
    this.indexer = indexer
    this.config = config ?? {}
    this.logger = logger
    this.resolveApiKey = typeof resolveApiKey === 'function' ? resolveApiKey : undefined
  }

  /**
   * Search the memory workspace.
   *
   * @param {string} query - natural-language query.
   * @param {{limit?: number, expand?: boolean}} [options] - result cap and wikilink expansion toggle.
   * @returns {Promise<{results: SearchResult[], formatted: string}>} ranked results plus the rendered block.
   */
  async search(query, { limit, expand = true } = {}) {
    const searchConfig = this._searchConfig()
    const text = typeof query === 'string' ? query.trim() : ''
    const maxResults = clampInt(limit ?? searchConfig.maxResults, searchConfig.maxResults, 1, 50)
    if (text.length === 0) return this._emptyResult()

    try {
      await this.indexer.ensure()
    } catch (error) {
      this._warn('memory index unavailable, search skipped', error)
      return this._emptyResult()
    }

    const bm25Hits = this.indexer.searchBM25(text, { limit: BM25_CANDIDATES })
    const vectorHits = await this._vectorHits(text)
    const fused = this._fuse(bm25Hits, vectorHits).sort(compareHits)

    /** @type {Map<string, any>} */
    const bestByFile = new Map()
    for (const hit of fused) {
      if (!bestByFile.has(hit.relPath)) bestByFile.set(hit.relPath, hit)
    }
    const primary = [...bestByFile.values()].slice(0, maxResults).map((hit) => this._toResult(hit))

    const expansions = []
    if (expand && searchConfig.expandLinks && searchConfig.maxExpansions > 0 && primary.length > 0) {
      const candidates = this.indexer.graph.expand(primary.map((result) => result.relPath), {
        direction: 'both',
        limit: searchConfig.maxExpansions,
      })
      for (const relPath of candidates) {
        if (bestByFile.has(relPath)) continue
        const chunk = this.indexer.chunksFor(relPath)[0]
        if (!chunk) continue
        const parent = primary.find((result) => this._isLinked(result.relPath, relPath))
        expansions.push(
          this._toResult({
            relPath: chunk.relPath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: chunk.text,
            headingPath: chunk.headingPath,
            headingLevels: chunk.headingLevels,
            score: parent ? parent.score * 0.5 : 0,
            expanded: true,
          }),
        )
      }
    }

    const results = [...primary, ...expansions]
    if (results.length === 0) return this._emptyResult()
    return { results, formatted: results.map((result) => this._format(result, searchConfig)).join('\n') }
  }

  /** @param {any} left - candidate. @param {string} relPath - linked file. */
  _isLinked(left, relPath) {
    const graph = this.indexer.graph
    return graph.outlinksOf(left).some((link) => link.target === relPath) || graph.inlinksOf(left).some((link) => link.source === relPath)
  }

  /**
   * Fuse keyword and vector rankings with reciprocal rank fusion (k = 60).
   * `score` is always the RRF value so it stays comparable across queries; the
   * raw keyword and vector scores are kept separately for display.
   * @param {any[]} bm25Hits - keyword hits.
   * @param {any[]} vectorHits - vector hits.
   * @returns {any[]} fused candidate entries.
   */
  _fuse(bm25Hits, vectorHits) {
    /** @type {Map<string, any>} */
    const merged = new Map()
    /** @type {Map<string, number>} */
    const bm25Rank = new Map()
    bm25Hits.forEach((hit, index) => {
      const key = keyOf(hit)
      bm25Rank.set(key, index + 1)
      merged.set(key, { ...hit, bm25Score: hit.score })
    })
    /** @type {Map<string, number>} */
    const vectorRank = new Map()
    vectorHits.forEach((hit, index) => {
      const key = keyOf(hit)
      if (!merged.has(key)) merged.set(key, { ...hit })
      /** @type {any} */
      const entry = merged.get(key)
      entry.vectorScore = hit.score
      vectorRank.set(key, index + 1)
    })
    for (const [key, entry] of merged) {
      let score = 0
      const keywordRank = bm25Rank.get(key)
      const semanticRank = vectorRank.get(key)
      if (keywordRank) score += 1 / (RRF_K + keywordRank)
      if (semanticRank) score += 1 / (RRF_K + semanticRank)
      entry.score = score
    }
    return [...merged.values()]
  }

  /**
   * Optional embedding retrieval. Disabled unless config, endpoint, model, and
   * the environment credential all exist; any failure degrades to BM25-only.
   * @param {string} query - query text.
   * @returns {Promise<any[]>} vector hits sorted by cosine similarity.
   */
  async _vectorHits(query) {
    const apiKey = await this._embeddingsKey()
    if (apiKey === undefined) return []
    try {
      const queryVectors = await this._embed([query], apiKey)
      const queryVector = queryVectors?.[0]
      if (!Array.isArray(queryVector) || queryVector.length === 0) return []

      const chunks = typeof this.indexer.allChunks === 'function' ? this.indexer.allChunks() : []
      if (chunks.length === 0) return []
      /** @type {Map<string, any[]>} */
      const byFile = new Map()
      for (const chunk of chunks) {
        const list = byFile.get(chunk.relPath) ?? []
        list.push(chunk)
        byFile.set(chunk.relPath, list)
      }

      const cache = await this._loadEmbeddingCache()
      /** @type {Map<string, number[]>} */
      const vectors = new Map()
      let dirty = false
      for (const [relPath, fileChunks] of byFile) {
        const info = await this.store.stat(relPath)
        if (!info) continue
        const hash = hashKey(`${relPath}${info.mtimeMs}`)
        const entry = cache.entries[relPath]
        let fileVectors = entry && entry.hash === hash && Array.isArray(entry.vectors) && entry.vectors.length === fileChunks.length ? entry.vectors : null
        if (!fileVectors) {
          const embedded = await this._embed(fileChunks.map((chunk) => embeddingText(chunk)), apiKey)
          if (!embedded || embedded.length !== fileChunks.length) continue
          fileVectors = embedded
        }
        if (!entry || entry.hash !== hash || entry.vectors !== fileVectors) {
          cache.entries[relPath] = { hash, vectors: fileVectors }
          dirty = true
        }
        fileChunks.forEach((chunk, index) => {
          const vector = fileVectors?.[index]
          if (Array.isArray(vector)) vectors.set(keyOf(chunk), vector)
        })
      }
      for (const relPath of Object.keys(cache.entries)) {
        if (!byFile.has(relPath)) {
          delete cache.entries[relPath]
          dirty = true
        }
      }
      if (dirty) await this._saveEmbeddingCache(cache)

      const hits = []
      for (const chunk of chunks) {
        const vector = vectors.get(keyOf(chunk))
        if (!vector) continue
        const score = cosineSimilarity(queryVector, vector)
        if (!Number.isFinite(score) || score <= 0) continue
        hits.push({
          relPath: chunk.relPath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          headingPath: chunk.headingPath,
          headingLevels: chunk.headingLevels,
          score,
        })
      }
      hits.sort(compareHits)
      return hits.slice(0, VECTOR_CANDIDATES)
    } catch (error) {
      this._warn('embedding search failed, falling back to BM25', error)
      return []
    }
  }

  /**
   * Call an OpenAI-compatible embeddings endpoint.
   * @param {string[]} inputs - texts to embed.
   * @returns {Promise<number[][] | null>} vectors aligned with inputs, or null.
   */
  async _embed(inputs, apiKey) {
    const embeddings = this._embeddingsConfig()
    if (typeof apiKey !== 'string' || apiKey.length === 0) return null
    if (!embeddings.enabled || !embeddings.baseURL || !embeddings.model) return null
    if (!Array.isArray(inputs) || inputs.length === 0) return null
    const response = await fetch(`${embeddings.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: embeddings.model, input: inputs }),
      signal: AbortSignal.timeout(embeddings.timeoutMs),
    })
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`)
    const payload = await response.json()
    const data = Array.isArray(payload?.data) ? payload.data : []
    /** @type {(number[] | undefined)[]} */
    const vectors = new Array(inputs.length)
    data.forEach((item, fallbackIndex) => {
      const index = Number.isInteger(item?.index) ? item.index : fallbackIndex
      const embedding = item?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0) return
      if (index < 0 || index >= inputs.length) return
      vectors[index] = embedding.map(Number)
    })
    if (vectors.some((vector) => !Array.isArray(vector))) return null
    return /** @type {number[][]} */ (vectors)
  }

  /** @returns {{enabled: boolean, baseURL: string, model: string, apiKeyEnv: string, timeoutMs: number}} */
  _embeddingsConfig() {
    const raw = this.config?.search?.embeddings ?? {}
    return {
      enabled: raw.enabled === true,
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.length > 0 ? raw.apiKeyEnv : 'DEEPSEEK_API_KEY',
      timeoutMs: clampInt(raw.timeoutMs, 15000, 1000, 120000),
    }
  }

  /**
   * Resolve the embedding credential for this operation.
   *
   * Resolution is per call, never cached across operations: the Host credential
   * service is the source of truth, so a rotated key reaches the next search
   * without a restart. The process environment remains the fallback for local
   * runs and tests.
   *
   * @returns {Promise<string | undefined>} the API key, or undefined when unconfigured.
   */
  async _embeddingsKey() {
    const embeddings = this._embeddingsConfig()
    if (!embeddings.enabled || !embeddings.baseURL || !embeddings.model) return undefined
    if (this.resolveApiKey !== undefined) {
      try {
        const resolved = await this.resolveApiKey()
        if (typeof resolved === 'string' && resolved.length > 0) return resolved
      } catch (error) {
        this._warn('embedding credential resolution failed', error)
      }
    }
    const ambient = process.env[embeddings.apiKeyEnv]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * Whether embeddings are configured and a credential is currently resolvable.
   * Used by status surfaces; search itself calls {@link _embeddingsKey}.
   * @returns {Promise<boolean>} true when a vector branch can run.
   */
  async embeddingsReady() {
    return (await this._embeddingsKey()) !== undefined
  }

  /** @returns {Promise<{version: number, entries: Record<string, {hash: string, vectors: number[][]}>}>} */
  async _loadEmbeddingCache() {
    try {
      const cache = await this.store.loadMeta('embeddings')
      if (cache && cache.version === EMBEDDINGS_VERSION && cache.entries && typeof cache.entries === 'object') {
        return { version: EMBEDDINGS_VERSION, entries: cache.entries }
      }
    } catch (error) {
      this._warn('failed to load embedding cache', error)
    }
    return { version: EMBEDDINGS_VERSION, entries: {} }
  }

  /** @param {{version: number, entries: object}} cache - cache to save. */
  async _saveEmbeddingCache(cache) {
    try {
      await this.store.saveMeta('embeddings', cache)
    } catch (error) {
      this._warn('failed to save embedding cache', error)
    }
  }

  /** @param {any} hit - fused candidate. @returns {SearchResult} public result shape. */
  _toResult(hit) {
    /** @type {SearchResult} */
    const result = {
      relPath: hit.relPath,
      startLine: hit.startLine,
      endLine: hit.endLine,
      score: hit.score,
      headingPath: [...(hit.headingPath ?? [])],
      headingLevels: [...(hit.headingLevels ?? [])],
      text: hit.text ?? '',
      outlinks: this.indexer.graph.outlinksOf(hit.relPath).map((link) => ({
        target: link.target,
        name: link.name && link.name.length > 0 ? link.name : displayNameOf(link.target),
      })),
      inlinks: this.indexer.graph.inlinksOf(hit.relPath).map((link) => ({
        source: link.source,
        name: link.name && link.name.length > 0 ? link.name : displayNameOf(link.source),
      })),
    }
    if (hit.bm25Score !== undefined) result.bm25Score = hit.bm25Score
    if (hit.vectorScore !== undefined) result.vectorScore = hit.vectorScore
    return result
  }

  /**
   * Render one result as a QwenPaw-style block.
   * @param {SearchResult} result - search result.
   * @param {{maxSnippetLines: number}} searchConfig - formatting limits.
   * @returns {string} formatted block.
   */
  _format(result, searchConfig) {
    const scores = [`score=${formatScore(result.score)}`]
    if (result.vectorScore !== undefined) scores.push(`vector=${formatScore(result.vectorScore)}`)
    if (result.bm25Score !== undefined) scores.push(`keyword=${formatScore(result.bm25Score)}`)
    const lines = [`========== ${result.relPath}:${result.startLine}-${result.endLine} [${scores.join(' ')}] ==========`]
    result.headingPath.forEach((title, index) => {
      const level = result.headingLevels?.[index] ?? 2
      lines.push(`${'#'.repeat(Math.max(1, Math.min(6, level)))} ${title}`)
    })
    const snippet = String(result.text ?? '').split('\n').slice(0, searchConfig.maxSnippetLines)
    lines.push(...snippet)
    if (result.outlinks.length > 0) {
      lines.push(`  outlinks (${result.outlinks.length}):`)
      for (const link of result.outlinks) lines.push(`    → ${link.target}  name="${link.name}"`)
    }
    if (result.inlinks.length > 0) {
      lines.push(`  inlinks (${result.inlinks.length}):`)
      for (const link of result.inlinks) lines.push(`    ← ${link.source}  name="${link.name}"`)
    }
    return lines.join('\n')
  }

  /** @returns {{results: SearchResult[], formatted: string}} localized empty result. */
  _emptyResult() {
    return { results: [], formatted: this._emptyMessage() }
  }

  /** @returns {string} localized "(no memory results)" text. */
  _emptyMessage() {
    const language = this.config?.language
    if (language === 'zh') return '（未找到相关记忆）'
    if (language === 'en') return '(no memory results)'
    const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
    return /zh/i.test(locale) ? '（未找到相关记忆）' : '(no memory results)'
  }

  /** @returns {{maxResults: number, maxSnippetLines: number, expandLinks: boolean, maxExpansions: number}} */
  _searchConfig() {
    const search = this.config?.search ?? {}
    return {
      maxResults: clampInt(search.maxResults, 8, 1, 50),
      maxSnippetLines: clampInt(search.maxSnippetLines, 18, 3, 200),
      expandLinks: search.expandLinks !== false,
      maxExpansions: clampInt(search.maxExpansions, 4, 0, 20),
    }
  }

  _warn(...args) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(...args)
  }
}

/** @param {any} hit - chunk or result. */
function keyOf(hit) {
  return `${hit.relPath}\u0000${hit.startLine}\u0000${hit.endLine}`
}

/** @param {any} chunk - indexed chunk. */
function embeddingText(chunk) {
  const heading = (chunk.headingPath ?? []).join(' / ')
  return `${heading}\n${chunk.text ?? ''}`.slice(0, MAX_EMBEDDING_CHARS)
}

/** @param {string} relPath - file path. */
function displayNameOf(relPath) {
  const segments = String(relPath).split('/')
  return (segments[segments.length - 1] ?? relPath).replace(/\.md$/i, '')
}

/** @param {string} value - text to hash. */
function hashKey(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** @param {number} score - raw score. */
function formatScore(score) {
  const value = Number(score)
  return (Number.isFinite(value) ? value : 0).toFixed(4)
}

/** @param {number[]} left - vector. @param {number[]} right - vector. */
function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length)
  if (length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < length; i += 1) {
    const a = Number(left[i]) || 0
    const b = Number(right[i]) || 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/** @param {any} left - hit. @param {any} right - hit. */
function compareHits(left, right) {
  if (right.score !== left.score) return right.score - left.score
  if (left.relPath !== right.relPath) return left.relPath < right.relPath ? -1 : 1
  return left.startLine - right.startLine
}

/** @param {unknown} value - candidate. @param {number} fallback - default. @param {number} min - lower bound. @param {number} max - upper bound. */
function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
