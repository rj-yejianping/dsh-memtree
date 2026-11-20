/**
 * Plugin configuration defaults and normalization.
 *
 * The row's `config` in `cordis.patch.yml` is merged over these defaults so the
 * plugin always runs with a complete, validated shape. Values are clamped where
 * a bad row value would otherwise break the background pipeline.
 *
 * @module dsh-long-term-memory/config
 */

import { isAbsolute, join, normalize as normalizePath, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Default configuration for the long-term memory plugin. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Memory root. Relative paths resolve against the DSH home; memory is global per Agent mode. */
  root: 'long-term-memory',
  /** Prompt and tool-output language: 'auto' | 'zh' | 'en'. */
  language: 'auto',
  /** Directory names inside `root`. */
  dailyDir: 'memory',
  digestDir: 'digest',
  metaDir: 'mem_metadata',
  /** Which Agent modes the feature applies to. */
  scope: {
    /** 'all' = on for every Agent mode except `presets`; 'selected' = off except `presets`. */
    mode: 'all',
    /**
     * Exception list; its meaning depends on `mode`.
     *
     * Empty by default: every Agent mode — including 创造模式/`cordis` — is treated
     * alike, so switching mode never silently changes whether memory is recorded.
     * An earlier default excluded `cordis` on the assumption that it only ran
     * subagents, which is not true; that made a user-chosen 创造模式 look broken.
     * Users who do want a mode excluded list it here (or switch it off in the
     * panel, which is the same store).
     */
    presets: [],
    /**
     * Whether subagent sessions take part in memory.
     *
     * `exclude` (default): a delegated session — `delegationDepth > 0`,
     * `origin: 'subagent'`, or a `parentSession` — gets no memory note, no
     * prompt injection, and no MEMORY.md section. Its own conversation is a
     * means to the parent's end, so recording it would flood the daily notes
     * with work-in-progress and file it under whichever mode happened to run.
     *
     * `include` restores the older behaviour. The rule is mode-independent:
     * it applies to subagents of *every* Agent mode, not just 创造模式.
     */
    subagents: 'exclude',
  },
  /** Keep one global memory tree per Agent mode. */
  perPreset: true,
  /** Background summarization models; an empty route falls back to the Agent default. */
  backgroundModel: {
    baseURL: '',
    apiKeyEnv: 'UNIAPI_API_KEY',
    provider: '',
    model: '',
    // Room for a reasoning model to think *and* answer: at 2048 the thinking
    // alone can consume the budget, which leaves an empty reply. The helper
    // also retries a truncated empty reply with a larger budget.
    maxTokens: 8192,
    temperature: 0.2,
    timeoutMs: 240000,
  },
  // Nightly consolidation. Daily at 04:00 local time (off-peak pricing) and at
  // most four changed notes per run; a small model budget keeps one night
  // cheap while the adaptive timeout stays well above the old 60s failure point.
  autoDream: {
    enabled: true,
    autoRun: true,
    intervalMinutes: 0,
    dailyAt: '04:00',
    minChangedNotes: 1,
    maxNotesPerRun: 4,
    maxDigestNodes: 40,
    model: { maxTokens: 8192, timeoutMs: 240000 },
  },
  search: {
    maxResults: 8,
    maxSnippetLines: 18,
    expandLinks: true,
    maxExpansions: 4,
    bm25: { k1: 1.5, b: 0.75 },
    embeddings: {
      enabled: false,
      baseURL: '',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      model: '',
      timeoutMs: 15000,
    },
  },
  inject: {
    guidance: true,
    memoryMd: true,
    memoryMdMaxBytes: 4096,
    // Enabled modes may edit memory directly; the Agent decides what to record.
    edit: true,
  },
  debug: false,
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeDeep(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeDeep(base[key], value) : value
  }
  return out
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Normalize "HH:MM" into a zero-padded clock string, or '' when invalid. */
function normalizeClock(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match === null) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return ''
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return ''
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
}

function cleanDirName(value, fallback) {
  const text = typeof value === 'string' ? value.trim().replace(/^[/\\]+|[/\\]+$/g, '') : ''
  if (text.length === 0 || text.includes('..')) return fallback
  return text
}

