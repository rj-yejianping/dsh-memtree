/**
 * File-system layer for the memory workspace: `MEMORY.md`, daily index pages
 * under `memory/`, digest nodes under `digest/`, and derived caches under
 * `mem_metadata/`. Every write is atomic (unique temp file + rename) and every
 * path is confined to the memory root.
 *
 * @module dsh-long-term-memory/store
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parseFrontmatter, slugify, stringifyFrontmatter } from './markdown.js'

/** Marker opening the auto-managed note list on a daily index page. */
export const NOTES_BLOCK_START = '<!-- notes:auto -->'
/** Marker closing the auto-managed note list on a daily index page. */
export const NOTES_BLOCK_END = '<!-- /notes:auto -->'

const AUTO_DESCRIPTION_RE = /^\d+ note\(s\) today\.$/
const CORE_MEMORY_TEMPLATE = `---
summary: Core long-term memory shared by the user and the agent.
read_when: Before answering about user preferences, ongoing projects, or standing agreements.
---

# Core Long-Term Memory / 核心长期记忆

> 少量、稳定的核心长期记忆，由用户与 Agent 共同维护。
> A small, stable core memory maintained together by the user and the agent.

## Focus / 关注范围

- 示例：重点跟踪新能源汽车产业链。/ Example: keep tracking the new-energy vehicle supply chain.

## Preferences / 偏好

- （暂无 / none yet）

## Ongoing context / 长期上下文

- （暂无 / none yet）

## Agreements / 长期约定

- （暂无 / none yet）
`

/**
 * Memory workspace store.
 */
export class MemoryStore {
  /**
   * @param {{root: string, dailyDir?: string, digestDir?: string, metaDir?: string}} options - workspace layout.
   */
  constructor({ root, dailyDir = 'memory', digestDir = 'digest', metaDir = 'mem_metadata' } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new Error('MemoryStore requires a root directory')
    this._root = resolve(root)
    this.dailyDir = cleanDir(dailyDir, 'memory')
    this.digestDir = cleanDir(digestDir, 'digest')
    this.metaDir = cleanDir(metaDir, 'mem_metadata')
    this._tmpSeq = 0
  }

  /** @returns {string} absolute memory root. */
  get root() {
    return this._root
  }

  /**
   * Resolve a memory-relative path, rejecting anything outside the root.
   * @param {string} relPath - path relative to the memory root.
   * @returns {string} absolute path.
   */
  resolve(relPath) {
    const candidate = typeof relPath === 'string' ? relPath : ''
    const absolute = resolve(this._root, candidate)
    if (absolute !== this._root && !absolute.startsWith(this._root + sep)) {
      throw new Error(`memory path escapes root: ${relPath}`)
    }
    return absolute
  }

