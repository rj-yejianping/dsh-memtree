/**
 * Browser-facing read/action API for the long-term memory settings panel.
 *
 * Routes are registered on the Host connection's exact-Fetch registry, so they
 * inherit the deployment's browser authentication and Host/Origin checks. The
 * Client panel calls them with relative `api/...` URLs.
 *
 * Everything here is read-mostly plus two explicit actions (dry-run/live
 * consolidation). Paths are resolved through {@link MemoryStore.resolve}, which
 * rejects traversal outside the memory root.
 *
 * @module dsh-long-term-memory/web-api
 */

import { stat } from 'node:fs/promises'
import { resolvePresetRoot } from './config.js'
import { join } from 'node:path'

const ROUTE_PREFIX = '/api/long-term-memory'

/** JSON response helper. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Failure response helper. */
function failure(message, status = 400) {
  return json({ ok: false, error: { code: 'long-term-memory/bad-request', message } }, status)
}

/** Parse a JSON body without throwing on an empty or malformed body. */
async function readBody(request) {
  try {
    const value = await request.json()
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * Describe the effective background route for one task, without its credential.
 * @param {object} config - normalized plugin configuration.
 * @param {'autoDream'} task - task name.
 * @returns {{model: string, baseURL: string, source: string}} route summary.
 */
function describeModel(config, task) {
  const base = config.backgroundModel ?? {}
  const override = config[task]?.model ?? {}
  const route = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined && value !== null && value !== '') route[key] = value
  }
  const model = typeof route.model === 'string' ? route.model : ''
  const baseURL = typeof route.baseURL === 'string' ? route.baseURL : ''
  return {
    model: model.length > 0 ? model : 'agent-default',
    baseURL,
    source: baseURL.length > 0 ? 'direct' : model.length > 0 ? 'host-provider' : 'agent-default',
  }
}

/** Title of one memory file: frontmatter name, else the file stem. */
function displayName(relPath, data) {
  const name = typeof data?.name === 'string' ? data.name.trim() : ''
  if (name.length > 0) return name
  const stem = relPath.split('/').pop() ?? relPath
  return stem.replace(/\.md$/i, '')
}

/** Group a memory file by its directory role. */
function groupOf(relPath, dailyDir, digestDir) {
  if (relPath === 'MEMORY.md') return 'core'
  if (relPath.startsWith(`${dailyDir}/`)) {
    return /^\d{4}-\d{2}-\d{2}\.md$/.test(relPath.slice(dailyDir.length + 1)) ? 'daily-index' : 'daily-note'
  }
  if (relPath.startsWith(`${digestDir}/`)) return 'digest'
  return 'other'
}

/**
 * Build the file inventory (with frontmatter summaries) for the panel.
 * @param {any} runtime - memory runtime.
 * @param {{dailyDir: string, digestDir: string}} config - plugin configuration.
 * @returns {Promise<{items: any[], byPath: Map<string, any>}>} inventory.
 */
async function buildInventory(runtime, config) {
  const files = await runtime.store.listMarkdown()
  files.sort((left, right) => left.relPath.localeCompare(right.relPath))
  const capped = files.slice(0, 600)
  const items = []
  for (const file of capped) {
    let data = {}
    try {
      const note = await runtime.store.readNote(file.relPath)
      data = note?.data ?? {}
    } catch {
      data = {}
    }
    items.push({
      relPath: file.relPath,
      group: groupOf(file.relPath, config.dailyDir, config.digestDir),
      name: displayName(file.relPath, data),
      description: typeof data?.description === 'string' ? data.description : '',
      mtimeMs: Number(file.mtimeMs) || 0,
      size: Number(file.size) || 0,
    })
  }
  return { items, byPath: new Map(items.map((item) => [item.relPath, item])) }
}

/**
 * Build the wikilink graph restricted to files that actually exist.
 * @param {any} runtime - memory runtime.
 * @param {Map<string, any>} byPath - inventory lookup.
 * @returns {{nodes: any[], edges: any[]}} graph payload.
 */