/**
 * Grammar a credential reference must match: a POSIX shell identifier.
 *
 * Mirrors `REF_PATTERN` in the Host `credentials` service. That service
 * rejects any other key *while loading the whole document*, so one
 * non-identifier entry makes every stored secret unreadable at the next start.
 * `apiKeyEnv` is a reference, never a value: a pasted key has to be refused
 * here instead of reaching `credentials.set`.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Override groups that carry their own `apiKeyEnv`. */
export const CREDENTIAL_GROUPS = Object.freeze(['embeddings', 'dream'])

/** Whether a raw string can name a credential reference at all. */
export function isCredentialRefName(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value.trim())
}

/**
 * Whether a string looks like a pasted secret rather than a variable name.
 *
 * Used only to pick a safe diagnostic: a value that is a secret must never be
 * echoed into a log line, a settings payload, or the overrides file.
 */
export function looksLikeSecret(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0) return false
  if (/^(sk|ak|pk|rk|ghp|gho|xox[abp])[-_]/i.test(text)) return true
  return text.length >= 32 && !/\s/.test(text) && /[^A-Za-z0-9_]/.test(text)
}

/**
 * Accept a credential reference name, or fall back.
 * @param {unknown} value - candidate `apiKeyEnv`.
 * @param {string} fallback - value used when the candidate is missing or illegal.
 * @returns {string} a legal reference name, or the fallback.
 */
export function normalizeApiKeyEnv(value, fallback) {
  return isCredentialRefName(value) ? value.trim() : fallback
}

/**
 * Repair an overrides document whose `apiKeyEnv` holds a secret instead of a name.
 *
 * The settings panel once exposed a free-text credential-name field; pasting a
 * key into it wrote the key into `overrides.json`, the plugin then used it as a
 * reference name, and the Host credential store ended up with a
 * `sk-…: sk-…` entry whose key is not a POSIX identifier — enough to make the
 * whole credentials document unloadable on the next start.
 *
 * The repaired entry is left with an empty name: the caller picks the target
 * reference, rescues the value into the credential store, and rewrites the
 * file. The secret comes back separately so it is never logged or
 * re-serialized as a name.
 *
 * @param {Record<string, unknown> | undefined} overrides - stored overrides.
 * @returns {{document: Record<string, unknown>, repairs: Array<{group: string, bad: string, secret: string}>}} detached document plus findings.
 */
export function repairOverridesDocument(overrides) {
  const source = isPlainObject(overrides) ? overrides : {}
  /** @type {Record<string, unknown>} */
  const document = {}
  for (const [key, value] of Object.entries(source)) {
    document[key] = isPlainObject(value) ? { ...value } : value
  }
  /** @type {Array<{group: string, bad: string, secret: string}>} */
  const repairs = []
  for (const group of CREDENTIAL_GROUPS) {
    const route = document[group]
    if (!isPlainObject(route) || !('apiKeyEnv' in route)) continue
    const raw = typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv.trim() : ''
    if (isCredentialRefName(raw)) continue
    const secret = looksLikeSecret(raw) ? raw : ''
    route.apiKeyEnv = ''
    // `bad` keeps a plain-but-illegal name for the diagnostic; a secret stays
    // out of it entirely and only travels to the credential store.
    repairs.push({ group, bad: secret.length > 0 ? '' : raw, secret })
  }
  return { document, repairs }
}

/**
 * Normalize one background-model route.
 *
 * Resolution order at call time: an explicit `baseURL` means "call this
 * OpenAI-compatible endpoint directly with its own key"; otherwise a
 * `provider` + `model` pair selects a registered Host route; an empty route
 * falls back to the Agent's default model.
 *
 * @param {Record<string, unknown> | undefined} value - raw route config.
 * @param {Record<string, unknown>} fallback - defaults for omitted fields.
 * @returns {{baseURL: string, apiKeyEnv: string, provider: string, model: string, maxTokens: number|undefined, temperature: number|undefined, timeoutMs: number}} normalized route.
 */
/** Normalize the scope exception list into trimmed, unique preset ids. */
function normalizePresetList(value, fallback) {
  if (!Array.isArray(value)) return [...(Array.isArray(fallback) ? fallback : [])]
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text.length > 0 && !out.includes(text)) out.push(text)
  }
  return out
}

