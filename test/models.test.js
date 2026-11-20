import test from 'node:test'
import assert from 'node:assert/strict'

import { listModelChoices, parseRouteValue, routeValueOf } from '../src/models.js'

/** A Host `llm` stub: provider routes plus what each one advertises. */
function llmStub(routes) {
  return {
    listProviders: () => routes.map((route) => ({ id: route.id, name: route.name ?? route.id })),
    listModels: async (id) => {
      const route = routes.find((entry) => entry.id === id)
      if (route?.throws === true) throw new Error('adapter refused')
      return (route?.models ?? []).map((model) => (typeof model === 'string' ? { id: model, name: model } : model))
    },
  }
}

test('listModelChoices lists every routed provider with its advertised models', async () => {
  const choices = await listModelChoices({
    llm: llmStub([
      { id: 'h20', name: 'H20 网关', models: ['deepseek-v4.1-flash', { id: 'Qwen3.8-27B', name: 'Qwen 3.8' }] },
      { id: 'uniapi', models: [{ id: 'gpt-6.1-terra', name: 'GPT 6.1' }] },
    ]),
  })

  assert.deepEqual(choices.providers, [
    { id: 'h20', name: 'H20 网关', models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }, { id: 'Qwen3.8-27B', name: 'Qwen 3.8' }] },
    { id: 'uniapi', name: 'uniapi', models: [{ id: 'gpt-6.1-terra', name: 'GPT 6.1' }] },
  ])
  assert.equal(choices.default, undefined)
})

test('listModelChoices keeps a provider whose catalog call throws', async () => {
  const choices = await listModelChoices({
    llm: llmStub([
      { id: 'h20', models: ['deepseek-v4.1-flash'] },
      { id: 'broken', throws: true },
    ]),
  })

  assert.deepEqual(choices.providers.map((provider) => provider.id), ['h20', 'broken'])
  assert.deepEqual(choices.providers[1].models, [])
})

test('listModelChoices de-duplicates repeated model ids and drops nameless entries', async () => {
  const choices = await listModelChoices({
    llm: llmStub([{ id: 'h20', models: [{ id: 'same' }, { id: 'same', name: 'Same' }, ''].map((model) => model) }]),
  })

  assert.deepEqual(choices.providers[0].models, [{ id: 'same', name: 'same' }])
})

test('listModelChoices still answers the default model without an llm service', async () => {
  const choices = await listModelChoices({
    llm: undefined,
    defaultSelection: () => ({ provider: 'h20', model: 'deepseek-v4.1-flash' }),
  })

  assert.deepEqual(choices, { providers: [], default: { provider: 'h20', model: 'deepseek-v4.1-flash' } })
})

test('listModelChoices ignores an unusable default selection', async () => {
  const choices = await listModelChoices({
    llm: undefined,
    defaultSelection: () => ({ provider: 'h20' }),
  })
  assert.equal(choices.default, undefined)

  const throwing = await listModelChoices({
    llm: undefined,
    defaultSelection: () => {
      throw new Error('service gone')
    },
  })
  assert.deepEqual(throwing.providers, [])
})

test('routeValueOf and parseRouteValue round-trip provider and model ids', () => {
  assert.equal(routeValueOf({ provider: 'h20', model: 'deepseek-v4.1-flash' }), 'h20/deepseek-v4.1-flash')
  assert.deepEqual(parseRouteValue('h20/deepseek-v4.1-flash'), { provider: 'h20', model: 'deepseek-v4.1-flash' })

  // Model ids may contain a slash; only the first one separates the provider.
  assert.deepEqual(parseRouteValue('openrouter/meta-llama/llama-3'), { provider: 'openrouter', model: 'meta-llama/llama-3' })
})

test('routeValueOf and parseRouteValue treat the default model as empty', () => {
  assert.equal(routeValueOf({}), '')
  assert.equal(routeValueOf({ provider: 'h20' }), '')
  assert.deepEqual(parseRouteValue(''), { provider: '', model: '' })
  assert.deepEqual(parseRouteValue('h20'), { provider: '', model: '' })
  assert.deepEqual(parseRouteValue(undefined), { provider: '', model: '' })
})
