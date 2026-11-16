/**
 * Minimal LLM helper shared by the background memory pipeline.
 *
 * The DSH `llm` service is a raw streaming API: adapters emit `text-delta`
 * chunks and terminate with a `finish` chunk whose `reason.kind` is `stop`,
 * `tool-calls`, `max-tokens`, `error`, or `aborted`. Background memory tasks
 * need two things from it: plain text completion and JSON extraction. Both
 * live here so the summary and Auto Dream passes never talk to the service directly.
 *
 * The helper is deliberately dependency-free (no DSH imports) and receives the
 * concrete service through dependency injection, which keeps the plugin
 * testable with a stub stream.
 *
 * @module dsh-long-term-memory/llm
 */

/**
 * Default completion budget for one background memory call.
 *
 * Deliberately not a small number: a reasoning model (`glm-5.3-flash`,
 * `o*`, `deepseek-reasoner`, …) spends output tokens on `reasoning_content`
 * *before* it writes any content, so a 2k budget can be consumed entirely by
 * thinking. The reply then has `finish_reason: length` and empty content, which
 * is exactly the "no JSON object" failure this constant used to cause.
 */
const DEFAULT_MAX_TOKENS = 8192

/** Upper bound for one completion; also the cap for truncation retries. */
const MAX_OUTPUT_TOKENS = 32768

/** How often one call may be retried after it ran out of output budget. */
const TRUNCATION_RETRIES = 2

/** Budget growth factor between truncation retries. */
const RETRY_GROWTH = 4

/**
 * Floor for one request, before the budget allowance is added.
 *
 * A configured timeout has to be able to cover the *generation*, not just the
 * round trip: a 32k budget on a reasoning model can legitimately take minutes,
 * and a 60 s timeout then aborts a request that was working as designed.
 */
const MIN_TIMEOUT_MS = 30000

/** Milliseconds of extra allowance per output token in the budget. */
const MS_PER_OUTPUT_TOKEN = 5

/** Wall-clock ceiling across every attempt of one call, retries included. */
const MAX_TOTAL_MS = 900000

/** Default sampling temperature for background memory calls. */
const DEFAULT_TEMPERATURE = 0.2

/** Maximum length of a model reply echoed in a JSON parse error. */
const MAX_ERROR_SNIPPET = 400

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function snippet(text, limit = MAX_ERROR_SNIPPET) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Normalize a `defaultModel()` result into `{ provider, model }`.
 *
 * The supported contract returns an object, but a `provider/model` string is
 * accepted defensively because both appear in DSH model selectors.
 * @param {unknown} value - raw default selection.
 * @returns {{ provider?: string, model?: string } | undefined}
 */
function normalizeRoute(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return undefined
    const slash = text.indexOf('/')
    if (slash > 0) return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
    return { model: text }
  }
  if (typeof value !== 'object') return undefined
  return {
    provider: isNonEmptyString(value.provider) ? value.provider.trim() : undefined,
    model: isNonEmptyString(value.model) ? value.model.trim() : undefined,
  }
}

/**
 * Drop Markdown code fences while keeping their contents.
 * Fenced JSON is the common reply shape, and the fence markers only interfere
 * with naive parsers; the balanced scanner below can then start at the first
 * real JSON token.
 * @param {string} text - raw model reply.
 * @returns {string} reply without fence markers.
 */
function stripFences(text) {
  return text.replace(/```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/g, '\n').replace(/```/g, '\n')
}

/**
 * Escape raw control characters that appear *inside* JSON string literals.
 *
 * Models routinely emit a literal newline (or tab) inside a JSON string value
 * to keep a Markdown body readable. That is invalid JSON, so JSON.parse rejects
 * the whole reply. The scan is string-aware: control characters outside strings
 * (the structural whitespace between tokens) are left untouched.
 *
 * @param {string} slice - balanced JSON text.
 * @returns {string} text safe for JSON.parse.
 */
