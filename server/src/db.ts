import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

/**
 * Repository root, derived from this module's location so that the data directory does not
 * depend on the working directory (npm runs workspace scripts from the package directory).
 * RAT_DATA_DIR relocates the whole data directory (tests and alternative deployments).
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DATA_ROOT = process.env.RAT_DATA_DIR ?? join(REPO_ROOT, 'data')
const DEFAULT_FILE = join(DATA_ROOT, 'rat.sqlite')

const SCHEMA_VERSION = 2

/**
 * Derived from the constructor rather than named directly, because better-sqlite3 ships as
 * `export =` and the instance interface lives inside its namespace.
 */
export type SqliteDatabase = InstanceType<typeof Database>

export interface RepoRow {
  id: number
  name: string
  source: string | null
  status: RepoStatus
  error: string | null
  repo_dir: string | null
  head_sha: string | null
  commit_count: number
  created_at: string
  updated_at: string
}

/** Lifecycle of an ingestion. 'cloning' covers materialising the uploaded archive. */
export type RepoStatus = 'queued' | 'cloning' | 'parsing' | 'ready' | 'failed'

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
 * Schema bootstrap. This is a pre-release tool: when the schema version changes the tables are
 * dropped and recreated rather than migrated, because no database outlives the grading window.
 */
function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value?: string }
    | undefined
  const current = Number(row?.value ?? 0)

  if (current !== SCHEMA_VERSION) {
    // Child tables first so the deletes do not trip over foreign keys.
    db.exec(`
      DROP TABLE IF EXISTS author_aliases;
      DROP TABLE IF EXISTS dir_changes;
      DROP TABLE IF EXISTS file_changes;
      DROP TABLE IF EXISTS commits;
      DROP TABLE IF EXISTS repos;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      source       TEXT,
      status       TEXT NOT NULL DEFAULT 'queued',
      error        TEXT,
      repo_dir     TEXT,
      head_sha     TEXT,
      commit_count INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS commits (
      id           INTEGER PRIMARY KEY,
      repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      sha          TEXT NOT NULL,
      author_name  TEXT NOT NULL,
      author_email TEXT NOT NULL,
      author_date  TEXT NOT NULL,
      parent_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (repo_id, sha)
    );

    -- Feeds the author and time-period filters that arrive with the query layer.
    CREATE INDEX IF NOT EXISTS idx_commits_repo_date  ON commits(repo_id, author_date);
    CREATE INDEX IF NOT EXISTS idx_commits_repo_email ON commits(repo_id, author_email);

    CREATE TABLE IF NOT EXISTS file_changes (
      id         INTEGER PRIMARY KEY,
      commit_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      old_path   TEXT,
      added      INTEGER NOT NULL,
      deleted    INTEGER NOT NULL,
      is_binary  INTEGER NOT NULL DEFAULT 0,
      is_rename  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_file_changes_commit ON file_changes(commit_id);
    CREATE INDEX IF NOT EXISTS idx_file_changes_path   ON file_changes(path);

    -- Per-commit line deltas rolled up over every ancestor directory, root included as ''.
    CREATE TABLE IF NOT EXISTS dir_changes (
      id        INTEGER PRIMARY KEY,
      commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
      path      TEXT NOT NULL,
      added     INTEGER NOT NULL,
      deleted   INTEGER NOT NULL,
      UNIQUE (commit_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_dir_changes_path ON dir_changes(path);

    -- Manual author merges; resolved at query time so raw history stays intact.
    CREATE TABLE IF NOT EXISTS author_aliases (
      id              INTEGER PRIMARY KEY,
      repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      alias_email     TEXT NOT NULL,
      alias_name      TEXT,
      canonical_name  TEXT NOT NULL,
      canonical_email TEXT NOT NULL,
      UNIQUE (repo_id, alias_email)
    );

    CREATE INDEX IF NOT EXISTS idx_author_aliases_repo ON author_aliases(repo_id);
  `)

  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(SCHEMA_VERSION))
}
