// server/compat/index.test.ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDb } from '../store'
import { makeProvider } from '../providers/index'
import { registerCompatApi } from './index'

describe('registerCompatApi', () => {
  it('mounts both /v1/models (OpenAI) and /v1/messages (Anthropic)', async () => {
    const app = Fastify()
    registerCompatApi(app, { db: openDb(':memory:'), makeProvider })
    expect((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(200)
    // /v1/messages with a bad body still proves the route is mounted (400, not 404)
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: {} })
    expect(res.statusCode).toBe(400)
  })
})
