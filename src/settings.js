/**
 * Per-Agent-mode (Agent preset) enablement for the long-term memory plugin.
 *
 * A "working mode" is one Agent preset — 标准模式 / PTC 模式 / 极简模式 / 创造模式 in the
 * Web UI. Each mode keeps its own `$DSH_HOME/long-term-memory/<mode>/` tree — memory is
 * global per mode, never a `.dsh-memory/` inside the workspace — and this module owns
 * the durable on/off decision for those modes:
 *
 * - `config.scope.mode === 'all'` (default): every mode is enabled unless a stored
 *   entry explicitly disables it.
 * - `config.scope.mode === 'selected'`: disabled unless a stored entry enables it.
 *
 * The store is a small JSON file under the DSH home, written atomically. It is
 * plugin-owned state, separate from the memory content, so deleting a memory tree
 * never flips a mode's switch.
 *
 * @module dsh-long-term-memory/settings
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const STATE_VERSION = 1
const DEFAULT_FILE_NAME = 'long-term-memory/presets.json'

/** Resolve the DSH home directory. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Durable per-mode switches.
 */
export class PresetSettings {
  /**
   * @param {object} [options] - settings options.
   * @param {string} [options.file] - absolute state file path.
   * @param {boolean} [options.defaultEnabled] - value when no entry exists.
   * @param {{ debug?: Function, warn?: Function }} [options.logger] - Cordis logger.
   */
  constructor({ file, defaultEnabled = true, logger } = {}) {
    this.file = typeof file === 'string' && file.length > 0 ? file : join(dshHome(), DEFAULT_FILE_NAME)
    this.defaultEnabled = defaultEnabled !== false
    this.logger = logger
    /** @type {Promise<Record<string, boolean>> | undefined} */
    this.loaded = undefined
    /** @type {Promise<unknown>} */
    this.writeChain = Promise.resolve()
  }

  /** Read and cache the state file. */
  async read() {
    if (this.loaded !== undefined) return this.loaded
    this.loaded = (async () => {
      try {
        const text = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(text)
        const presets = parsed?.presets
        /** @type {Record<string, boolean>} */
        const out = {}
        if (presets !== null && typeof presets === 'object') {
          for (const [key, value] of Object.entries(presets)) {
            if (typeof value === 'boolean') out[key] = value
          }
        }
        return out
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger?.debug?.(`[long-term-memory] preset settings unreadable: ${error instanceof Error ? error.message : String(error)}`)
        }
        return {}
      }
    })()
    return this.loaded
  }

  /** Persist the current map atomically. */
  async persist(map) {
    const payload = JSON.stringify({ version: STATE_VERSION, presets: map }, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    })
    await this.writeChain
  }

  /**
   * Whether one Agent mode currently has the feature enabled.
   *
   * `fallback` is the per-mode default from `scope.mode` + `scope.presets` — a
   * preset listed under `scope.presets` defaults to *off* when `scope.mode` is
   * `all`. Ignoring it (as this method once did) made that exclusion list dead
   * config: every mode fell back to the blanket `defaultEnabled` instead.
   *
   * @param {string} preset - Agent preset id.
   * @param {boolean} [fallback] - per-mode default; defaults to `defaultEnabled`.
   * @returns {Promise<boolean>} effective switch value.
   */
  async isEnabled(preset, fallback) {
    const base = typeof fallback === 'boolean' ? fallback : this.defaultEnabled
    if (typeof preset !== 'string' || preset.length === 0) return base
    const map = await this.read()
    const explicit = map[normalizeKey(preset)]
    return typeof explicit === 'boolean' ? explicit : base
  }

  /**
   * Set one Agent mode's switch.
   * @param {string} preset - Agent preset id.
   * @param {boolean} enabled - desired value.
   * @returns {Promise<void>} after the durable write.
   */
  async setEnabled(preset, enabled) {
    const key = normalizeKey(preset)
    const map = { ...(await this.read()) }
    map[key] = enabled === true
    this.loaded = Promise.resolve(map)
    await this.persist(map)
  }

  /**
   * Raw stored overrides, for diagnostics.
   * @returns {Promise<Record<string, boolean>>} preset id → enabled.
   */
  async overrides() {
    return { ...(await this.read()) }
  }
}

/** Normalize a mode id into a stable state-file key. */
export function normalizeKey(preset) {
  return String(preset ?? '').trim()
}

const OVERRIDES_FILE = 'long-term-memory/overrides.json'

/**
 * Read the panel-editable overrides synchronously.
 *
 * These override the profile row's YAML for the three routes a user is most
 * likely to change (semantic search endpoint, on-demand summary model, Auto Dream
 * model) without editing the profile file. Secrets are never stored here: only
 * the credential *name* (`apiKeyEnv`) is persisted.
 *
 * @param {{logger?: any}} [options] - optional logger.
 * @returns {{version: number, embeddings?: object, memory?: object, dream?: object, rhythm?: object}} overrides.
 */
export function readOverridesSync({ logger } = {}) {
  const file = join(dshHome(), OVERRIDES_FILE)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { version: 1 }
    return {
      version: 1,
      embeddings: plain(parsed.embeddings),
      memory: plain(parsed.memory),
      dream: plain(parsed.dream),
      rhythm: plain(parsed.rhythm),
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.debug?.(`[long-term-memory] overrides unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return { version: 1 }
  }
}

/** Keep only plain objects. */
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Persist the overrides atomically and return the stored value.
 * @param {{embeddings?: object, memory?: object, dream?: object, rhythm?: object}} next - override values.
 * @returns {Promise<object>} the written document.
 * @throws {Error} when the write fails.
 */
export async function writeOverrides(next) {
  const file = join(dshHome(), OVERRIDES_FILE)
  const document = { version: 1 }
  for (const key of ['embeddings', 'dream', 'rhythm']) {
    const value = plain(next?.[key])
    if (value !== undefined) document[key] = value
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(document, null, 2), 'utf8')
  await rename(tmp, file)
  return document
}

/** Absolute path of the overrides file, for display. */
export function overridesFile() {
  return join(dshHome(), OVERRIDES_FILE)
}
