import { spawn } from 'node:child_process'
import type { SqliteDatabase } from '../db.js'

/**
 * Single streaming pass over a repository's history, using the git CLI so that rename and
 * binary detection follow git's own semantics (frozen contract, see README "Pinned
 * Interpretations" and the grammar below).
 *
 * The command is:
 *
 *   git -C <repo> log -z --numstat -M50% --no-merges --no-show-signature \
 *     --pretty=format:%x00%H%x00%an%x00%ae%x00%aI%x00%P%x00
 *
 * Output grammar, in bytes (verified empirically against cJSON and synthetic fixtures):
 *
 *   stream   := "" \0 commit+ "\0"
 *   commit   := sha \0 an \0 ae \0 aI \0 parents \0 diff
 *   diff     := ""                       (commit with no changes; no "\n" is emitted)
 *             | "\n" first-entry "\0" entry* "\0"
 *   entry    := add \t del \t path "\0"                (path never empty here)
 *             | add \t del \t "\0" old "\0" new "\0"   (rename: path field empty)
 *   add, del := [0-9]+ | "-"                           ("- -" marks a binary file)
 *
 * Pinned observations:
 *   - -z removes all path quoting, so tabs, spaces and newlines in paths are safe.
 *   - The message is deliberately not requested: %B would absorb the first entry because git
 *     puts no NUL between the format line and the diff section.
 *   - A rename is expressed with an empty path field followed by the old and new paths,
 *     whether it is pure (0\t0), edited, or binary (- -).
 *   - A pure rename and a mode-only change are both 0\t0; only the rename has a split path.
 *   - The root commit has an empty parents field; merge commits are excluded entirely.
 *   - Between commits there are three NULs (entry or format terminator, section terminator,
 *     next commit's leading NUL), so a commit without changes emits padding tokens only and
 *     the next sha can arrive while the parser is still waiting for a diff section.
 */
export const GIT_LOG_ARGS = [
  'log',
  '-z',
  '--numstat',
  '-M50%',
  '--no-merges',
  '--no-show-signature',
  '--pretty=format:%x00%H%x00%an%x00%ae%x00%aI%x00%P%x00',
] as const

const SHA_RE = /^[0-9a-f]{40}$/
const ENTRY_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/

/** Commits per insert transaction. Big enough to amortise, small enough to bound memory. */
const BATCH_COMMITS = 500

export interface ParseResult {
  headSha: string
  commitCount: number
  changeCount: number
}

interface ParsedChange {
  path: string
  oldPath: string | null
  added: number
  deleted: number
  isBinary: boolean
  isRename: boolean
}

interface ParsedCommit {
  sha: string
  authorName: string
  authorEmail: string
  authorDate: string
  parentCount: number
  changes: ParsedChange[]
  /** Per-ancestor line deltas, root included as ''. */
  dirs: Map<string, { added: number; deleted: number }>
}

/** Ancestor directories of a file path: '' for the root, then each ancestor deepest first. */
export function ancestorDirs(path: string): string[] {
  const dirs: string[] = ['']
  const parts = path.split('/')
  for (let i = parts.length - 1; i >= 1; i--) {
    dirs.push(parts.slice(0, i).join('/'))
  }
  return dirs
}

/**
 * Parse the full history reachable from HEAD into `commits`, `file_changes` and `dir_changes`,
 * inserting in batched transactions. Resolves with totals; rejects on any protocol violation
 * or git failure.
 */
