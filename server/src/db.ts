import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

/**
 * Repository root, derived from this module's location so that the data directory does not
 * depend on the working directory (npm runs workspace scripts from the package directory).
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DEFAULT_FILE = join(REPO_ROOT, 'data', 'rat.sqlite')

const SCHEMA_VERSION = 1

/**
 * Derived from the constructor rather than named directly, because better-sqlite3 ships as
 * `export =` and the instance interface lives inside its namespace.
 */
export type SqliteDatabase = InstanceType<typeof Database>

/**
 * Open a database, creating the file and schema when needed.
 * Pass ':memory:' for tests.
 */
export function openDatabase(file: string = process.env.RAT_DB ?? DEFAULT_FILE): SqliteDatabase {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })

  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/**
 * Schema bootstrap. Only the bookkeeping table exists at this stage: the ingestion and
 * metric tables are shaped by the correctness contract, so they land with their own stages
 * rather than being guessed at here.
 */
function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION))
}
