import { afterAll, describe, expect, test } from 'vitest'
import { openDatabase, type SqliteDatabase } from '../src/db.js'
import { parseRepo } from '../src/git/parse.js'
import { DEFAULT_FILE_LIMIT, fileMetrics } from '../src/metrics/engine.js'
import { createFixtureRepo, type FixtureRepo } from './fixtures.js'

const disposers: Array<() => void> = []

afterAll(() => {
  for (const dispose of disposers.reverse()) dispose()
})

/** Create a fixture repository that is cleaned up when the suite finishes. */
function fixture(): FixtureRepo {
  const repo = createFixtureRepo()
  disposers.push(() => repo.dispose())
  return repo
}

interface ParsedFixture {
  db: SqliteDatabase
  repoId: number
  headSha: string
  commitCount: number
  changeCount: number
}

/** Parse a fixture repository into a fresh in-memory database. */
async function parseFixture(repo: FixtureRepo): Promise<ParsedFixture> {
  const db = openDatabase(':memory:')
  disposers.push(() => db.close())
  const { lastInsertRowid } = db
    .prepare("INSERT INTO repos (name, source, status) VALUES ('fixture', 'fixture.zip', 'parsing')")
    .run()
  const repoId = Number(lastInsertRowid)
  const result = await parseRepo(db, repoId, repo.dir)
  return { db, repoId, ...result }
}

