import test from 'node:test'
import assert from 'node:assert/strict'

import { applyOverrides, mergedModel, resolveConfig } from '../src/config.js'
import { LlmHelper } from '../src/llm.js'

/** A config with a deployment-level background endpoint, as a profile can set. */
function baseConfig() {
  return {
    backgroundModel: {
      baseURL: 'https://gateway.example/v1',
      provider: '',
      model: 'shared-model',
      apiKeyEnv: 'GATEWAY_KEY',
      maxTokens: 8192,
      temperature: 0.2,
      timeoutMs: 240000,
    },
    autoDream: { model: { baseURL: '', provider: '', model: '' } },
    search: { embeddings: {} },
  }
}

test('mergedModel inherits the shared endpoint when the panel stored no route', () => {
  const config = baseConfig()
  applyOverrides(config, { dream: { model: 'small-model' } })

  const route = mergedModel(config, 'autoDream')
  assert.equal(route.baseURL, 'https://gateway.example/v1')
  assert.equal(route.model, 'small-model')
  assert.equal(route.apiKeyEnv, 'GATEWAY_KEY')
})

test('mergedModel drops the endpoint when the panel chose the default model', () => {
  const config = baseConfig()
  applyOverrides(config, { dream: { route: 'default', baseURL: '', provider: '', model: '' } })

  const route = mergedModel(config, 'autoDream')
  assert.equal(route.baseURL, '')
  assert.equal(route.provider, '')
  assert.equal(route.model, '')
  assert.equal(route.apiKeyEnv, '')
  // Output settings still come from the shared row.
  assert.equal(route.maxTokens, 8192)
})

test('mergedModel uses a Host route without any private endpoint', () => {
  const config = baseConfig()
  applyOverrides(config, { dream: { route: 'host', baseURL: '', provider: 'h20', model: 'deepseek-v4.1-flash' } })

  const route = mergedModel(config, 'autoDream')
  assert.equal(route.baseURL, '')
  assert.equal(route.apiKeyEnv, '')
  assert.equal(route.provider, 'h20')
  assert.equal(route.model, 'deepseek-v4.1-flash')
})

test('mergedModel keeps a custom endpoint configured from the panel', () => {
  const config = baseConfig()
  applyOverrides(config, {
    dream: { route: 'custom', baseURL: 'https://uniapi.example/v1/', provider: '', model: 'qwen3.7-flash' },
  })

  const route = mergedModel(config, 'autoDream')
  assert.equal(route.baseURL, 'https://uniapi.example/v1')
  assert.equal(route.model, 'qwen3.7-flash')
})

test('applyOverrides stores the routed model and ignores an unknown route label', () => {
  const config = baseConfig()
  applyOverrides(config, { dream: { route: 'host', provider: 'h20', model: 'm1' } })
  assert.equal(config.autoDream.model.route, 'host')
  assert.equal(config.autoDream.model.provider, 'h20')

  applyOverrides(config, { dream: { route: 'nonsense' } })
  assert.equal(config.autoDream.model.route, 'host')
})

test('a saved default route makes the dream helper follow the Agent default model', () => {
  const config = resolveConfig({ backgroundModel: { baseURL: 'https://gateway.example/v1', model: 'shared-model' } })
  applyOverrides(config, { dream: { route: 'default', provider: '', model: '', baseURL: '' } })
  const helper = new LlmHelper({
    llm: { stream: async function* empty() {} },
    defaultModel: () => ({ provider: 'h20', model: 'deepseek-v4.1-flash' }),
    taskModel: () => mergedModel(config, 'autoDream'),
  })
  assert.equal(helper.directRoute(), undefined, 'the Agent default model must not be called as a private endpoint')
  assert.deepEqual(helper.resolveRoute(), { provider: 'h20', model: 'deepseek-v4.1-flash' })
})

test('a saved host route reaches the Host provider without an endpoint', () => {
  const config = resolveConfig({ backgroundModel: { baseURL: 'https://gateway.example/v1', model: 'shared-model' } })
  applyOverrides(config, { dream: { route: 'host', provider: 'h20', model: 'deepseek-v4.1-flash' } })
  const helper = new LlmHelper({
    llm: { stream: async function* empty() {} },
    defaultModel: () => ({ provider: 'other', model: 'other-model' }),
    taskModel: () => mergedModel(config, 'autoDream'),
  })
  assert.equal(helper.directRoute(), undefined)
  assert.deepEqual(helper.resolveRoute(), { provider: 'h20', model: 'deepseek-v4.1-flash' })
})