function normalizeModel(value, fallback = {}) {
  const source = isPlainObject(value) ? value : {}
  const base = isPlainObject(fallback) ? fallback : {}
  const pickString = (key) => {
    const raw = source[key] !== undefined ? source[key] : base[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const pickNumber = (key, min, max) => {
    const raw = source[key] !== undefined ? source[key] : base[key]
    if (raw === undefined || raw === null || raw === '') return undefined
    const number = Number(raw)
    if (!Number.isFinite(number)) return undefined
    return Math.min(max, Math.max(min, number))
  }
  const route = pickString('route')
  return {
    // Where a task route goes: 'default' (Agent default model), 'host' (a
    // registered Host provider), 'custom' (the baseURL below), or '' for a
    // legacy row that predates the label.
    route: route === 'default' || route === 'host' || route === 'custom' ? route : '',
    baseURL: pickString('baseURL').replace(/\/+$/, ''),
    // A route with no legal name stays empty so the Agent default model wins;
    // `backgroundModel` supplies its own fallback through DEFAULT_CONFIG.
    apiKeyEnv: normalizeApiKeyEnv(pickString('apiKeyEnv'), ''),
    provider: pickString('provider'),
    model: pickString('model'),
    maxTokens: pickNumber('maxTokens', 1, 200000),
    temperature: pickNumber('temperature', 0, 2),
    timeoutMs: pickNumber('timeoutMs', 1000, 600000) ?? 60000,
  }
}

/**
 * Normalize one raw Loader row config into the complete runtime shape.
 * @param {Record<string, unknown> | undefined} raw - the row's `config` object.
 * @returns {typeof DEFAULT_CONFIG} a detached, validated configuration.
 */
export function resolveConfig(raw) {
  const merged = mergeDeep(DEFAULT_CONFIG, raw ?? {})
  const language = merged.language === 'zh' || merged.language === 'en' ? merged.language : 'auto'
  const root = typeof merged.root === 'string' && merged.root.trim().length > 0 ? merged.root.trim() : DEFAULT_CONFIG.root
  return {
    root,
    language,
    dailyDir: cleanDirName(merged.dailyDir, DEFAULT_CONFIG.dailyDir),
    digestDir: cleanDirName(merged.digestDir, DEFAULT_CONFIG.digestDir),
    metaDir: cleanDirName(merged.metaDir, DEFAULT_CONFIG.metaDir),
    scope: {
      mode: merged.scope?.mode === 'selected' ? 'selected' : 'all',
      presets: normalizePresetList(merged.scope?.presets, DEFAULT_CONFIG.scope.presets),
      subagents: merged.scope?.subagents === 'include' ? 'include' : 'exclude',
    },
    perPreset: merged.perPreset !== false,
    backgroundModel: normalizeModel(merged.backgroundModel, DEFAULT_CONFIG.backgroundModel),
    autoDream: {
      enabled: merged.autoDream.enabled !== false,
      autoRun: merged.autoDream.autoRun !== false,
      intervalMinutes: clampInt(merged.autoDream.intervalMinutes, 0, 0, 7 * 24 * 60),
      dailyAt: normalizeClock(merged.autoDream.dailyAt),
      minChangedNotes: clampInt(merged.autoDream.minChangedNotes, 1, 1, 100),
      maxNotesPerRun: clampInt(merged.autoDream.maxNotesPerRun, DEFAULT_CONFIG.autoDream.maxNotesPerRun, 1, 100),
      maxDigestNodes: clampInt(merged.autoDream.maxDigestNodes, DEFAULT_CONFIG.autoDream.maxDigestNodes, 1, 500),
      model: normalizeModel(merged.autoDream.model, {}),
    },
    search: {
      maxResults: clampInt(merged.search.maxResults, DEFAULT_CONFIG.search.maxResults, 1, 50),
      maxSnippetLines: clampInt(merged.search.maxSnippetLines, DEFAULT_CONFIG.search.maxSnippetLines, 3, 200),
      expandLinks: merged.search.expandLinks !== false,
      maxExpansions: clampInt(merged.search.maxExpansions, DEFAULT_CONFIG.search.maxExpansions, 0, 20),
      bm25: {
        k1: clampNumber(merged.search.bm25.k1, DEFAULT_CONFIG.search.bm25.k1, 0.1, 5),
        b: clampNumber(merged.search.bm25.b, DEFAULT_CONFIG.search.bm25.b, 0, 1),
      },
      embeddings: {
        enabled: merged.search.embeddings.enabled === true,
        baseURL: typeof merged.search.embeddings.baseURL === 'string' ? merged.search.embeddings.baseURL.trim().replace(/\/+$/, '') : '',
        apiKeyEnv: normalizeApiKeyEnv(merged.search.embeddings.apiKeyEnv, DEFAULT_CONFIG.search.embeddings.apiKeyEnv),
        model: typeof merged.search.embeddings.model === 'string' ? merged.search.embeddings.model.trim() : '',
        timeoutMs: clampInt(merged.search.embeddings.timeoutMs, DEFAULT_CONFIG.search.embeddings.timeoutMs, 1000, 120000),
      },
    },
    inject: {
      guidance: merged.inject.guidance !== false,
      memoryMd: merged.inject.memoryMd !== false,
      memoryMdMaxBytes: clampInt(merged.inject.memoryMdMaxBytes, DEFAULT_CONFIG.inject.memoryMdMaxBytes, 0, 65536),
      edit: merged.inject.edit !== false,
    },
    debug: merged.debug === true,
  }
}

/**
 * Resolve the DSH home directory.
 * @returns {string} absolute DSH home.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Resolve the global memory root for one Agent mode.
 *
 * Memory is global per Agent mode, not per working directory: switching between
 * Standard / PTC / Minimal / Create keeps four independent trees under the DSH
 * home, and every session running that mode shares one memory.
 *
 * A relative `root` resolves against the DSH home; an absolute `root` is used
 * as-is. `perPreset: false` collapses all modes onto the base directory.
 *
 * @param {ReturnType<typeof resolveConfig>} config - normalized configuration.
 * @param {string} preset - Agent mode id.
 * @param {{cwd?: string}} [options] - reserved; the cwd no longer selects the root.
 * @returns {string} absolute memory root.
 */
export function resolvePresetRoot(config, preset, options = {}) {
  const base = isAbsolute(config.root) ? normalizePath(config.root) : resolve(dshHome(), config.root)
  if (config.perPreset === false) return base
  const id = String(preset ?? '').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '')
  return id.length === 0 ? base : resolve(base, id)
}

/**
 * Backward-compatible alias for the base memory directory.
 * @param {ReturnType<typeof resolveConfig>} config - normalized configuration.
 * @param {string} [_cwd] - ignored; kept for older callers.
 * @returns {string} absolute base directory.
 */
export function resolveRoot(config, _cwd) {
  return resolveBaseRoot(config)
}

/**
 * Base memory directory (before the mode suffix), for diagnostics.
 * @param {ReturnType<typeof resolveConfig>} config - normalized configuration.
 * @returns {string} absolute base directory.
 */
export function resolveBaseRoot(config) {
  return isAbsolute(config.root) ? normalizePath(config.root) : resolve(dshHome(), config.root)
}

/**
 * Whether embedding search is actually usable for this config/environment.
 * @param {ReturnType<typeof resolveConfig>} config - normalized configuration.
 * @returns {boolean} true when endpoint, model, and credential are all present.
 */
export function embeddingsUsable(config) {
  const embeddings = config.search.embeddings
  if (!embeddings.enabled) return false
  if (embeddings.baseURL.length === 0 || embeddings.model.length === 0) return false
  return typeof process.env[embeddings.apiKeyEnv] === 'string' && process.env[embeddings.apiKeyEnv].length > 0
}

/** Trim a string override, or undefined when absent/empty. */
function overrideString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Finite numeric override, clamped. */
function overrideNumber(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.min(max, Math.max(min, number))
}

/**
 * Merge one task's model route over the shared background route.
 *
 * The stored task row wins over the shared `backgroundModel` row, and the
 * explicit `route` label decides where the call goes:
 *
 * - `default`: the Agent default model. Whatever endpoint or model id the shared
 *   row carries is dropped, so the panel's "默认模型" really means the Agent
 *   default even when a profile configured a background endpoint.
 * - `host`: a registered Host provider/model route, again with no private
 *   endpoint and no credential.
 * - `custom`: the OpenAI-compatible endpoint stored on the task row.
 * - absent: legacy merge — a task field overrides the shared row only when it
 *   is non-empty.
 *
 * @param {object} config - normalized plugin configuration.
 * @param {'autoDream'} task - task name.
 * @returns {object} effective route for that task.
 */
export function mergedModel(config, task) {
  const base = config?.backgroundModel ?? {}
  const override = config?.[task]?.model ?? {}
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null || value === '') continue
    merged[key] = value
  }
  const route = typeof override.route === 'string' ? override.route : ''
  if (route === 'default') {
    merged.baseURL = ''
    merged.apiKeyEnv = ''
    merged.provider = ''
    merged.model = ''
  } else if (route === 'host') {
    merged.baseURL = ''
    merged.apiKeyEnv = ''
  }
  delete merged.route
  return merged
}

