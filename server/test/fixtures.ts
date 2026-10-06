import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Fixture repositories live under server/data (git-ignored) rather than the system temp
 * directory, which keeps them inside the project workspace even where /tmp is read-only.
 * RAT_TEST_TMP overrides the location.
 */
const FIXTURE_ROOT = process.env.RAT_TEST_TMP?.trim() || join(SERVER_ROOT, 'data', 'test-tmp')

export interface Author {
  name: string
  email: string
}

export const DEFAULT_AUTHOR: Author = { name: 'Ada Lovelace', email: 'ada@example.com' }

function run(file: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  })
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

export interface FixtureRepo {
  /** Absolute path of the working tree (the directory holding .git). */
  readonly dir: string
  write(relativePath: string, contents: string): void
  writeBinary(relativePath: string, contents: Buffer): void
  append(relativePath: string, contents: string): void
  remove(relativePath: string): void
  chmod(relativePath: string, mode: number): void
  /** `git mv`: the parser must report pure renames with zero added/deleted lines. */
  move(from: string, to: string): void
  /** Raw git escape hatch for branch/merge setup; always runs with `-C <dir>`. */
  git(args: string[]): string
  /** Stage everything and commit; timestamps are deterministic so ordering never flaps. */
  commit(message: string, options?: { author?: Author }): string
  head(): string
  dispose(): void
}

/**
 * Create a throwaway git repository. Commits are stamped with fixed dates (2024-01-<n>) and
 * a fixed identity so parsed author/date values are assertable.
 */
export function createFixtureRepo(): FixtureRepo {
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'repo-'))
  run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  // Local identity (and signing off) so fixtures never depend on the machine's git config.
  run('git', ['-C', dir, 'config', 'user.name', DEFAULT_AUTHOR.name])
  run('git', ['-C', dir, 'config', 'user.email', DEFAULT_AUTHOR.email])
  run('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  let step = 0

  const commitEnv = (author: Author): Record<string, string> => {
    step += 1
    const date = new Date(Date.UTC(2024, 0, step, 12, 0, 0)).toISOString()
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: date,
    }
  }

  return {
    dir,
    write(relativePath, contents) {
      const target = join(dir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents, 'utf8')
    },
    writeBinary(relativePath, contents) {
      const target = join(dir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents)
    },
    append(relativePath, contents) {
      appendFileSync(join(dir, relativePath), contents, 'utf8')
    },
    remove(relativePath) {
      rmSync(join(dir, relativePath), { force: true })
    },
    chmod(relativePath, mode) {
      chmodSync(join(dir, relativePath), mode)
    },
    move(from, to) {
      run('git', ['-C', dir, 'mv', from, to])
    },
    git(args) {
      return run('git', ['-C', dir, ...args])
    },
    commit(message, options = {}) {
      const author = options.author ?? DEFAULT_AUTHOR
      run('git', ['-C', dir, 'add', '-A'])
      run('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', message], { env: commitEnv(author) })
      return run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim()
    },
    head() {
      return run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim()
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Zip a fixture repository. `wrapper` mimics "compress this folder": the archive holds one
 * top-level directory containing the repository, while `bare` puts `.git` at the root.
 */
export function zipFixtureRepo(repo: FixtureRepo, zipPath: string, layout: 'wrapper' | 'bare' = 'wrapper'): void {
  const cwd = layout === 'bare' ? repo.dir : dirname(repo.dir)
  const target = layout === 'bare' ? '.' : basename(repo.dir)
  run('zip', ['-q', '-r', zipPath, target], { cwd })
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Minimal single-entry zip writer (method 0, stored). The `zip` CLI silently strips
 * traversal from entry names, so archives for zip-slip tests are assembled here instead.
 */
export function createStoredZip(zipPath: string, entryName: string, contents: string): void {
  const name = Buffer.from(entryName, 'utf8')
  const data = Buffer.from(contents, 'utf8')
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0) // local file header signature
  local.writeUInt16LE(20, 4) // version needed to extract
  local.writeUInt16LE(0, 6) // general purpose flags
  local.writeUInt16LE(0, 8) // compression method: stored
  local.writeUInt16LE(0, 10) // modification time
  local.writeUInt16LE(0x21, 12) // modification date (1980-01-01)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18) // compressed size
  local.writeUInt32LE(data.length, 22) // uncompressed size
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28) // extra field length

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0) // central directory header signature
  central.writeUInt16LE(20, 4) // version made by
  central.writeUInt16LE(20, 6) // version needed
  central.writeUInt16LE(0, 8) // flags
  central.writeUInt16LE(0, 10) // method
  central.writeUInt16LE(0, 12) // time
  central.writeUInt16LE(0x21, 14) // date
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30) // extra length
  central.writeUInt16LE(0, 32) // comment length
  central.writeUInt16LE(0, 34) // disk number start
  central.writeUInt16LE(0, 36) // internal attributes
  central.writeUInt32LE(0, 38) // external attributes
  central.writeUInt32LE(0, 42) // offset of local header

  const centralOffset = 30 + name.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with central directory
  eocd.writeUInt16LE(1, 8) // entries on this disk
  eocd.writeUInt16LE(1, 10) // total entries
  eocd.writeUInt32LE(46 + name.length, 12) // central directory size
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  writeFileSync(zipPath, Buffer.concat([local, name, data, central, name, eocd]))
}