function escapeControlCharsInStrings(slice) {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < slice.length; index += 1) {
    const char = slice[index]
    const code = char.charCodeAt(0)
    if (inString) {
      if (escaped) {
        escaped = false
        out += char
        continue
      }
      if (char === '\\') {
        escaped = true
        out += char
        continue
      }
      if (char === '"') {
        inString = false
        out += char
        continue
      }
      if (code < 0x20) {
        if (char === '\n') out += '\\n'
        else if (char === '\r') out += '\\r'
        else if (char === '\t') out += '\\t'
        else out += `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += char
      continue
    }
    if (char === '"') inString = true
    out += char
  }
  return out
}

/**
 * JSON.parse with conservative repair passes.
 *
 * Order matters: control-character escaping is lossless and fixes the most
 * common shape, then trailing commas are removed. Each pass is attempted only
 * when it changes the text.
 *
 * @param {string} slice - balanced JSON text.
 * @returns {unknown} parsed value.
 * @throws {Error} when every repair still fails.
 */
function parseJsonSlice(slice) {
  const candidates = [slice]
  const noControls = escapeControlCharsInStrings(slice)
  if (noControls !== slice) candidates.push(noControls)
  for (const candidate of candidates) {
    const repaired = candidate.replace(/,\s*([}\]])/g, '$1')
    if (repaired !== candidate) candidates.push(repaired)
  }
  let lastError
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`LLM reply contained invalid JSON: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Extract the outermost balanced JSON object or array from a model reply.
 *
 * The scan is string-aware, so braces inside JSON strings (and escaped quotes)
 * never terminate the value early. Prose before and after the value is
 * ignored, whether or not it is fenced.
 *
 * @param {string} text - raw model reply.
 * @returns {unknown} the parsed JSON value.
 * @throws {Error} when no object/array is present or the text is unbalanced.
 */
export function extractJsonValue(text) {
  const source = stripFences(String(text ?? ''))
  let start = -1
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{' || char === '[') {
      start = index
      break
    }
  }
  if (start < 0) {
    throw new Error('LLM reply did not contain a JSON object or array')
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return parseJsonSlice(source.slice(start, index + 1))
    }
  }
  throw new Error('LLM reply contained an unterminated JSON object or array')
}

/**
 * Render the optional `schemaHint` argument into a trailing instruction.
 * @param {unknown} schemaHint - prose hint or JSON schema object.
 * @returns {string} instruction text, possibly empty.
 */
function renderSchemaHint(schemaHint) {
  if (schemaHint === undefined || schemaHint === null) return ''
  if (typeof schemaHint === 'string') {
    const text = schemaHint.trim()
    return text.length > 0 ? text : ''
  }
  try {
    return `Reply with a single JSON value only, matching this schema:\n${JSON.stringify(schemaHint)}`
  } catch {
    return ''
  }
}

/**
 * Thin wrapper around the injected DSH `llm` service.
 */
export class LlmHelper {
  /**
   * @param {object} options - helper dependencies.
   * @param {{ stream: (options: object) => AsyncIterable<object> }} options.llm
   *   the DSH `llm` service (or a compatible stub).
   * @param {() => ({ provider?: string, model?: string } | undefined)} [options.defaultModel]
   *   resolves the current default model route for one-shot calls.
   * @param {{ debug?: Function, warn?: Function, info?: Function }} [options.logger]
   *   Cordis logger; prompt text is never logged above debug level.
   * @param {object} [options.config] - normalized plugin configuration.
   */
  constructor({ llm, defaultModel, logger, config, taskModel, resolveApiKey } = {}) {
    this.llm = llm
    this.defaultModel = defaultModel
    this.logger = logger
    this.config = config
    /** Task-level route override: a value or a getter re-read on every call. */
    this.taskModelSource = taskModel
    this.taskModel = taskModel !== null && typeof taskModel === 'object' ? taskModel : undefined
    /** Optional async resolver for `taskModel.apiKeyEnv`. */
    this.resolveApiKey = typeof resolveApiKey === 'function' ? resolveApiKey : undefined
    /** What the last completion actually did, for diagnostics and error text. */
    this.lastMeta = undefined
  }

  /**
   * Output budget for one call, from the configured route.
   *
   * The route's `maxTokens` wins; otherwise the helper default applies. Callers
   * that do not care about the budget should pass nothing instead of a constant,
   * so the settings panel stays authoritative.
   * @returns {number} token budget.
   */
  maxOutputTokens() {
    const route = this.taskRoute()
    const configured = Number(route?.maxTokens)
    if (Number.isFinite(configured) && configured >= 256) return Math.trunc(configured)
    return DEFAULT_MAX_TOKENS
  }

  /**
   * Per-request timeout, scaled to the output budget.
   *
   * The configured `timeoutMs` is a floor, not the whole story: generating N
   * tokens takes time on its own, so a 32k budget gets `30 s + 5 ms/token`
   * (~190 s) even when the row says 60 s. Without this, a correctly configured
   * large budget is aborted mid-generation as "The operation was aborted due to
   * timeout".
   *
   * @param {number} budget - output token budget for this attempt.
   * @returns {number} timeout in milliseconds.
   */
  effectiveTimeout(budget) {
    const route = this.taskRoute()
    const configured = Number(route?.timeoutMs)
    const base = Number.isFinite(configured) && configured > 0 ? configured : MIN_TIMEOUT_MS
    const allowance = MIN_TIMEOUT_MS + Math.max(0, budget) * MS_PER_OUTPUT_TOKEN
    return Math.max(base, allowance)
  }

  /**
   * The direct OpenAI-compatible endpoint this helper should call, when the task
   * model names its own `baseURL`. Direct routing keeps the background summarizer
   * on a cheap model without registering another Host provider route.
   * @returns {{baseURL: string, model: string, apiKeyEnv: string, timeoutMs: number} | undefined} route.
   */
  taskRoute() {
    const source = this.taskModelSource
    if (typeof source === 'function') {
      try {
        const value = source()
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }
    return this.taskModel
  }

  directRoute() {
    const taskModel = this.taskRoute()
    if (taskModel === undefined || typeof taskModel.baseURL !== 'string' || taskModel.baseURL.length === 0) return undefined
    const model = typeof taskModel.model === 'string' && taskModel.model.length > 0 ? taskModel.model : undefined
    if (model === undefined) return undefined
    return {
      baseURL: taskModel.baseURL.replace(/\/+$/, ''),
      model,
      apiKeyEnv: typeof taskModel.apiKeyEnv === 'string' ? taskModel.apiKeyEnv : '',
      timeoutMs: Number.isFinite(Number(taskModel.timeoutMs)) ? Number(taskModel.timeoutMs) : 60000,
    }
  }

  /**
   * Resolve the credential for a direct route.
   * @param {string} apiKeyEnv - credential reference name.
   * @returns {Promise<string | undefined>} the key, when configured.
   */
  async apiKey(apiKeyEnv) {
    if (this.resolveApiKey !== undefined && apiKeyEnv.length > 0) {
      try {
        const resolved = await this.resolveApiKey(apiKeyEnv)
        if (typeof resolved === 'string' && resolved.length > 0) return resolved
      } catch (error) {
        this.logger?.debug?.(`[long-term-memory] direct model credential failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ambient = apiKeyEnv.length > 0 ? process.env[apiKeyEnv] : undefined
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * Call one OpenAI-compatible chat-completions endpoint directly.
   *
   * A reasoning model may spend the whole output budget on `reasoning_content`
   * and return empty `content` with `finish_reason: length`. That used to
   * surface as "the reply did not contain a JSON object" with an empty excerpt,
   * which reads like a parser bug but is a budget problem. Three behaviors keep
   * it honest:
   *
   * - the budget defaults to the configured route (`maxTokens`), never a
   *   hardcoded constant at the call site;
   * - an empty reply after a truncated generation is retried with a larger
   *   budget, and the retries are bounded;
   * - if the gateway returns the text in `reasoning_content` only, that text is
   *   used rather than discarded.
   *
   * @param {{system?: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal, jsonMode?: boolean}} input - call inputs.
   * @returns {Promise<string>} reply text.
   */
  async completeDirect({ system, prompt, maxTokens, temperature, signal, jsonMode = false }) {
    const route = this.directRoute()
    if (route === undefined) throw new Error('no direct model route configured')
    const key = await this.apiKey(route.apiKeyEnv)
    if (key === undefined) {
      throw new Error(`no credential for background model (${route.apiKeyEnv || 'apiKeyEnv not set'})`)
    }
    const messages = []
    if (typeof system === 'string' && system.length > 0) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })

    let budget = Number.isFinite(Number(maxTokens))
      ? Math.trunc(Number(maxTokens))
      : this.maxOutputTokens()
    this.logger?.debug?.(`[long-term-memory] direct llm model=${route.model} promptChars=${prompt.length} jsonMode=${jsonMode} maxTokens=${budget}`)

    const send = async (body, tokenBudget) => {
      const timeoutMs = this.effectiveTimeout(tokenBudget)
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let response
      try {
        response = await fetch(`${route.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: combined,
        })
      } catch (error) {
        // Distinguish "the caller aborted" from "we ran out of time": the first
        // is normal cancellation, the second is a configuration signal.
        if (signal?.aborted === true) throw new Error('llm request aborted')
        if (timeout.aborted === true) {
          throw new Error(
            `direct model timed out after ${Math.round(timeoutMs / 1000)}s `
            + `(max_tokens=${tokenBudget}, model=${route.model}); `
            + 'lower 最大输出 tokens or raise 超时 (timeoutMs) in the memory settings',
          )
        }
        throw error
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const error = new Error(`direct model HTTP ${response.status}: ${detail.slice(0, 200)}`)
        error.status = response.status
        error.detail = detail
        throw error
      }
      return await response.json()
    }

    let payload
    // Structured-output mode makes small models emit JSON instead of prose.
    // Gateways that do not support it answer 400/422; remember that per helper so
    // the next call skips the retry.
    const request = async (tokenBudget) => {
      const base = { model: route.model, messages, max_tokens: tokenBudget, temperature }
      if (jsonMode && this.jsonModeSupported !== false) {
        try {
          const result = await send({ ...base, response_format: { type: 'json_object' } }, tokenBudget)
          this.jsonModeSupported = true
          return result
        } catch (error) {
          const unsupported = error?.status === 400 || error?.status === 422 || error?.status === 404
          if (!unsupported) throw error
          this.logger?.debug?.(`[long-term-memory] response_format unsupported (${error.status}); retrying without it`)
          this.jsonModeSupported = false
        }
      }
      return await send(base, tokenBudget)
    }

    const readMessage = (value) => {
      const choice = value?.choices?.[0]
      const raw = choice?.message?.content
      const text = typeof raw === 'string'
        ? raw.trim()
        : Array.isArray(raw)
          ? raw.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim()
          : ''
      const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.trim() : ''
      return {
        text,
        reasoning,
        finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
        reasoningTokens: Number(value?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
      }
    }

    // Wall-clock budget for the whole call, retries included: a larger output
    // budget costs real minutes on a reasoning model, so retries must not be
    // able to stretch one background task indefinitely.
    const startedAt = Date.now()
    payload = await request(budget)
    let message = readMessage(payload)

    // Empty content after a truncated generation means every output token went
    // to reasoning: retry with more room instead of failing the whole note.
    let retries = 0
    while (
      message.text.length === 0
      && message.finish === 'length'
      && retries < TRUNCATION_RETRIES
      && budget < MAX_OUTPUT_TOKENS
      && Date.now() - startedAt < MAX_TOTAL_MS
    ) {
      const next = Math.min(budget * RETRY_GROWTH, MAX_OUTPUT_TOKENS)
      if (next <= budget) break
      this.logger?.warn?.(
        `[long-term-memory] background model returned no text (finish_reason=length, reasoning_tokens=${message.reasoningTokens}, max_tokens=${budget}); retrying with max_tokens=${next}`,
      )
      budget = next
      retries += 1
      payload = await request(budget)
      message = readMessage(payload)
    }

    this.lastMeta = { ...message, budget, retries, elapsedMs: Date.now() - startedAt, timeoutMs: this.effectiveTimeout(budget) }

    if (message.text.length > 0) return message.text
    // Some gateways put the whole answer in `reasoning_content` and leave
    // `content` empty. Prefer that text over reporting an empty reply.
    if (message.reasoning.length > 0) {
      this.logger?.warn?.('[long-term-memory] background model returned reasoning text only; using it as the reply')
      return message.reasoning
    }
    throw new Error(
      `background model produced no text (finish_reason=${message.finish || 'unknown'}, `
      + `reasoning_tokens=${message.reasoningTokens}, max_tokens=${budget}). `
      + 'Every output token went to reasoning: raise 最大输出 tokens in the memory settings or use a non-reasoning model.',
    )
  }

  /**
   * Resolve the provider/model route for one call.
   * @param {string | undefined} provider - explicit provider from the caller.
   * @param {string | undefined} model - explicit model from the caller.
   * @returns {{ provider: string, model: string }} the complete route.
   * @throws {Error} when no route can be resolved.
   */
  resolveRoute(provider, model) {
    let fallback
    if (typeof this.defaultModel === 'function') {
      try {
        fallback = normalizeRoute(this.defaultModel())
      } catch (error) {
        this.logger?.debug?.(`[long-term-memory] defaultModel() failed: ${error instanceof Error ? error.message : String(error)}`)
        fallback = undefined
      }
    }
    const route = this.taskRoute()
    const taskProvider = route?.provider
    const taskModel = route?.model
    const resolvedProvider = isNonEmptyString(provider)
      ? provider.trim()
      : isNonEmptyString(taskProvider)
        ? taskProvider.trim()
        : fallback?.provider
    const resolvedModel = isNonEmptyString(model)
      ? model.trim()
      : isNonEmptyString(taskModel)
        ? taskModel.trim()
        : fallback?.model
    if (!isNonEmptyString(resolvedProvider) || !isNonEmptyString(resolvedModel)) {
      throw new Error('no default model available for background memory task')
    }
    return { provider: resolvedProvider, model: resolvedModel }
  }

  /**
   * Run one non-streaming-to-the-caller completion.
   *
   * The caller receives the assembled text; deltas are only an implementation
   * detail. A terminal `error` or `aborted` finish becomes a thrown Error so
   * background callers can log and skip that note instead of writing an empty
   * memory.
   *
   * @param {object} options - completion inputs.
   * @param {string} options.system - system prompt text.
   * @param {string} options.prompt - user prompt text.
   * @param {number} [options.maxTokens] - output budget.
   * @param {number} [options.temperature] - sampling temperature.
   * @param {AbortSignal} [options.signal] - cancellation signal.
   * @param {string} [options.provider] - provider override.
   * @param {string} [options.model] - model override.
   * @returns {Promise<string>} assembled reply text.
   */
  async complete({
    system,
    prompt,
    maxTokens,
    temperature = DEFAULT_TEMPERATURE,
    signal,
    provider,
    model,
    jsonMode = false,
  } = {}) {
    // An explicit budget is passed through verbatim; only a missing/invalid one
    // falls back to the configured route. (The route default itself is floored
    // separately, because a reasoning model cannot answer inside a tiny budget.)
    const budget = Number.isFinite(Number(maxTokens))
      ? Math.trunc(Number(maxTokens))
      : this.maxOutputTokens()
    const direct = this.directRoute()
    if (direct !== undefined) {
      if (signal?.aborted === true) throw new Error('llm request aborted')
      return await this.completeDirect({
        system,
        prompt: typeof prompt === 'string' ? prompt : String(prompt ?? ''),
        maxTokens: budget,
        temperature,
        signal,
        jsonMode,
      })
    }
    if (this.llm === undefined || this.llm === null || typeof this.llm.stream !== 'function') {
      throw new Error('llm service is not available for background memory task')
    }
    const route = this.resolveRoute(provider, model)
    const text = typeof prompt === 'string' ? prompt : String(prompt ?? '')
    const systemText = typeof system === 'string' && system.length > 0 ? system : undefined

    this.logger?.debug?.(
      `[long-term-memory] llm complete provider=${route.provider} model=${route.model} `
      + `promptChars=${text.length} systemChars=${systemText?.length ?? 0} maxTokens=${budget}`,
    )

    const chunks = []
    // A reasoning model streams `reasoning-delta` first; keep that text apart so
    // an empty answer can fall back to it instead of reading as "no reply".
    const reasoningChunks = []
    let finished = false
    for await (const chunk of this.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      system: systemText,
      maxTokens: budget,
      temperature,
      signal,
    })) {
      if (chunk === undefined || chunk === null) continue
      if (chunk.type === 'text-delta') {
        chunks.push(typeof chunk.text === 'string' ? chunk.text : '')
        continue
      }
      if (chunk.type === 'reasoning-delta') {
        reasoningChunks.push(typeof chunk.text === 'string' ? chunk.text : '')
        continue
      }
      if (chunk.type === 'finish') {
        const reason = chunk.reason ?? chunk
        const kind = reason?.kind ?? chunk.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = reason?.failure ?? chunk.failure
          const detail = isNonEmptyString(failure?.message)
            ? failure.message
            : failure?.code ?? 'no failure detail'
          throw new Error(`llm request ${kind}: ${detail}`)
        }
        finished = true
        break
      }
      // block-start / block-end / usage / tool-call-delta are irrelevant to a
      // text-only background task.
    }

    const textOut = chunks.join('').trim()
    this.lastMeta = {
      text: textOut,
      reasoning: reasoningChunks.join('').trim(),
      finish: finished ? 'stop' : '',
      budget,
      retries: 0,
    }
    this.logger?.debug?.(
      `[long-term-memory] llm complete done provider=${route.provider} model=${route.model} `
      + `chars=${textOut.length} finished=${finished}`,
    )
    if (textOut.length > 0) return textOut
    if (this.lastMeta.reasoning.length > 0) {
      this.logger?.warn?.('[long-term-memory] background model returned reasoning text only; using it as the reply')
      return this.lastMeta.reasoning
    }
    throw new Error(
      `background model produced no text (provider=${route.provider} model=${route.model}, maxTokens=${budget}). `
      + 'The model likely spent the whole budget on reasoning: raise 最大输出 tokens or use a non-reasoning model.',
    )
  }

  /**
   * Run one completion and parse the reply as JSON.
   *
   * One repair round is built in: when the first reply is not JSON (a truncated
   * generation, a prose answer, a broken escape), the model is asked once more
   * with the failure quoted back and a strict "JSON only" instruction. That is
   * cheaper and far more reliable than failing the whole note on the first
   * attempt, and the offline JSON repair chain still handles the common syntax
   * defects without a second call.
   *
   * @param {object} options - completion inputs plus an optional schema hint.
   * @param {string} options.system - system prompt text.
   * @param {string} options.prompt - user prompt text.
   * @param {string | object} [options.schemaHint] - trailing JSON contract hint.
   * @param {number} [options.maxTokens] - output budget.
   * @param {number} [options.temperature] - sampling temperature.
   * @param {AbortSignal} [options.signal] - cancellation signal.
   * @param {string} [options.provider] - provider override.
   * @param {string} [options.model] - model override.
   * @returns {Promise<any>} the parsed JSON value.
   */
  async json({
    system,
    prompt,
    schemaHint,
    maxTokens,
    temperature = DEFAULT_TEMPERATURE,
    signal,
    provider,
    model,
  } = {}) {
    const hint = renderSchemaHint(schemaHint)
    const basePrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '')
    const fullPrompt = hint.length > 0 ? `${basePrompt}\n\n${hint}` : basePrompt
    const call = async (text) => this.complete({
      system,
      prompt: text,
      maxTokens,
      temperature,
      signal,
      provider,
      model,
      jsonMode: true,
    })

    const first = await call(fullPrompt)
    try {
      return extractJsonValue(first)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`[long-term-memory] memory LLM reply was not valid JSON (${message}); asking once more with a strict JSON reminder`)
      // The repair prompt repeats the contract and quotes only the head of the
      // failed reply, so the retry stays cheap even for a long transcript.
      const repairPrompt = `${fullPrompt}\n\n你的上一条回复不是合法 JSON（${message}）。上一条回复开头是：${snippet(first, 200)}\n`
        + '请只输出一个 JSON 对象：以 { 开头、以 } 结尾，不要代码块、不要解释、不要思维过程。'
        + '\nReply with one JSON object only: start with { and end with }, no prose, no code fence.'
      const second = await call(repairPrompt)
      try {
        return extractJsonValue(second)
      } catch (retryError) {
        const message2 = retryError instanceof Error ? retryError.message : String(retryError)
        const truncated = this.lastMeta?.finish === 'length'
        const suffix = truncated
          ? `; the reply hit the output budget (max_tokens=${this.lastMeta.budget}), raise 最大输出 tokens`
          : ''
        throw new Error(`${message2}${suffix}; reply started with: ${snippet(second)}`)
      }
    }
  }
}
