/**
 * Markdown primitives for the long-term memory plugin: simple YAML frontmatter,
 * tokenization (latin words + CJK bigrams), wikilinks, safe file slugs, and
 * structure-aware chunking that keeps code fences and tables intact.
 *
 * @module dsh-long-term-memory/markdown
 */

const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/
const BLANK_RE = /^[ \t]*$/
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/
const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g
/** CJK ideographs (incl. ext A / compat), kana, and hangul syllables. */
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/
const TOKEN_RE = new RegExp(
  `${CJK_RUN_RE.source}|[A-Za-z0-9_]+(?:['\u2019-][A-Za-z0-9_]+)*`,
  'g',
)
const EXTERNAL_TARGET_RE = /^(?:https?:|mailto:|ftp:|tel:|data:)/i
const MAX_HEADING_TITLE_CHARS = 200

/**
 * Split `text` into its (optional) leading frontmatter block and body.
 * Frontmatter is a simple `key: value` block delimited by `---` lines.
 *
 * @param {string} text - raw Markdown file content.
 * @returns {{data: Record<string,string>, raw: string, body: string}} parsed parts.
 */
export function parseFrontmatter(text) {
  const parts = readFrontmatterParts(text)
  if (parts.closeLineIndex < 0) return { data: {}, body: typeof text === 'string' ? text : '', raw: '' }
  const body = parts.lines.slice(parts.closeLineIndex + 1).join('\n').replace(/^\n+/, '')
  return { data: parts.data, body, raw: parts.raw }
}

/**
 * Render frontmatter + body as a Markdown document. Inverse of
 * {@link parseFrontmatter} for the subset of YAML this plugin writes.
 *
 * @param {Record<string, unknown>} data - scalar frontmatter entries.
 * @param {string} body - Markdown body (leading blank lines are dropped).
 * @returns {string} `---\nkey: value\n---\n\n<body>`.
 */
export function stringifyFrontmatter(data, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${formatScalar(String(value))}`)
  }
  lines.push('---')
  const header = lines.join('\n')
  const normalizedBody = String(body ?? '').replace(/^\n+/, '').replace(/\n*$/, '')
  if (normalizedBody.length === 0) return `${header}\n`
  return `${header}\n\n${normalizedBody}\n`
}

/**
 * Tokenize text for BM25: lowercase latin/digit words plus CJK bigrams
 * (single-character tokens for one-character CJK runs).
 *
 * @param {string} text - any text (note body, heading path, query).
 * @returns {string[]} tokens in source order.
 */
export function tokenize(text) {
  const input = typeof text === 'string' ? text : ''
  const tokens = []
  for (const match of input.matchAll(TOKEN_RE)) {
    const value = match[0]
    if (CJK_RUN_RE.test(value)) {
      const chars = Array.from(value)
      if (chars.length === 1) {
        tokens.push(chars[0])
        continue
      }
      for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1])
      continue
    }
    tokens.push(value.toLowerCase())
  }
  return tokens
}

/**
 * Turn an arbitrary display name into a safe single-segment file name.
 * Keeps CJK, strips path separators and control characters, collapses
 * whitespace to `-`, and truncates to 60 characters.
 *
 * @param {string} name - display name or slug candidate.
 * @returns {string} non-empty, path-safe slug.
 */
export function slugify(name) {
  let slug = String(name ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/[-._]+$/, '')
  return slug.length > 0 ? slug : 'untitled'
}

/**
 * Extract wikilinks from Markdown.
 * Supports `[[path]]` and `[[path|display name]]`; external URLs are dropped.
 *
 * @param {string} text - Markdown text.
 * @returns {{target: string, name: string}[]} links in source order.
 */
export function extractWikilinks(text) {
  const input = typeof text === 'string' ? text : ''
  const links = []
  const seen = new Set()
  WIKILINK_RE.lastIndex = 0
  for (const match of input.matchAll(WIKILINK_RE)) {
    const inner = match[1].trim()
    if (inner.length === 0) continue
    const pipeIndex = inner.indexOf('|')
    const target = (pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner).trim()
    if (target.length === 0 || EXTERNAL_TARGET_RE.test(target)) continue
    const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : ''
    const name = alias.length > 0 ? alias : displayNameOf(target)
    const key = `${target}\u0000${name}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ target, name })
  }
  return links
}

/**
 * Chunk one Markdown file by heading hierarchy, then by blank-line separated
 * blocks inside each section. Blocks are merged up to `maxChars`; a fenced code
 * block or table is never split. Line numbers are 1-based in the original file
 * (frontmatter included).
 *
 * @param {string} relPath - path of the file relative to the memory root.
 * @param {string} text - raw file content.
 * @param {{maxChars?: number}} [opts] - chunk sizing options.
 * @returns {{relPath: string, startLine: number, endLine: number, headingPath: string[], headingLevels: number[], text: string}[]} chunks in file order.
 */
