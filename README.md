# Repo Analysis Tool (RAT)

COMS3011A test project. A web dashboard that measures file, directory, repository, commit-set
and author metrics over the history of a git repository, for multiple repositories, with
filtering and author merging.

## Prerequisites

- **Node.js >= 18.19** — the dependency set is pinned to the last majors that run on Node 18
  (see `engines` in `package.json`).
- **git** on `PATH` — history is read with the git CLI so that rename and binary detection
  follow git's own semantics.

## Setup

```bash
npm install
```

One install at the root installs every workspace (`server` and `web`).

## One-command run

Development — Express API on `:3001` and the Vite dev server on `:5173`, with `/api` proxied
to the API:

```bash
npm run dev
```

Production-style — builds the dashboard, then serves both the API and the static assets from
Express:

```bash
npm run build && npm start
```

Open <http://localhost:5173> in development, or <http://localhost:3001> after a build.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Express API + Vite dev server together |
| `npm run build` | Builds the dashboard into `web/dist` |
| `npm start` | Runs the API, serving `web/dist` when it has been built |
| `npm test` | Server test suite (vitest) |
| `npm run verify:repo` | Verification gate: runtime, git, storage layer, data directory, pinned repos |

## Project layout

```
server/    Express API, SQLite storage, ingestion, metric engine, query layer
web/       React + Vite + ECharts dashboard
scripts/   verification tooling
fixtures/  pinned grading repositories, and later the oracle expectations
```

## Grading repositories

Sample metrics are supplied at a specific commit hash per repository.
`fixtures/pinned-repos.json` holds the URLs; each `ref` is pinned as soon as the official
hash for that repository is known.

| Repository | URL | Pinned ref |
| --- | --- | --- |
| cJSON | <https://github.com/DaveGamble/cJSON.git> | not yet supplied |
| Redis | <https://github.com/redis/redis.git> | not yet supplied |
| Git | <https://github.com/git/git.git> | not yet supplied |

## Pinned Interpretations

Correctness contract: one entry per ambiguity in the brief, stating the interpretation this tool
implements and the test that pins it down. Each entry was verified byte-for-byte against the
cJSON history (1,113 commits) and synthetic fixtures before being frozen. The parser command is

```bash
git -C <repo> log -z --numstat -M50% --no-merges --no-show-signature \
  --pretty=format:%x00%H%x00%an%x00%ae%x00%aI%x00%P%x00
```

and its byte-level grammar is documented in `server/src/git/parse.ts`.

1. **History scope and merges.** The brief does not say whether merge commits count.
   Interpretation: full history reachable from HEAD, merge commits excluded (`--no-merges`), so
   every line change is counted exactly once, in the commit that wrote it. Test: "merge commits
   are excluded so their diffs are never double counted" in `server/test/metrics.test.ts`.
2. **Renames.** Interpretation: git's own similarity detection at the standard threshold
   (`-M50%`); a rename is one change record with `old_path` set, attributed to the new path, and
   counted with git's numstat deltas — a pure rename contributes 0/0. History before a rename
   stays under the old path; following renames over time is a later feature. Test: "a pure
   rename is a zero-delta record attributed to the new path".
3. **Binary files.** A `-`/`-` numstat row is stored with `is_binary = 1` and zero deltas; it
   contributes nothing to l+, l−, δ, λ or to directory rollups. Test: "binary files are flagged
   and contribute no line counts".
4. **Mode-only changes.** Also a zero-delta record (`0\t0` with an inline path); only renames
   carry the split old/new path form, so a mode change is never mistaken for a rename. Test:
   "a mode-only change is a zero-delta record, not a rename".
5. **Empty commits.** Stored with an empty change list rather than dropped; they carry no
   metrics and must not disturb the surrounding stream. Test: "an empty commit between changes
   is stored without change records".
6. **File metric definitions.** l+ = sum of added lines, l− = sum of removed lines,
   δ = l+ − l−, λ = l+ + l−, all over the full history in scope. Per-file sums equal the
   totals. Cross-check: ingesting a real cJSON zip reproduces the independent
   `git log --no-merges -M50% --shortstat` totals exactly (46,377 insertions / 11,211 deletions
   at 6d9f2443, 955 commits).
7. **Directory aggregation.** Every ancestor directory of a changed file receives that file's
   deltas for the commit; the repository root is the empty path `''`. Binary files are skipped.
   Test: "directory deltas roll up over every ancestor with the root as the empty path".
8. **Path filter.** Case-sensitive literal substring match on the full path, with LIKE
   wildcards (`%`, `_`) escaped; every query runs over the full history by default. Test: "the
   path filter is a literal substring match and the limit reports truncation".
9. **Author identity and time.** Names and emails are stored exactly as git reports them
   (`%an`/`%ae`, no mailmap rewrite) and the timestamp is the strict ISO-8601 author date
   (`%aI`). Identity merging arrives with `author_aliases` and is applied at query time.

Ingestion contract for zip uploads:

- the archive must contain a `.git` directory, either at its root or inside a single wrapper
  directory (the "compress this folder" shape);
- every extracted entry is resolved against the extraction root and refused when it escapes it
  (zip-slip), with entry-count and uncompressed-size safety caps;
- a failed parse marks the repository `failed` with the reason and deletes partial rows;
- ingestions run strictly one at a time (single-writer SQLite, CPU-heavy parse).