/**
 * Apply panel-editable overrides onto a normalized config, in place.
 *
 * Only the three routes the settings tab owns are touched: semantic-search
 * embeddings, the on-demand summary model, and the Auto Dream model. Mutating the
 * shared config object means already-created runtimes pick the change up on
 * their next operation; model helpers re-read their route lazily.
 *
 * @param {ReturnType<typeof resolveConfig>} config - normalized config to mutate.
 * @param {{embeddings?: object, memory?: object, dream?: object}} overrides - stored overrides.
 * @returns {ReturnType<typeof resolveConfig>} the same config object.
 */
export function applyOverrides(config, overrides) {
  const embeddings = overrides?.embeddings
  if (isPlainObject(embeddings)) {
    const target = config.search.embeddings
    if (typeof embeddings.enabled === 'boolean') target.enabled = embeddings.enabled
    const baseURL = overrideString(embeddings.baseURL)
    if (baseURL !== undefined) target.baseURL = baseURL.replace(/\/+$/, '')
    const model = overrideString(embeddings.model)
    if (model !== undefined) target.model = model
    const apiKeyEnv = overrideString(embeddings.apiKeyEnv)
    // Only a legal reference name is applied. A stored key body is ignored here
    // so an old overrides document can never turn a secret into a name.
    if (apiKeyEnv !== undefined && isCredentialRefName(apiKeyEnv)) target.apiKeyEnv = apiKeyEnv
    const timeout = overrideNumber(embeddings.timeoutMs, 1000, 120000)
    if (timeout !== undefined) target.timeoutMs = Math.trunc(timeout)
  }

  const route = (source, target) => {
    if (!isPlainObject(source)) return
    const label = typeof source.route === 'string' ? source.route.trim() : undefined
    if (label === 'default' || label === 'host' || label === 'custom') target.route = label
    const baseURL = typeof source.baseURL === 'string' ? source.baseURL.trim().replace(/\/+$/, '') : undefined
    if (baseURL !== undefined) target.baseURL = baseURL
    const model = typeof source.model === 'string' ? source.model.trim() : undefined
    if (model !== undefined) target.model = model
    const apiKeyEnv = typeof source.apiKeyEnv === 'string' ? source.apiKeyEnv.trim() : undefined
    if (apiKeyEnv !== undefined && isCredentialRefName(apiKeyEnv)) target.apiKeyEnv = apiKeyEnv
    const provider = typeof source.provider === 'string' ? source.provider.trim() : undefined
    if (provider !== undefined) target.provider = provider
    const maxTokens = overrideNumber(source.maxTokens, 1, 200000)
    if (maxTokens !== undefined) target.maxTokens = Math.trunc(maxTokens)
    const temperature = overrideNumber(source.temperature, 0, 2)
    if (temperature !== undefined) target.temperature = temperature
    const timeout = overrideNumber(source.timeoutMs, 1000, 600000)
    if (timeout !== undefined) target.timeoutMs = Math.trunc(timeout)
  }

  route(overrides?.dream, config.autoDream.model)

  const rhythm = overrides?.rhythm
  if (isPlainObject(rhythm)) {
    const dream = isPlainObject(rhythm.autoDream) ? rhythm.autoDream : {}
    if (typeof dream.enabled === 'boolean') config.autoDream.enabled = dream.enabled
    if (typeof dream.autoRun === 'boolean') config.autoDream.autoRun = dream.autoRun
    const interval = overrideNumber(dream.intervalMinutes, 0, 7 * 24 * 60)
    if (interval !== undefined) config.autoDream.intervalMinutes = Math.trunc(interval)
    if (typeof dream.dailyAt === 'string') config.autoDream.dailyAt = normalizeClock(dream.dailyAt)
  }
  return config
}