export function splitChunks(relPath, text, opts = {}) {
  const maxChars = positiveInt(opts.maxChars, 1200)
  const source = typeof text === 'string' ? text : ''
  const parts = readFrontmatterParts(source)
  const lines = parts.lines
  const bodyStart = parts.closeLineIndex < 0 ? 0 : parts.closeLineIndex + 1
  const headings = scanHeadings(lines, bodyStart)

  /** @type {{startLine: number, endLine: number, headingPath: string[], headingLevels: number[], text: string}[]} */
  const chunks = []
  const stack = []
  const sections = []

  const preambleEnd = headings.length > 0 ? headings[0].lineIndex : lines.length
  if (preambleEnd > bodyStart) sections.push({ start: bodyStart, end: preambleEnd, headingPath: [], headingLevels: [] })
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack.push(heading)
    sections.push({
      start: heading.lineIndex + 1,
      end: index + 1 < headings.length ? headings[index + 1].lineIndex : lines.length,
      headingPath: stack.map((item) => item.title),
      headingLevels: stack.map((item) => item.level),
    })
  }

  for (const section of sections) {
    const { start, end, headingPath, headingLevels } = section
    const blocks = collectBlocks(lines, start, end)
    for (const group of mergeBlocks(lines, blocks, maxChars)) {
      const chunkText = lines.slice(group.start, group.end + 1).join('\n').replace(/^\n+|\s+$/g, '')
      if (chunkText.length === 0) continue
      chunks.push({
        relPath,
        startLine: group.start + 1,
        endLine: group.end + 1,
        headingPath,
        headingLevels,
        text: chunkText,
      })
    }
  }
  return chunks
}

/**
 * Internal: body start / raw frontmatter / parsed data.
 * @param {unknown} text - raw content.
 * @returns {{data: Record<string,string>, raw: string, lines: string[], closeLineIndex: number}}
 */
function readFrontmatterParts(text) {
  const source = typeof text === 'string' ? text : ''
  const lines = source.split(/\r?\n/)
  const empty = { data: {}, raw: '', lines, closeLineIndex: -1 }
  if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0])) return empty

  let closeLineIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---[ \t]*$/.test(lines[i])) {
      closeLineIndex = i
      break
    }
  }
  if (closeLineIndex < 0) return empty

  /** @type {Record<string,string>} */
  const data = {}
  for (const line of lines.slice(1, closeLineIndex)) {
    const match = FRONTMATTER_KEY_RE.exec(line)
    if (!match) continue
    data[match[1]] = parseScalar(match[2])
  }
  const raw = lines.slice(0, closeLineIndex + 1).join('\n')
  return { data, raw, lines, closeLineIndex }
}

/** @param {string} rawValue - unparsed scalar text. */
function parseScalar(rawValue) {
  const value = rawValue.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** @param {string} value - scalar to encode. */
function formatScalar(value) {
  const needsQuote =
    /^\s|\s$/.test(value) ||
    value.includes(': ') ||
    value.includes('#') ||
    value.includes('\n') ||
    value.includes('\t') ||
    /^["'[{]/.test(value) ||
    value.length === 0
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`
}

/**
 * Locate heading lines outside fenced code blocks.
 * @param {string[]} lines - file lines.
 * @param {number} from - first body line index.
 * @returns {{lineIndex: number, level: number, title: string}[]}
 */
function scanHeadings(lines, from) {
  const headings = []
  let fence = null
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i]
    if (fence) {
      if (isFenceClose(line, fence)) fence = null
      continue
    }
    const fenceMatch = FENCE_OPEN_RE.exec(line)
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }
    const headingMatch = HEADING_RE.exec(line)
    if (!headingMatch) continue
    const title = headingMatch[2].replace(/[ \t]+#+$/, '').trim()
    if (title.length === 0) continue
    headings.push({
      lineIndex: i,
      level: headingMatch[1].length,
      title: title.length > MAX_HEADING_TITLE_CHARS ? title.slice(0, MAX_HEADING_TITLE_CHARS) : title,
    })
  }
  return headings
}

/**
 * Split a line range on blank lines, never breaking a fenced code block.
 * @param {string[]} lines - file lines.
 * @param {number} start - inclusive start index.
 * @param {number} end - exclusive end index.
 * @returns {{start: number, end: number}[]} block spans.
 */
function collectBlocks(lines, start, end) {
  const blocks = []
  let current = null
  let fence = null
  for (let i = start; i < end; i += 1) {
    const line = lines[i]
    if (fence) {
      current.end = i
      if (isFenceClose(line, fence)) fence = null
      continue
    }
    const fenceMatch = FENCE_OPEN_RE.exec(line)
    if (fenceMatch) {
      if (!current) current = { start: i, end: i }
      current.end = i
      fence = fenceMatch[1]
      continue
    }
    if (BLANK_RE.test(line)) {
      if (current) {
        blocks.push(current)
        current = null
      }
      continue
    }
    if (!current) current = { start: i, end: i }
    current.end = i
  }
  if (current) blocks.push(current)
  return blocks
}

/**
 * Merge adjacent blocks while the combined character count fits `maxChars`.
 * @param {string[]} lines - file lines.
 * @param {{start: number, end: number}[]} blocks - block spans.
 * @param {number} maxChars - soft chunk size ceiling.
 * @returns {{start: number, end: number}[]} chunk spans.
 */
function mergeBlocks(lines, blocks, maxChars) {
  const groups = []
  let current = null
  for (const block of blocks) {
    const chars = lines.slice(block.start, block.end + 1).join('\n').length
    if (current && current.chars + 2 + chars <= maxChars) {
      current.end = block.end
      current.chars += 2 + chars
      continue
    }
    if (current) groups.push(current)
    current = { start: block.start, end: block.end, chars }
  }
  if (current) groups.push(current)
  return groups
}

/** @param {string} line - candidate fence line. @param {string} fence - opening marker. */
function isFenceClose(line, fence) {
  const match = FENCE_CLOSE_RE.exec(line)
  if (!match) return false
  return match[1][0] === fence[0] && match[1].length >= fence.length
}

/** @param {unknown} value - positive integer candidate. @param {number} fallback - default. */
function positiveInt(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.trunc(number)
}

/** @param {string} relPath - wikilink target. */
function displayNameOf(relPath) {
  const segments = relPath.split('/')
  const base = segments[segments.length - 1] ?? relPath
  return base.replace(/\.md$/i, '')
}
