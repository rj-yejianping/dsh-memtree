/**
 * Okapi BM25 keyword index used by the long-term memory search pipeline.
 * Small, dependency-free, and serializable so the whole index can live in
 * `mem_metadata/index.json` and be rebuilt at any time.
 *
 * @module dsh-long-term-memory/bm25
 */

/**
 * @typedef {{length: number, tf: Map<string, number>}} Bm25Doc
 */

/** Okapi BM25 over an in-memory document set. */
export class Bm25Index {
  /**
   * @param {{k1?: number, b?: number}} [options] - BM25 term-frequency saturation and length normalization.
   */
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = Number.isFinite(Number(k1)) ? Number(k1) : 1.5
    this.b = Number.isFinite(Number(b)) ? Number(b) : 0.75
    /** @type {Map<string, Bm25Doc>} */
    this._docs = new Map()
    /** @type {Map<string, number>} term -> document frequency */
    this._df = new Map()
    this._totalLength = 0
  }

  /**
   * Add or replace one document.
   * @param {string} docId - opaque chunk identifier.
   * @param {string[]} tokens - tokenized document text.
   * @returns {void}
   */
  add(docId, tokens) {
    this.remove(docId)
    const list = Array.isArray(tokens) ? tokens : []
    /** @type {Map<string, number>} */
    const tf = new Map()
    let length = 0
    for (const token of list) {
      if (typeof token !== 'string' || token.length === 0) continue
      length += 1
      tf.set(token, (tf.get(token) ?? 0) + 1)
    }
    this._docs.set(docId, { length, tf })
    this._totalLength += length
    for (const term of tf.keys()) this._df.set(term, (this._df.get(term) ?? 0) + 1)
  }

  /**
   * Remove one document; unknown ids are ignored.
   * @param {string} docId - document identifier.
   * @returns {void}
   */
  remove(docId) {
    const doc = this._docs.get(docId)
    if (!doc) return
    for (const term of doc.tf.keys()) {
      const next = (this._df.get(term) ?? 0) - 1
      if (next <= 0) this._df.delete(term)
      else this._df.set(term, next)
    }
    this._totalLength -= doc.length
    this._docs.delete(docId)
  }

  /** @returns {number} number of indexed documents. */
  get size() {
    return this._docs.size
  }

  /** @returns {number} average document length in tokens. */
  get averageLength() {
    return this._docs.size > 0 ? this._totalLength / this._docs.size : 0
  }

  /**
   * Score documents against a tokenized query.
   * @param {string[]} tokens - query tokens.
   * @param {{limit?: number}} [options] - maximum number of hits.
   * @returns {{docId: string, score: number}[]} hits sorted by descending score.
   */
  search(tokens, { limit = 50 } = {}) {
    const query = [...new Set((Array.isArray(tokens) ? tokens : []).filter((token) => typeof token === 'string' && token.length > 0))]
    const docCount = this._docs.size
    if (query.length === 0 || docCount === 0) return []
    const average = this.averageLength || 1
    /** @type {Map<string, number>} */
    const scores = new Map()
    for (const term of query) {
      const df = this._df.get(term)
      if (!df) continue
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
      if (!Number.isFinite(idf) || idf <= 0) continue
      for (const [docId, doc] of this._docs) {
        const tf = doc.tf.get(term)
        if (!tf) continue
        const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / average))
        scores.set(docId, (scores.get(docId) ?? 0) + (idf * (tf * (this.k1 + 1))) / denominator)
      }
    }
    const hits = []
    for (const [docId, score] of scores) {
      if (score > 0) hits.push({ docId, score })
    }
    hits.sort((left, right) => right.score - left.score || (left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0))
    return Number.isFinite(limit) && limit >= 0 ? hits.slice(0, Math.trunc(limit)) : hits
  }

  /**
   * Serialize the index. Documents and terms are sorted so the output is stable.
   * @returns {{k1: number, b: number, docs: [string, {length: number, tf: [string, number][]}][]}}
   */
  toJSON() {
    const docs = [...this._docs.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([docId, doc]) => [
        docId,
        {
          length: doc.length,
          tf: [...doc.tf.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        },
      ])
    return { k1: this.k1, b: this.b, docs }
  }

  /**
   * Rebuild an index from {@link Bm25Index#toJSON}.
   * @param {unknown} json - serialized index.
   * @returns {Bm25Index} restored index.
   */
  static fromJSON(json) {
    const source = json && typeof json === 'object' ? /** @type {any} */ (json) : {}
    const index = new Bm25Index({ k1: source.k1, b: source.b })
    for (const entry of Array.isArray(source.docs) ? source.docs : []) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const [docId, doc] = entry
      if (typeof docId !== 'string') continue
      index.add(
        docId,
        Array.isArray(doc?.tf)
          ? doc.tf.flatMap((pair) => (Array.isArray(pair) && typeof pair[0] === 'string' ? Array(Math.max(1, Number(pair[1]) || 1)).fill(pair[0]) : []))
          : [],
      )
    }
    return index
  }
}
