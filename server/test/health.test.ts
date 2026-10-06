import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { openDatabase, type SqliteDatabase } from '../src/db.js'

let db: SqliteDatabase
let server: Server
let baseUrl: string

beforeAll(async () => {
  db = openDatabase(':memory:')
  const app = createApp({ db })
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
})

describe('scaffold smoke tests', () => {
  test('GET /api/health reports the storage layer as ready', async () => {
    const response = await fetch(`${baseUrl}/api/health`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', storage: 'ready' })
  })

  test('unknown API routes return JSON, not the dashboard HTML', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  test('a fresh database carries the schema version', () => {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(row.value).toBe('2')
  })
})
