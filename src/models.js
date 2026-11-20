/**
 * Model choices for the settings panel.
 *
 * The Auto Dream route can already run on a Host `llm` route (`provider` +
 * `model`, no `baseURL`), but the panel only offered a free-text model id next
 * to a private endpoint and a key. Listing what the Host already has configured
 * (Settings → Models) lets the panel offer those routes instead, so the default
 * path is "follow the Agent default model" rather than "fill in an endpoint".
 *
 * The listing is defensive on purpose: one adapter that throws while answering
 * `listModels` must not empty the whole picker, and a missing `llm` service must
 * still leave the panel usable with the default-model option.
 *
 * @module dsh-memtree/models
 */

/**
 * Normalize a default-model selection.
 *
 * @param {{provider?: string, model?: string} | undefined} value - selection.
 * @returns {{provider: string, model: string} | undefined} both fields non-empty, else undefined.
 */
function normalizeSelection(value) {
  if (value === null || typeof value !== 'object') return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

/**
 * Read the current Agent default model selection.
 *
 * @param {(() => unknown) | undefined} source - resolver, or undefined.
 * @returns {{provider: string, model: string} | undefined} normalized selection.
 */
function resolveDefaultSelection(source) {
  if (typeof source !== 'function') return undefined
  try {
    return normalizeSelection(source())
  } catch {
    return undefined
  }
}

/**
 * Describe the models the Host service can currently route.
 *
 * @param {object} options - listing inputs.
 * @param {{listProviders?: Function, listModels?: Function}} [options.llm] - Host `llm` service.
 * @param {(() => unknown)} [options.defaultSelection] - resolves the Agent default model.
 * @returns {Promise<{providers: Array<{id: string, name: string, models: Array<{id: string, name: string}>}>, default?: {provider: string, model: string}}>} picker payload.
 */
export async function listModelChoices({ llm, defaultSelection } = {}) {
  const providers = []
  if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') {
    let infos = []
    try {
      infos = llm.listProviders()
    } catch {
      infos = []
    }
    for (const info of Array.isArray(infos) ? infos : []) {
      const id = typeof info?.id === 'string' ? info.id.trim() : ''
      if (id.length === 0) continue
      let advertised = []
      if (typeof llm.listModels === 'function') {
        try {
          advertised = await llm.listModels(id)
        } catch {
          // A provider that cannot enumerate its catalog is still a real route;
          // the picker shows it empty rather than dropping it.
          advertised = []
        }
      }
      const models = []
      const seen = new Set()
      for (const model of Array.isArray(advertised) ? advertised : []) {
        const modelId = typeof model?.id === 'string' ? model.id.trim() : ''
        if (modelId.length === 0 || seen.has(modelId)) continue
        seen.add(modelId)
        const name = typeof model?.name === 'string' && model.name.trim().length > 0 ? model.name.trim() : modelId
        models.push({ id: modelId, name })
      }
      const name = typeof info.name === 'string' && info.name.trim().length > 0 ? info.name.trim() : id
      providers.push({ id, name, models })
    }
  }
  const resolved = resolveDefaultSelection(defaultSelection)
  return resolved === undefined ? { providers } : { providers, default: resolved }
}

/**
 * Encode one route the way the panel's `<select>` carries it.
 *
 * Provider ids cannot contain `/`, model ids can, so the first separator splits.
 *
 * @param {{provider?: string, model?: string}} [route] - stored route.
 * @returns {string} option value, '' when the route follows the default model.
 */
export function routeValueOf(route) {
  const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
  const model = typeof route?.model === 'string' ? route.model.trim() : ''
  return provider.length > 0 && model.length > 0 ? `${provider}/${model}` : ''
}

/**
 * Decode one `<select>` value back into a route.
 *
 * @param {unknown} value - option value.
 * @returns {{provider: string, model: string}} route, both fields empty for the default model.
 */
export function parseRouteValue(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const at = text.indexOf('/')
  if (at <= 0 || at === text.length - 1) return { provider: '', model: '' }
  return { provider: text.slice(0, at).trim(), model: text.slice(at + 1).trim() }
}