describe('file metrics over fixture repositories', () => {
  test('additions, edits and deletions accumulate per path as l+, l-, delta and lambda', async () => {
    const repo = fixture()
    repo.write('a.txt', '1\n2\n3\n')
    repo.write('b.txt', 'x\n')
    const rootSha = repo.commit('seed')

    repo.write('a.txt', '1\n2\n3\n4\n')
    repo.write('b.txt', 'y\n')
    repo.commit('edit both files')

    repo.remove('a.txt')
    repo.commit('drop a.txt')

    const { db, repoId, headSha, commitCount, changeCount } = await parseFixture(repo)

    expect(headSha).toBe(repo.head())
    expect(commitCount).toBe(3)
    expect(changeCount).toBe(5)

    const root = db
      .prepare('SELECT parent_count FROM commits WHERE repo_id = ? AND sha = ?')
      .get(repoId, rootSha)
    expect(root).toEqual({ parent_count: 0 })

    const result = fileMetrics(db, repoId, {})
    expect(result.files).toEqual([
      { path: 'a.txt', lPlus: 4, lMinus: 4, delta: 0, lambda: 8, changes: 3 },
      { path: 'b.txt', lPlus: 2, lMinus: 1, delta: 1, lambda: 3, changes: 2 },
    ])
    expect(result.totals).toEqual({ lPlus: 6, lMinus: 5, delta: 1, lambda: 11, paths: 2 })
    expect(result.truncated).toBe(false)
  })

  test('binary files are flagged and contribute no line counts', async () => {
    const repo = fixture()
    repo.writeBinary('assets/logo.bin', Buffer.from([0x00, 0x01, 0xff, 0x00, 0x02]))
    repo.write('notes.txt', 'hello\n')
    repo.commit('seed')
    repo.writeBinary('assets/logo.bin', Buffer.from([0x00, 0x03, 0xff, 0x00, 0x04, 0x05]))
    repo.commit('update binary')

    const { db, repoId } = await parseFixture(repo)

    const binaryRows = db
      .prepare(
        `SELECT fc.path AS path, fc.added AS added, fc.deleted AS deleted, fc.is_binary AS is_binary
         FROM file_changes fc JOIN commits c ON c.id = fc.commit_id
         WHERE c.repo_id = ? AND fc.path = 'assets/logo.bin'
         ORDER BY fc.id`,
      )
      .all(repoId)
    expect(binaryRows).toEqual([
      { path: 'assets/logo.bin', added: 0, deleted: 0, is_binary: 1 },
      { path: 'assets/logo.bin', added: 0, deleted: 0, is_binary: 1 },
    ])

    const result = fileMetrics(db, repoId, {})
    expect(result.files).toEqual([
      { path: 'notes.txt', lPlus: 1, lMinus: 0, delta: 1, lambda: 1, changes: 1 },
      { path: 'assets/logo.bin', lPlus: 0, lMinus: 0, delta: 0, lambda: 0, changes: 2 },
    ])
    expect(result.totals).toEqual({ lPlus: 1, lMinus: 0, delta: 1, lambda: 1, paths: 2 })
  })

  test('a pure rename is a zero-delta record attributed to the new path', async () => {
    const repo = fixture()
    repo.write('src/old_name.txt', 'alpha\nbeta\n')
    repo.commit('seed')
    repo.move('src/old_name.txt', 'src/new_name.txt')
    const renameSha = repo.commit('rename file')
    repo.append('src/new_name.txt', 'gamma\n')
    repo.commit('extend renamed file')

    const { db, repoId } = await parseFixture(repo)

    const renameRow = db
      .prepare(
        `SELECT fc.path AS path, fc.old_path AS old_path, fc.added AS added, fc.deleted AS deleted,
                fc.is_rename AS is_rename
         FROM file_changes fc JOIN commits c ON c.id = fc.commit_id
         WHERE c.repo_id = ? AND c.sha = ?`,
      )
      .get(repoId, renameSha)
    expect(renameRow).toEqual({
      path: 'src/new_name.txt',
      old_path: 'src/old_name.txt',
      added: 0,
      deleted: 0,
      is_rename: 1,
    })

    // History before the rename stays under the old path; M1 does not merge the two rows.
    const result = fileMetrics(db, repoId, {})
    expect(result.files).toEqual([
      { path: 'src/old_name.txt', lPlus: 2, lMinus: 0, delta: 2, lambda: 2, changes: 1 },
      { path: 'src/new_name.txt', lPlus: 1, lMinus: 0, delta: 1, lambda: 1, changes: 2 },
    ])
  })

  test('merge commits are excluded so their diffs are never double counted', async () => {
    const repo = fixture()
    repo.write('main.txt', 'm\n')
    repo.commit('main seed')
    repo.git(['checkout', '-q', '-b', 'feature'])
    repo.write('feature.txt', 'f\n')
    repo.commit('feature work')
    repo.git(['checkout', '-q', 'main'])
    repo.write('other.txt', 'o\n')
    repo.commit('main work')
    repo.git(['merge', '--no-ff', '-q', '-m', 'merge feature', 'feature'])
    const mergeSha = repo.head()

    const { db, repoId, commitCount } = await parseFixture(repo)

    expect(commitCount).toBe(3)
    const shas = db.prepare('SELECT sha FROM commits WHERE repo_id = ?').all(repoId) as Array<{ sha: string }>
    expect(shas.map((row) => row.sha)).not.toContain(mergeSha)

    const result = fileMetrics(db, repoId, {})
    expect(result.totals).toEqual({ lPlus: 3, lMinus: 0, delta: 3, lambda: 3, paths: 3 })
    expect(result.files.find((file) => file.path === 'feature.txt')).toEqual({
      path: 'feature.txt',
      lPlus: 1,
      lMinus: 0,
      delta: 1,
      lambda: 1,
      changes: 1,
    })
  })

  test('an empty commit between changes is stored without change records', async () => {
    const repo = fixture()
    repo.write('a.txt', '1\n')
    repo.commit('seed')
    const emptySha = repo.commit('nothing to see here')
    repo.append('a.txt', '2\n')
    repo.commit('carry on')

    const { db, repoId, commitCount, changeCount } = await parseFixture(repo)

    expect(commitCount).toBe(3)
    expect(changeCount).toBe(2)

    const emptyCommit = db
      .prepare('SELECT id FROM commits WHERE repo_id = ? AND sha = ?')
      .get(repoId, emptySha) as { id: number }
    const emptyChanges = db
      .prepare('SELECT COUNT(*) AS count FROM file_changes WHERE commit_id = ?')
      .get(emptyCommit.id)
    expect(emptyChanges).toEqual({ count: 0 })

    const result = fileMetrics(db, repoId, {})
    expect(result.files).toEqual([{ path: 'a.txt', lPlus: 2, lMinus: 0, delta: 2, lambda: 2, changes: 2 }])
  })

  test('a mode-only change is a zero-delta record, not a rename', async () => {
    const repo = fixture()
    repo.write('run.sh', 'echo hi\n')
    repo.commit('seed')
    repo.chmod('run.sh', 0o755)
    const modeSha = repo.commit('make executable')

    const { db, repoId } = await parseFixture(repo)

    const modeRow = db
      .prepare(
        `SELECT fc.path AS path, fc.old_path AS old_path, fc.added AS added, fc.deleted AS deleted,
                fc.is_rename AS is_rename, fc.is_binary AS is_binary
         FROM file_changes fc JOIN commits c ON c.id = fc.commit_id
         WHERE c.repo_id = ? AND c.sha = ?`,
      )
      .get(repoId, modeSha)
    expect(modeRow).toEqual({
      path: 'run.sh',
      old_path: null,
      added: 0,
      deleted: 0,
      is_rename: 0,
      is_binary: 0,
    })

    const result = fileMetrics(db, repoId, {})
    expect(result.files).toEqual([{ path: 'run.sh', lPlus: 1, lMinus: 0, delta: 1, lambda: 1, changes: 2 }])
  })

  test('directory deltas roll up over every ancestor with the root as the empty path', async () => {
    const repo = fixture()
    repo.write('README.md', 'readme\n')
    repo.write('src/one.txt', '1\n2\n')
    repo.write('src/deep/two.txt', 'x\n')
    repo.writeBinary('src/pic.bin', Buffer.from([0x00, 0xff, 0x00]))
    const seedSha = repo.commit('seed')
    repo.append('src/deep/two.txt', 'y\n')
    const deepSha = repo.commit('deep change')

    const { db, repoId } = await parseFixture(repo)

    const dirRows = (sha: string) =>
      db
        .prepare(
          `SELECT dc.path AS path, dc.added AS added, dc.deleted AS deleted
           FROM dir_changes dc JOIN commits c ON c.id = dc.commit_id
           WHERE c.repo_id = ? AND c.sha = ? ORDER BY dc.path`,
        )
        .all(repoId, sha)

    // The binary file lives under src but must not contribute to any directory.
    expect(dirRows(seedSha)).toEqual([
      { path: '', added: 4, deleted: 0 },
      { path: 'src', added: 3, deleted: 0 },
      { path: 'src/deep', added: 1, deleted: 0 },
    ])
    expect(dirRows(deepSha)).toEqual([
      { path: '', added: 1, deleted: 0 },
      { path: 'src', added: 1, deleted: 0 },
      { path: 'src/deep', added: 1, deleted: 0 },
    ])
  })

  test('the path filter is a literal substring match and the limit reports truncation', async () => {
    const repo = fixture()
    repo.write('src/a_b.txt', '1\n')
    repo.write('src/axb.txt', '1\n')
    repo.write('weird%file.txt', '1\n')
    repo.commit('seed')

    const { db, repoId } = await parseFixture(repo)

    const directory = fileMetrics(db, repoId, { path: 'src/' })
    expect(directory.files.map((file) => file.path)).toEqual(['src/a_b.txt', 'src/axb.txt'])

    // '_' must match literally: an escaped LIKE would otherwise treat it as "any character".
    const underscore = fileMetrics(db, repoId, { path: 'a_b' })
    expect(underscore.files.map((file) => file.path)).toEqual(['src/a_b.txt'])

    // '%' must also match literally: unescaped it would select every path.
    const percent = fileMetrics(db, repoId, { path: '%' })
    expect(percent.files.map((file) => file.path)).toEqual(['weird%file.txt'])
    expect(percent.totals.paths).toBe(1)

    const limited = fileMetrics(db, repoId, {}, 2)
    expect(limited.files).toHaveLength(2)
    expect(limited.truncated).toBe(true)
    expect(limited.totals.paths).toBe(3)

    const full = fileMetrics(db, repoId, {}, DEFAULT_FILE_LIMIT)
    expect(full.truncated).toBe(false)
    expect(full.files.map((file) => file.path)).toEqual(['src/a_b.txt', 'src/axb.txt', 'weird%file.txt'])
  })
})