export function parseRepo(db: SqliteDatabase, repoId: number, repoDir: string): Promise<ParseResult> {
  const insertCommit = db.prepare(
    'INSERT INTO commits (repo_id, sha, author_name, author_email, author_date, parent_count) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertChange = db.prepare(
    'INSERT INTO file_changes (commit_id, path, old_path, added, deleted, is_binary, is_rename) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertDir = db.prepare(
    'INSERT INTO dir_changes (commit_id, path, added, deleted) VALUES (?, ?, ?, ?)',
  )
  const updateProgress = db.prepare(
    "UPDATE repos SET commit_count = ?, updated_at = datetime('now') WHERE id = ?",
  )

  const batch: ParsedCommit[] = []
  let commitCount = 0
  let changeCount = 0
  let headSha = ''

  const flush = db.transaction(() => {
    for (const commit of batch) {
      const { lastInsertRowid } = insertCommit.run(
        repoId,
        commit.sha,
        commit.authorName,
        commit.authorEmail,
        commit.authorDate,
        commit.parentCount,
      )
      const commitId = Number(lastInsertRowid)
      for (const change of commit.changes) {
        insertChange.run(
          commitId,
          change.path,
          change.oldPath,
          change.added,
          change.deleted,
          change.isBinary ? 1 : 0,
          change.isRename ? 1 : 0,
        )
      }
      for (const [dir, delta] of commit.dirs) {
        insertDir.run(commitId, dir, delta.added, delta.deleted)
      }
    }
    updateProgress.run(commitCount, repoId)
    batch.length = 0
  })

  let current: ParsedCommit | null = null
  let pendingRename: { added: number; deleted: number; isBinary: boolean } | null = null
  let pendingRenameOld = ''
  type State = 'sha' | 'author' | 'email' | 'date' | 'parents' | 'sep' | 'entries' | 'renameOld' | 'renameNew'
  let state: State = 'sha'

  function recordChange(change: ParsedChange): void {
    if (!current) throw new Error('parser state error: change outside a commit')
    current.changes.push(change)
    if (change.isBinary) return
    for (const dir of ancestorDirs(change.path)) {
      const delta = current.dirs.get(dir) ?? { added: 0, deleted: 0 }
      delta.added += change.added
      delta.deleted += change.deleted
      current.dirs.set(dir, delta)
    }
  }

  function startCommit(sha: string): void {
    headSha ||= sha
    current = { sha, authorName: '', authorEmail: '', authorDate: '', parentCount: 0, changes: [], dirs: new Map() }
    state = 'author'
  }

  function endCommit(): void {
    if (!current) return
    batch.push(current)
    commitCount++
    changeCount += current.changes.length
    current = null
    if (batch.length >= BATCH_COMMITS) flush()
  }

  function fail(token: string): never {
    const where = current ? ` after commit ${current.sha}` : ''
    throw new Error(`unexpected git log output${where}: ${JSON.stringify(token.slice(0, 120))}`)
  }

  function feed(token: string): void {
    switch (state) {
      case 'sha':
        if (token === '') return
        if (!SHA_RE.test(token)) fail(token)
        startCommit(token)
        return
      case 'author':
        current!.authorName = token
        state = 'email'
        return
      case 'email':
        current!.authorEmail = token
        state = 'date'
        return
      case 'date':
        current!.authorDate = token
        state = 'parents'
        return
      case 'parents':
        current!.parentCount = token === '' ? 0 : token.split(' ').length
        state = 'sep'
        return
      case 'sep':
        // A commit with changes emits "\n" followed by its first entry in the same token; a
        // commit without changes emits padding tokens only, so the next sha may arrive here.
        if (token === '') return
        if (token.startsWith('\n')) {
          state = 'entries'
          if (token.length > 1 && !addEntry(token.slice(1))) fail(token)
          return
        }
        if (SHA_RE.test(token)) {
          endCommit()
          startCommit(token)
          return
        }
        fail(token)
        return
      case 'entries':
        if (token === '') return
        if (SHA_RE.test(token)) {
          endCommit()
          startCommit(token)
          return
        }
        if (!addEntry(token)) fail(token)
        return
      case 'renameOld':
        // First rename path token: the old path.
        pendingRenameOld = token
        state = 'renameNew'
        return
      case 'renameNew':
        // Second rename path token: the new path, which is the file's identity from here on.
        if (!pendingRename) throw new Error('parser state error: rename without a pending entry')
        recordChange({
          path: token,
          oldPath: pendingRenameOld,
          added: pendingRename.added,
          deleted: pendingRename.deleted,
          isBinary: pendingRename.isBinary,
          isRename: true,
        })
        pendingRename = null
        pendingRenameOld = ''
        state = 'entries'
        return
    }
  }

  function addEntry(token: string): boolean {
    const match = ENTRY_RE.exec(token)
    if (!match) return false
    const [, addedText, deletedText, path] = match
    const isBinary = addedText === '-'
    const added = isBinary ? 0 : Number(addedText)
    const deleted = isBinary ? 0 : Number(deletedText)
    if (path === '') {
      // Rename: the old and new paths arrive as the next two tokens.
      pendingRename = { added, deleted, isBinary }
      state = 'renameOld'
      return true
    }
    recordChange({ path, oldPath: null, added, deleted, isBinary, isRename: false })
    return true
  }

  return new Promise<ParseResult>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', repoDir, ...GIT_LOG_ARGS])
    let buffer = ''
    let stderr = ''
    let settled = false
    let streamEnded = false

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else resolvePromise({ headSha, commitCount, changeCount })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const tokens = buffer.split('\0')
      buffer = tokens.pop() ?? ''
      for (const token of tokens) feed(token)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8_000) stderr += chunk
    })

    child.on('error', (error) => finish(new Error(`failed to run git: ${error.message}`)))

    child.stdout.on('end', () => {
      streamEnded = true
      if (buffer !== '') {
        finish(new Error(`truncated git log output: ${JSON.stringify(buffer.slice(0, 120))}`))
        return
      }
      try {
        if (pendingRename) throw new Error('truncated git log output: rename without a new path')
        endCommit()
        flush()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })

    child.on('close', (code) => {
      if (!streamEnded) return finish(new Error(`git log produced no parseable output (exit ${code})`))
      if (code !== 0) return finish(new Error(`git log exited with code ${code}: ${stderr.trim().slice(0, 500)}`))
      finish()
    })
  })
}
