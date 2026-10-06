import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express } from 'express'
import type { SqliteDatabase } from './db.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB_DIST = join(REPO_ROOT, 'web', 'dist')

export interface AppOptions {
  db?: SqliteDatabase
}

/**
 * Build the Express application. Kept separate from process startup so tests can mount it
 * on an ephemeral port.
 */
export function createApp({ db }: AppOptions = {}): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // Health is the only endpoint at scaffold time. It also proves the path the Vite dev
  // proxy forwards to.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'sdp-rat',
      storage: db ? 'ready' : 'unavailable',
      time: new Date().toISOString(),
    })
  })

  // Unknown API routes must return JSON rather than falling through to the dashboard HTML.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl })
  })

  // Production run: serve the built dashboard and let the client router own unknown paths.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST))
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      res.sendFile(join(WEB_DIST, 'index.html'))
    })
  }

  return app
}