  /**
   * Convert an absolute path back to a memory-relative one.
   * @param {string} absPath - absolute path inside the root.
   * @returns {string} slash-separated relative path.
   */
  toRel(absPath) {
    const absolute = resolve(absPath)
    const value = relative(this._root, absolute)
    if (value.length === 0) return ''
    if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
      throw new Error(`path is outside the memory root: ${absPath}`)
    }
    return value.split(sep).join('/')
  }

  /**
   * Create the directory layout and seed `MEMORY.md` when it is missing.
   * @returns {Promise<void>}
   */
  async ensureLayout() {
    await mkdir(this._root, { recursive: true })
    await mkdir(this.resolve(this.dailyDir), { recursive: true })
    for (const category of ['personal', 'procedure', 'wiki']) {
      await mkdir(this.resolve(`${this.digestDir}/${category}`), { recursive: true })
    }
    await mkdir(this.resolve(this.metaDir), { recursive: true })
    if (!(await this.exists('MEMORY.md'))) await this.writeRaw('MEMORY.md', CORE_MEMORY_TEMPLATE)
  }

  /**
   * Read `MEMORY.md`; missing files read as an empty string.
   * @returns {Promise<string>} file text.
   */
  async readMemoryMd() {
    return (await this._readText('MEMORY.md')) ?? ''
  }

  /**
   * Atomically replace `MEMORY.md`.
   * @param {string} text - new content.
   * @returns {Promise<void>}
   */
  async writeMemoryMd(text) {
    await this.writeRaw('MEMORY.md', text)
  }

  /**
   * Stat a memory file.
   * @param {string} relPath - path relative to the root.
   * @returns {Promise<{mtimeMs: number, size: number} | undefined>} metadata, or undefined when absent.
   */
  async stat(relPath) {
    try {
      const info = await stat(this.resolve(relPath))
      if (!info.isFile()) return undefined
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  /**
   * @param {string} relPath - path relative to the root.
   * @returns {Promise<boolean>} whether a regular file exists there.
   */
  async exists(relPath) {
    return (await this.stat(relPath)) !== undefined
  }

  /**
   * List searchable Markdown files under the daily and digest directories.
   * Hidden entries and the metadata directory are skipped.
   *
   * @param {string[]} [dirs] - directories relative to the root.
   * @returns {Promise<{relPath: string, mtimeMs: number, size: number}[]>} files sorted by path.
   */
  async listMarkdown(dirs = [this.dailyDir, this.digestDir]) {
    const results = []
    const walk = async (absoluteDir) => {
      let entries
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true })
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          if (entry.name === this.metaDir || entry.name === 'node_modules') continue
          await walk(join(absoluteDir, entry.name))
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
        const absolute = join(absoluteDir, entry.name)
        const info = await stat(absolute)
        results.push({ relPath: this.toRel(absolute), mtimeMs: info.mtimeMs, size: info.size })
      }
    }
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      if (typeof dir !== 'string' || dir.length === 0) continue
      await walk(this.resolve(dir))
    }
    results.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0))
    return results
  }

  /**
   * Read and parse one Markdown note.
   * @param {string} relPath - path relative to the root.
   * @returns {Promise<{relPath: string, data: Record<string,string>, body: string, text: string, mtimeMs: number} | undefined>} parsed note.
   */
  async readNote(relPath) {
    const info = await this.stat(relPath)
    if (!info) return undefined
    const text = (await this._readText(relPath)) ?? ''
    const { data, body } = parseFrontmatter(text)
    return { relPath, data, body, text, mtimeMs: info.mtimeMs }
  }

  /**
   * Atomically write a note with frontmatter.
   * @param {string} relPath - path relative to the root.
   * @param {{data?: Record<string, unknown>, body?: string}} note - frontmatter data and body.
   * @returns {Promise<void>}
   */
  async writeNote(relPath, { data = {}, body = '' } = {}) {
    await this.writeRaw(relPath, stringifyFrontmatter(data, body))
  }

  /**
   * Atomically write raw text (creating parent directories).
   * @param {string} relPath - path relative to the root.
   * @param {string} text - content to write.
   * @returns {Promise<void>}
   */
  async writeRaw(relPath, text) {
    const absolute = this.resolve(relPath)
    await mkdir(dirname(absolute), { recursive: true })
    this._tmpSeq += 1
    const tmp = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.${this._tmpSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`)
    await writeFile(tmp, String(text ?? ''), 'utf8')
    try {
      await rename(tmp, absolute)
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw error
    }
  }

  /**
   * Delete one note; missing files are ignored.
   * @param {string} relPath - path relative to the root.
   * @returns {Promise<void>}
   */
  async deleteNote(relPath) {
    try {
      await unlink(this.resolve(relPath))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  /**
   * Read a daily index page and derive its managed note list.
   * @param {string} date - index date, e.g. `2026-08-14`.
   * @returns {Promise<{relPath: string, data: Record<string,string>, body: string, notes: {relPath: string, name: string, description: string}[], text: string} | undefined>} page and notes.
   */
  async readDailyIndex(date) {
    const relPath = this.dailyIndexPath(date)
    const info = await this.stat(relPath)
    if (!info) return undefined
    const text = (await this._readText(relPath)) ?? ''
    const { data, body } = parseFrontmatter(text)
    return { relPath, data, body, notes: deriveNotes(body), text }
  }

  /**
   * Rebuild only the `<!-- notes:auto -->` block of a daily index page.
   * Manual prose before and after the block is preserved verbatim (aside from
   * boundary whitespace), and the page is created when missing.
   *
   * @param {string} date - index date, e.g. `2026-08-14`.
   * @param {{relPath: string, name?: string, description?: string}[]} notes - notes to list.
   * @returns {Promise<{relPath: string, text: string}>} written page.
   */
  async refreshDailyIndex(date, notes) {
    const relPath = this.dailyIndexPath(date)
    const pageDate = slugify(date)
    const list = Array.isArray(notes) ? notes : []
    const existing = await this.readDailyIndex(date)
    /** @type {Record<string, unknown>} */
    const data = existing ? { ...existing.data } : {}
    if (typeof data.name !== 'string' || data.name.length === 0) data.name = pageDate
    if (typeof data.description !== 'string' || data.description.length === 0 || AUTO_DESCRIPTION_RE.test(data.description)) {
      data.description = `${list.length} note(s) today.`
    }
    const block = renderNotesBlock(list)
    const body = replaceManagedBlock(existing?.body ?? '', block)
    const text = stringifyFrontmatter(data, body)
    await this.writeRaw(relPath, text)
    return { relPath, text }
  }

  /**
   * Write a digest node under `digest/<category>/<slug>.md`.
   * @param {string} category - `personal`, `procedure`, or `wiki`.
   * @param {string} slug - display name or slug for the node.
   * @param {{name: string, description?: string, body: string}} node - content.
   * @returns {Promise<string>} memory-relative path of the written node.
   */
  async writeDigest(category, slug, { name, description = '', body = '' } = {}) {
    const categorySlug = slugify(category)
    const fileSlug = slugify(String(slug ?? '').replace(/\.md$/i, ''))
    const relPath = `${this.digestDir}/${categorySlug}/${fileSlug}.md`
    await this.writeNote(relPath, {
      data: {
        name: typeof name === 'string' && name.length > 0 ? name : fileSlug,
        description,
        kind: categorySlug,
        updated: new Date().toISOString().slice(0, 19),
      },
      body,
    })
    return relPath
  }

  /**
   * Load one derived metadata JSON document.
   * @param {string} name - e.g. `index`, `dream-state`, `embeddings`.
   * @returns {Promise<any | undefined>} parsed value, or undefined when absent/corrupt.
   */
  async loadMeta(name) {
    const text = await this._readText(this.metaPath(name))
    if (text === undefined) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  /**
   * Atomically save one derived metadata JSON document.
   * @param {string} name - e.g. `index`, `dream-state`, `embeddings`.
   * @param {unknown} value - JSON-serializable value.
   * @returns {Promise<void>}
   */
  async saveMeta(name, value) {
    await this.writeRaw(this.metaPath(name), `${JSON.stringify(value, null, 2)}\n`)
  }

  /**
   * Memory-relative path of a daily index page.
   * @param {string} date - index date.
   * @returns {string} relative path.
   */
  dailyIndexPath(date) {
    return `${this.dailyDir}/${slugify(date)}.md`
  }

  /**
   * Memory-relative path of a metadata document.
   * @param {string} name - metadata file name without extension.
   * @returns {string} relative path.
   */
  metaPath(name) {
    const raw = typeof name === 'string' && name.length > 0 ? name : 'meta'
    return `${this.metaDir}/${raw.endsWith('.json') ? raw : `${raw}.json`}`
  }

  /** @param {string} relPath - relative path. @returns {Promise<string | undefined>} text or undefined. */
  async _readText(relPath) {
    try {
      return await readFile(this.resolve(relPath), 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }
}

/**
 * Parse the managed note list out of a daily index body.
 * @param {string} body - Markdown body.
 * @returns {{relPath: string, name: string, description: string}[]} parsed notes.
 */
export function deriveNotes(body) {
  const text = typeof body === 'string' ? body : ''
  const start = text.indexOf(NOTES_BLOCK_START)
  const end = start >= 0 ? text.indexOf(NOTES_BLOCK_END, start + NOTES_BLOCK_START.length) : -1
  if (start < 0 || end < 0) return []
  const block = text.slice(start + NOTES_BLOCK_START.length, end)
  const notes = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('- [[')) continue
    const match = /^- \[\[([^\]\n]+)\]\]([\s\S]*)$/.exec(line)
    if (!match) continue
    const relPath = match[1].trim()
    if (relPath.length === 0) continue
    const rest = match[2].trim()
    let name = ''
    let description = ''
    const named = /^name:\s*([\s\S]*?)(?:\s+description:\s*([\s\S]*))?$/.exec(rest)
    if (named) {
      name = (named[1] ?? '').trim()
      description = (named[2] ?? '').trim()
    } else {
      const described = /^description:\s*([\s\S]*)$/.exec(rest)
      if (described) description = (described[1] ?? '').trim()
    }
    const fallbackName = (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '')
    notes.push({ relPath, name: name.length > 0 ? name : fallbackName, description })
  }
  return notes
}

/**
 * Render the managed note block for a daily index page.
 * @param {{relPath: string, name?: string, description?: string}[]} notes - note entries.
 * @returns {string} block text without surrounding blank lines.
 */
export function renderNotesBlock(notes) {
  const lines = []
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || typeof note.relPath !== 'string' || note.relPath.length === 0) continue
    const fallbackName = (note.relPath.split('/').pop() ?? note.relPath).replace(/\.md$/i, '')
    const name = inline(note.name) || fallbackName
    const description = inline(note.description)
    lines.push(`- [[${note.relPath.trim()}]] name: ${name} description: ${description}`)
  }
  const inner = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  return `${NOTES_BLOCK_START}\n${inner}${NOTES_BLOCK_END}`
}

/**
 * Replace (or append) the managed note block inside a body.
 * @param {string} body - existing Markdown body.
 * @param {string} block - rendered managed block.
 * @returns {string} rebuilt body.
 */
function replaceManagedBlock(body, block) {
  const text = typeof body === 'string' ? body : ''
  const start = text.indexOf(NOTES_BLOCK_START)
  const end = start >= 0 ? text.indexOf(NOTES_BLOCK_END, start + NOTES_BLOCK_START.length) : -1
  if (start >= 0 && end > start) {
    const before = text.slice(0, start)
    const after = text.slice(end + NOTES_BLOCK_END.length)
    return joinSections(before, block, after)
  }
  return joinSections(text, block, '')
}

/**
 * Join prose and the managed block with a single blank line between parts.
 * @param {string} before - prose before the block.
 * @param {string} block - managed block.
 * @param {string} after - prose after the block.
 * @returns {string} body text.
 */
function joinSections(before, block, after) {
  let out = before.replace(/\s+$/, '')
  if (out.length > 0) out += '\n\n'
  out += block
  const tail = after.replace(/^\s+/, '')
  if (tail.length > 0) out += `\n\n${tail}`
  return `${out}\n`
}

/** @param {unknown} value - inline frontmatter value. */
function inline(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** @param {string} value - candidate directory name. @param {string} fallback - default. */
function cleanDir(value, fallback) {
  const text = typeof value === 'string' ? value.trim().replace(/^[/\\]+|[/\\]+$/g, '') : ''
  if (text.length === 0 || text.includes('..')) return fallback
  return text
}

/** @param {unknown} error - thrown value. */
function isMissing(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}
