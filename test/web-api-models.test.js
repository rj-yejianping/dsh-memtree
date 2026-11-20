import test from 'node:test'
import assert from 'node:assert/strict'

import { registerWebApi } from '../src/web-api.js'

/**
 * Register the panel routes against a fake Host connection and return them by
 * path. Only the `models` route is exercised here: it is the one the picker in
 * the settings tab calls, and a wrong path or payload shape would silently leave
 * the tab on the default-model entry.
 */
function routesOf({ listModels } = {}) {
  const handlers = new Map()
  const ctx = {
    inject(_deps, cb) {
      const connection = {
        fetch: {
          register: (route) => {
            handlers.set(route.path, route.fetch)
            return () => {}
          },
        },
      }
      cb({
        get: (key) => (key === 'connection' ? connection : undefined),
        effect: (factory) => {
          factory()
        },
      })
    },
  }
  registerWebApi({
    ctx,
    config: { backgroundModel: {}, autoDream: { model: {} }, search: { embeddings: {} } },
    runtimeForCwd: () => {
      throw new Error('the models route must not need a memory runtime')
    },
    listModels,
  })
  return handlers
}

/** Call one registered route with an empty JSON body. */
async function call(handlers, path) {
  const handler = handlers.get(path)
  assert.equal(typeof handler, 'function', `route ${path} is registered`)
  const response = await handler({ json: async () => ({}) })
  return { status: response.status, body: await response.json() }
}

test('the models route answers the Host model list for the settings picker', async () => {
  const handlers = routesOf({
    listModels: async () => ({
      providers: [{ id: 'h20', name: 'h20', models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] }],
      default: { provider: 'h20', model: 'deepseek-v4.1-flash' },
    }),
  })

  const { status, body } = await call(handlers, '/api/long-term-memory/models')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.value.default, { provider: 'h20', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(body.value.providers[0].models, [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }])
})

test('the models route stays usable when the Host has no llm service', async () => {
  const handlers = routesOf({})

  const { status, body } = await call(handlers, '/api/long-term-memory/models')
  assert.equal(status, 200)
  assert.deepEqual(body.value, { providers: [] })
})

test('the models route reports a listing failure instead of an empty picker', async () => {
  const handlers = routesOf({
    listModels: async () => {
      throw new Error('llm registry unavailable')
    },
  })

  const { status, body } = await call(handlers, '/api/long-term-memory/models')
  assert.equal(status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error.message, /llm registry unavailable/)
})