function buildGraph(runtime, byPath) {
  const graph = runtime.indexer.graph
  const nodes = [...byPath.values()].map((item) => ({
    id: item.relPath,
    name: item.name,
    group: item.group,
  }))
  const known = new Set(byPath.keys())
  const edges = []
  const seen = new Set()
  for (const relPath of known) {
    let links = []
    try {
      links = graph?.outlinksOf?.(relPath) ?? []
    } catch {
      links = []
    }
    for (const link of links) {
      const target = typeof link?.target === 'string' ? link.target : ''
      if (target.length === 0 || !known.has(target)) continue
      const key = `${relPath}→${target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: relPath, to: target })
    }
  }
  return { nodes, edges }
}

/**
 * Register the panel's HTTP routes.
 *
 * @param {object} options - registration inputs.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context.
 * @param {object} options.config - normalized plugin configuration.
 * @param {(cwd?: string) => any} options.runtimeForCwd - resolve a runtime by working directory.
 * @param {(message: string) => void} [options.debug] - debug logger.
 * @param {{isEnabled: Function, setEnabled: Function, overrides: Function}} [options.settings]
 *   durable per-working-directory switches.
 * @param {(cwd: string) => Promise<boolean>} [options.enabledFor] - effective switch resolver.
 * @param {() => string[]} [options.listCwds] - working directories seen this process.
 * @param {() => Promise<any[]>} [options.listPresets] - Agent modes known to the registry.
 * @param {() => string | undefined} [options.currentCwd] - most recent working directory.
 * @param {() => string | undefined} [options.currentPreset] - most recent Agent mode.
 * @returns {() => void} disposer for the whole registration.
 */
export function registerWebApi({
  ctx,
  config,
  runtimeForCwd,
  debug = () => {},
  settings,
  enabledFor,
  listCwds = () => [],
  listPresets,
  currentCwd,
  currentPreset,
  readSettings,
  saveSettings,
  storeCredential,
  overridesFile,
}) {
  /**
   * Resolve the runtime a panel request targets.
   * @param {any} body - request body.
   * @returns {Promise<any>} runtime.
   */
  const resolveRuntime = async (body) => {
    const cwd = typeof body?.cwd === 'string' && body.cwd.length > 0 ? body.cwd : undefined
    const preset = typeof body?.preset === 'string' && body.preset.length > 0 ? body.preset : undefined
    return runtimeForCwd(cwd, preset)
  }

  /**
   * Collect the Agent-mode rows the panel renders.
   *
   * The registry is authoritative; modes seen this process fill the gap when the
   * registry is absent. Each row reports the memory root it maps to, so switching
   * a mode on is immediately understandable.
   *
   * @param {string} cwd - working directory used to render the root paths.
   * @returns {Promise<{rows: any[], cwd: string}>} rows for the panel.
   */
  const presetRows = async () => {
    const presets = typeof listPresets === 'function' ? await listPresets() : []
    const rows = []
    for (const preset of presets) {
      const enabled = enabledFor !== undefined
        ? await enabledFor(preset.id)
        : await settings?.isEnabled?.(preset.id) ?? true
      const root = resolvePresetRoot(config, preset.id)
      let hasMemory = false
      try {
        const info = await stat(join(root, 'MEMORY.md'))
        hasMemory = info.isFile()
      } catch {
        hasMemory = false
      }
      rows.push({
        id: preset.id,
        name: preset.name ?? preset.id,
        description: preset.description ?? '',
        broken: preset.broken ?? '',
        enabled,
        root,
        hasMemory,
      })
    }
    rows.sort((left, right) => left.name.localeCompare(right.name))
    return { rows, base: resolvePresetRoot({ ...config, perPreset: false }, '') }
  }

  const overview = async (request) => {
    const body = await readBody(request)
    try {
      const runtime = await resolveRuntime(body)
      await runtime.ensure()
      const inventory = await buildInventory(runtime, runtime.config)
      const graph = buildGraph(runtime, inventory.byPath)
      const meta = await runtime.store.loadMeta('dream-state')
      const chunks = (await runtime.indexer.ensure()).chunks ?? 0
      const memoryMd = await runtime.store.readMemoryMd()
      const embeddingsReady = await runtime.search.embeddingsReady()
      const activePreset = typeof body?.preset === 'string' && body.preset.length > 0
        ? body.preset
        : (currentPreset?.() ?? 'default')
      const enabled = enabledFor !== undefined ? await enabledFor(activePreset) : true
      const counts = { core: 0, 'daily-index': 0, 'daily-note': 0, digest: 0, other: 0 }
      for (const item of inventory.items) counts[item.group] = (counts[item.group] ?? 0) + 1
      return json({
        ok: true,
        value: {
          root: runtime.root,
          memoryMd,
          items: inventory.items,
          counts,
          chunks,
          graph,
          lastDreamAt: typeof meta?.lastRunAt === 'number' ? meta.lastRunAt : 0,
          embeddings: {
            enabled: runtime.config.search.embeddings.enabled === true,
            ready: embeddingsReady,
            model: runtime.config.search.embeddings.model,
            baseURL: runtime.config.search.embeddings.baseURL,
          },
          cwd: typeof body?.cwd === 'string' && body.cwd.length > 0 ? body.cwd : (currentCwd?.() ?? runtime.root),
          preset: activePreset,
          enabled,
          models: {
            dream: describeModel(runtime.config, 'autoDream'),
          },
        },
      })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const fileContent = async (request) => {
    const body = await readBody(request)
    const relPath = typeof body?.path === 'string' ? body.path.trim() : ''
    if (relPath.length === 0) return failure('missing path')
    try {
      const runtime = await resolveRuntime(body)
      await runtime.ensure()
      const note = await runtime.store.readNote(relPath)
      if (note === undefined) return failure(`not found: ${relPath}`, 404)
      return json({ ok: true, value: { relPath, text: note.text ?? note.body ?? '', data: note.data ?? {} } })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const search = async (request) => {
    const body = await readBody(request)
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (query.length === 0) return failure('missing query')
    try {
      const runtime = await resolveRuntime(body)
      const limit = Number.isFinite(Number(body?.limit)) ? Number(body.limit) : undefined
      const outcome = await runtime.searchMemory(query, { limit })
      return json({
        ok: true,
        value: {
          query,
          formatted: outcome.formatted,
          results: outcome.results.map((item) => ({
            relPath: item.relPath,
            startLine: item.startLine,
            endLine: item.endLine,
            score: item.score,
            bm25Score: item.bm25Score ?? 0,
            vectorScore: item.vectorScore ?? 0,
            headingPath: item.headingPath ?? [],
            text: item.text,
            outlinks: item.outlinks ?? [],
            inlinks: item.inlinks ?? [],
          })),
        },
      })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const dream = async (request) => {
    const body = await readBody(request)
    try {
      const runtime = await resolveRuntime(body)
      const outcome = await runtime.dream({ dryRun: body?.dryRun !== false })
      return json({ ok: true, value: { summary: outcome.summary, actions: outcome.actions } })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const setCredentialRoute = async (request) => {
    const body = await readBody(request)
    const group = typeof body?.group === 'string' ? body.group.trim() : ''
    const value = typeof body?.value === 'string' ? body.value : ''
    if (!['embeddings', 'memory', 'dream'].includes(group)) return failure('missing credential group')
    if (value.trim().length === 0) return failure('missing credential value')
    if (typeof storeCredential !== 'function') return failure('credential store unavailable', 503)
    try {
      const stored = await storeCredential(group, value)
      // Never echo the secret (or its name) back.
      return json({ ok: true, value: { group, stored } })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const settingsRoute = async () => {
    try {
      const value = typeof readSettings === 'function' ? await readSettings() : {}
      return json({ ok: true, value: { ...value, overridesFile: typeof overridesFile === 'function' ? overridesFile() : '' } })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const saveSettingsRoute = async (request) => {
    const body = await readBody(request)
    if (typeof saveSettings !== 'function') return failure('settings unavailable', 503)
    try {
      const value = await saveSettings(body ?? {})
      return json({ ok: true, value: { ...value, overridesFile: typeof overridesFile === 'function' ? overridesFile() : '' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(message, error instanceof TypeError ? 400 : 500)
    }
  }

  const presets = async (request) => {
    const body = await readBody(request)
    try {
      const { rows, base } = await presetRows()
      return json({
        ok: true,
        value: {
          rows,
          base,
          current: typeof currentPreset === 'function' ? (currentPreset() ?? rows[0]?.id ?? '') : (rows[0]?.id ?? ''),
          mode: config.scope.mode,
          defaultEnabled: config.scope.mode !== 'selected',
          perPreset: config.perPreset !== false,
        },
      })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const setPreset = async (request) => {
    const body = await readBody(request)
    const preset = typeof body?.preset === 'string' ? body.preset.trim() : ''
    if (preset.length === 0) return failure('missing preset')
    if (settings === undefined || typeof settings.setEnabled !== 'function') return failure('mode switches unavailable', 503)
    try {
      await settings.setEnabled(preset, body?.enabled === true)
      return json({ ok: true, value: { preset, enabled: body?.enabled === true } })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  }

  const routes = [
    ['overview', overview],
    ['file', fileContent],
    ['search', search],
    ['dream', dream],
    ['presets', presets],
    ['setPreset', setPreset],
    ['settings', settingsRoute],
    ['saveSettings', saveSettingsRoute],
    ['setCredential', setCredentialRoute],
  ]

  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection')
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      debug('connection.fetch.register unavailable; memory panel API disabled')
      return
    }
    for (const [name, handler] of routes) {
      connectionCtx.effect(
        () =>
          register({
            path: `${ROUTE_PREFIX}/${name}`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: handler,
          }),
        `long-term-memory.route.${name}`,
      )
    }
    debug(`registered ${routes.length} panel routes under ${ROUTE_PREFIX}`)
  })
}
