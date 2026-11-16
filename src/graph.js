/**
 * Wikilink graph over indexed memory files. Forward links come from each note's
 * body; reverse links are rebuilt by {@link WikilinkGraph#finalize}. Only files
 * known to the graph are ever expanded, so a dangling wikilink can be reported
 * but never turns into a phantom search result.
 *
 * @module dsh-long-term-memory/graph
 */

/** @typedef {{target: string, name?: string}} Outlink */
/** @typedef {{source: string, name?: string}} Inlink */

/** Bidirectional wikilink index. */
export class WikilinkGraph {
  constructor() {
    /** @type {Map<string, Outlink[]>} relPath -> deduped forward links */
    this._out = new Map()
    /** @type {Map<string, Inlink[]>} relPath -> deduped reverse links */
    this._in = new Map()
    /** @type {Map<string, string>} relPath -> display name */
    this._names = new Map()
  }

  /**
   * Set (replace) the forward links of one file. Passing an empty array is the
   * way to register a file that has no wikilinks, so it stays expandable.
   *
   * @param {string} relPath - file path relative to the memory root.
   * @param {Outlink[]} links - parsed wikilinks of that file.
   * @param {{name?: string}} [options] - optional display name for the file.
   * @returns {void}
   */
  setOutlinks(relPath, links, options = {}) {
    if (typeof relPath !== 'string' || relPath.length === 0) return
    /** @type {Outlink[]} */
    const deduped = []
    const seen = new Set()
    for (const link of Array.isArray(links) ? links : []) {
      const target = typeof link?.target === 'string' ? link.target.trim() : ''
      if (target.length === 0 || target === relPath || seen.has(target)) continue
      seen.add(target)
      const name = typeof link?.name === 'string' && link.name.trim().length > 0 ? link.name.trim() : undefined
      deduped.push(name ? { target, name } : { target })
    }
    this._out.set(relPath, deduped)
    if (typeof options?.name === 'string' && options.name.trim().length > 0) this._names.set(relPath, options.name.trim())
  }

  /**
   * Forget one file (both directions are dropped on the next finalize).
   * @param {string} relPath - file path relative to the memory root.
   * @returns {void}
   */
  remove(relPath) {
    this._out.delete(relPath)
    this._names.delete(relPath)
    this._in.delete(relPath)
  }

  /**
   * Rebuild the reverse index. Call once after a batch of setOutlinks/remove.
   * @returns {void}
   */
  finalize() {
    this._in = new Map()
    for (const [source, links] of this._out) {
      const sourceName = this._names.get(source) ?? displayNameOf(source)
      for (const link of links) {
        if (!this._in.has(link.target)) this._in.set(link.target, [])
        const list = /** @type {Inlink[]} */ (this._in.get(link.target))
        if (list.some((entry) => entry.source === source)) continue
        list.push({ source, name: sourceName })
      }
    }
  }

  /**
   * Forward links of one file.
   * @param {string} relPath - file path relative to the memory root.
   * @returns {Outlink[]} deduped outlinks in document order.
   */
  outlinksOf(relPath) {
    return (this._out.get(relPath) ?? []).map((link) => ({ ...link }))
  }

  /**
   * Reverse links of one file.
   * @param {string} relPath - file path relative to the memory root.
   * @returns {Inlink[]} deduped inlinks in insertion order.
   */
  inlinksOf(relPath) {
    return (this._in.get(relPath) ?? []).map((link) => ({ ...link }))
  }

  /**
   * Expand a set of seed files along outlinks and/or inlinks.
   * Targets that were never indexed are skipped (no phantom files).
   *
   * @param {string[]} relPaths - seed files.
   * @param {{direction?: 'out'|'in'|'both', limit?: number}} [options] - traversal controls; `limit` caps the total number of returned files.
   * @returns {string[]} newly reachable files, deduped, seeds excluded.
   */
  expand(relPaths, { direction = 'both', limit = 4 } = {}) {
    const seeds = (Array.isArray(relPaths) ? relPaths : [relPaths]).filter((path) => typeof path === 'string' && path.length > 0)
    const seen = new Set(seeds)
    const expanded = []
    const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0
    if (cap === 0) return expanded
    const add = (relPath) => {
      if (!relPath || seen.has(relPath) || !this._out.has(relPath)) return
      seen.add(relPath)
      expanded.push(relPath)
    }
    for (const seed of seeds) {
      if (expanded.length >= cap) break
      if (direction !== 'in') {
        for (const link of this.outlinksOf(seed)) {
          if (expanded.length >= cap) break
          add(link.target)
        }
      }
      if (direction !== 'out') {
        for (const link of this.inlinksOf(seed)) {
          if (expanded.length >= cap) break
          add(link.source)
        }
      }
    }
    return expanded
  }

  /**
   * Serialize the forward graph plus display names.
   * @returns {{names: Record<string, string>, outlinks: Record<string, Outlink[]>}}
   */
  toJSON() {
    /** @type {Record<string, Outlink[]>} */
    const outlinks = {}
    for (const relPath of [...this._out.keys()].sort()) outlinks[relPath] = this.outlinksOf(relPath)
    /** @type {Record<string, string>} */
    const names = {}
    for (const relPath of [...this._names.keys()].sort()) names[relPath] = /** @type {string} */ (this._names.get(relPath))
    return { names, outlinks }
  }

  /**
   * Restore a graph from {@link WikilinkGraph#toJSON}.
   * @param {unknown} json - serialized graph.
   * @returns {WikilinkGraph} restored graph with a rebuilt reverse index.
   */
  static fromJSON(json) {
    const source = json && typeof json === 'object' ? /** @type {any} */ (json) : {}
    const graph = new WikilinkGraph()
    for (const [relPath, links] of Object.entries(source.outlinks ?? {})) {
      const name = source.names?.[relPath]
      graph.setOutlinks(relPath, Array.isArray(links) ? links : [], { name })
    }
    graph.finalize()
    return graph
  }
}

/** @param {string} relPath - file path relative to the memory root. */
function displayNameOf(relPath) {
  const segments = relPath.split('/')
  return (segments[segments.length - 1] ?? relPath).replace(/\.md$/i, '')
}
