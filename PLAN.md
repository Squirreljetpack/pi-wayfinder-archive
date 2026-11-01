# pi-wayfinder2 — implementation plan

Supersedes `PRELIM`. Fork of `../pi-wayfinder` ("the upstream") that keeps the tree-sitter half
and replaces the anchor-based editing half.

## 0. Locked decisions

| Decision | Choice |
| --- | --- |
| Tool names | Shadow pi built-ins: register `edit` and `read`; keep AST tools as separate names. |
| Edit modes | `exact`, `between`, `lines`. Batched: many edits, many files, one transaction. |
| History storage | **SQLite** (`node:sqlite`), one global DB `~/.cache/pi-wayfinder/history.db`, `cwd` column scopes it per repo. |
| Rollback unit | Whole transaction (all files, all edits), id returned by every `edit` call. |
| Modes/flags | None. No additive/preferred/replacement machinery — the fork always owns `read`/`edit`. |

### 0.1 Reversal on the store: SQLite is right, my "one file is fishy" instinct was about JSONL

The earlier objection was to a *hand-rolled* append-only text file: a size cap forces a rewrite,
and a rewrite racing concurrent appenders either loses entries or needs an out-of-band lock.
SQLite has that lock (WAL + `BEGIN IMMEDIATE` + busy handling) built in, so the single-file design
becomes correct instead of clever. Measured before committing to it — two processes, 200
transactions each, 4 KB blob per row, `BEGIN IMMEDIATE`/`COMMIT` per transaction:

```
A ok 200 err 0     B ok 200 err 0     rows 400     (SQLite 3.51.2, node:sqlite, WAL)
```

Three gotchas found by running it, each with a one-line mitigation:

1. **`PRAGMA busy_timeout` must be set before `journal_mode=WAL`.** With `journal_mode` first,
   two processes opening simultaneously both throw `ERR_SQLITE_ERROR` / `errcode 5`
   (`database is locked`) — reproduced. So: `busy_timeout` → `journal_mode` → everything else.
2. **`node:sqlite` prints an `ExperimentalWarning` to stderr on first import.** In pi's alternate
   screen a stray stderr write can garble a frame. Shield it: lazy `await import('node:sqlite')`
   wrapped in a scoped `process.emitWarning` override that drops only the SQLite experimental
   warning, restored in a `finally`.
3. **Bun compatibility is fine** (Bun 1.4.2 runs `node:sqlite`), so pi's `bun build --compile`
   standalone binary is not a reason to avoid it. If the import still fails, `edit` degrades to
   "no history / no rollback" with a warning rather than failing the edit.

## 1. Why the anchor half is being dropped

Upstream's editing model is: read → get `WayA│line text` tokens → copy the token into a later
call. Every failure mode of that scheme lives in code that exists only to repair anchor mistakes:

- `resolveAnchor()` + `didYouMeanHint()` + `validateMultiLineReplacement()` + the correction-payload
  builder in `tools/edit-file.ts` (≈450 of its 643 lines);
- `AnchorStateManager` (line-diff re-anchoring so old tokens survive edits);
- `stripHashes()` on every edit payload, `[File Hash: …]` / `[Function Hash: …]` headers,
  anchor stripping in the TUI renderers.

Symptoms we saw in practice: tokens copied into `text`, tokens invented, tokens stale after a
sibling edit, multi-line anchors rejected. The repair path (a full corrected tool call embedded
in an error message) costs more tokens than the original edit.

Replacement model: three ways to name a region that need no state — the exact text, a pair of
delimiters, or two line numbers. Safety comes from `expected_matches`, whole-transaction
validation before any write, and rollback snapshots instead of from unforgeable tokens.

What survives untouched: `get_file_skeleton`, `get_function`, `replace_symbol`, `insert_symbol`,
`find_symbol_references`, `rename_symbol` — all pure tree-sitter, none of them need anchors (they
only *emitted* them).

## 2. Platform deltas (upstream targeted 0.74, we target 1.4)

| Area | Finding |
| --- | --- |
| `registerTool` | Same shape (`name/label/description/parameters/execute/renderCall/renderResult/promptSnippet/promptGuidelines`). `exposure`, `namespace`, `annotations`, `prepareArguments`, `constrainedSampling`, `outputSchema` are new and available. |
| Built-in shadowing | `toolRegistry.set(name, tool)` after built-ins → same-name registration wins (`agent-session.js`, `_refreshToolRegistry`). No `setActiveTools()` surgery. |
| Built-in tool factories | `createEditToolDefinition`, `createReadToolDefinition`, `truncateHead`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `withFileMutationQueue` are exported from the package root. Reuse them. |
| Non-exported internals | The package `exports` map only exposes `.` and `./rpc-entry`, so `edit-diff.ts`'s fuzzy helpers and `renderers/edit.js` are *not* importable. Renderers must be borrowed off the definition objects, not imported. |
| Built-in `read` | Emits **no line numbers** (raw text + offset/limit). Line-number mode therefore needs our own `read`. |
| Built-in `edit` | `details = { diff, patch, firstChangedLine }`; its TUI renderers consume exactly that. |
| Host deps | `@earendil-works/pi-*` and `typebox` must be `peerDependencies: "*"`, never `dependencies`. |
| Runtime | Node v25.6.1 (`node:sqlite` / SQLite 3.51.2); Bun 1.4.2 also supported by pi. |

## 3. Tool surface

| Tool | Origin | Notes |
| --- | --- | --- |
| `edit` | **new** | Transactional multi-file editor, 3 modes, count-verified, logged. |
| `read` | **new wrapper** | Line-numbered text reads; delegates images/PDF/other binaries to `createReadToolDefinition(cwd)`. |
| `rollback` | **new** | Restore a transaction's pre-edit snapshots. |
| `get_file_skeleton` | copy, de-anchored | |
| `get_function` | copy, de-anchored | Drop `[Function Hash]` / anchor banner; keep imports + class-property context. |
| `replace_symbol` | copy, de-anchored | Absorbs deletion (see S3): `text: ""` deletes; refuses when references exist unless `force`. |
| `insert_symbol` | copy, de-anchored | |
| `find_symbol_references` | copy, de-anchored | Emit `path:line` + numbered source line instead of anchor prefix. |
| `rename_symbol` | copy, de-anchored | |

Dropped: `read_file`, `edit_file`, `edit_lines`, `safe_delete_symbol`, `anchors/*`, `mode.ts`,
`--wayfinder-mode` flag, `/wayfinder` command.

## 4. Simplification ledger

The question was "we're doing a lot by hand" — this is the audit of that hand-rolled surface and
what is being removed from it. Line counts are rough.

| # | Hand-rolled surface | Action |
| --- | --- | --- |
| S1 | Three per-mode appliers (splice/overlap/no-op/order × 3) ≈ 200 lines | **One resolver, one applier.** Modes only *produce* `{start, end, text}` ranges against an immutable snapshot; `applyRanges()` owns ordering, overlap, no-op and splicing once. |
| S2 | Ported fuzzy matcher (`normalizeForFuzzyMatch`, `applyReplacementsPreservingUnchangedLines`, NFKC/quote/dash folding) ≈ 200 lines from pi, unimportable | **Do not port.** Narrow tolerance: exact → CRLF-folded (free: we already normalize and restore EOLs) → single-line matches may ignore trailing whitespace. ~35 lines. The overlay machinery exists only to keep *fuzzy* replacements byte-stable; with whitespace-only tolerance on single lines there is nothing to overlay. |
| S3 | `safe_delete_symbol` (250 lines + own test suite) duplicating `replace_symbol`'s write path | **Fold into `replace_symbol`.** `text: ""` deletes; the reference scan that made it "safe" becomes a pre-check inside the one AST write path, surfaced as `force` + a reference count in the result. |
| S4 | BOM/EOL/sha/temp+rename/mode-preserve logic in both `edit` and `rollback` | **One snapshot layer**: `readSnapshot()` / `writeSnapshot()` used by both. |
| S5 | Options nobody asked for: `constrainedSampling`, `outputSchema`/`structuredContent`, multi-path `read` (`path:range`, several paths), `TitledPanel` multi-file read view, `[File Hash]`/`[Function Hash]` banners, history-listing tool, `--wayfinder-*` flags, `/wayfinder` command, additive/preferred/replacement modes | **Not built.** Each is a doc + test + prompt-token cost with no consumer. |
| S6 | Fresh implementations of things pi already exports | **Reuse**: `createReadToolDefinition` (binary delegation + renderers + promptSnippet), `truncateHead`/`DEFAULT_MAX_*`, `withFileMutationQueue`. |
| S7 | Renderers | Keep upstream's `rendering/` (pi's `renderDiff` is not exported) but delete its anchor-specific branches and the multi-file read panel. One renderer each for `read`, `edit`, AST tools. |
| S8 | Hand-rolled history (dirs, blobs, zlib, prune walk, index) ≈ 200 lines | **SQLite**: schema + 3 functions (`append`, `get`, `prune`) ≈ 140 lines, and concurrency is the database's problem instead of ours. |

## 5. `edit`

### 5.1 Schema (flat, no unions)

A discriminated union (`anyOf`) blocks provider-side constrained decoding, and TypeBox unions
render badly in tool docs. One flat object, validated at runtime.

```ts
edit({
  edits: [{
    path: string,                 // per-edit, so one call can span files
    mode: "exact" | "between" | "lines",
    expected_matches?: number,    // optional guard; see 5.5
    old?: string, new?: string,                       // exact
    start?: string, end?: string, include_delimiters?: boolean,   // between
    start_line?: number, end_line?: number,           // lines
  }]
})
```

Fields optional in the schema; `validateEdit()` produces the precise error
(`mode "between" requires start and end`).

### 5.2 Modes resolve, one applier applies

```
snapshot = readSnapshot(path)            // text, bom, eol, sha — once per file
ranges   = mode === "exact"  ? resolveExact(snapshot, edit)
         : mode === "between" ? resolveBetween(snapshot, edit)
         :                      resolveLines(snapshot, edit)
text     = applyRanges(snapshot.text, [...ranges from all edits on this file])
```

`resolveExact` — exact `indexOf`; on miss, retry on CRLF-folded text (we normalize anyway); on
miss, retry allowing trailing-whitespace differences but only for matches contained in one line;
then fail with up to 20 `line: text` locations. Matches all non-overlapping occurrences (deliberate
difference from pi's edit, which errors on >1). `expected_matches` is the guard, not uniqueness.

`resolveBetween` — every `start` occurrence, each paired with the **first** `end` at or after
`start`'s end. Pairs must not overlap (nested starts are an error naming both offsets).
`include_delimiters: false` (default) -> range `(start.end, end.start)`; `true` -> `[start.start,
end.end)`. Also the insertion path: `new` placed between two delimiters with no old text.
Zero pairs -> error listing the first 3 candidate `start` offsets and whether `end` followed them.

`resolveLines` — `start_line` 1-indexed, `end_line` inclusive and defaulting to `start_line`;
`end_line < start_line` = pure insertion before `start_line`. Out of range -> error with the file's
line count.

`applyRanges` — sorts descending, rejects overlaps across all edits on the file, splices, and
strips line-number gutters from replacement text (`^\s*\d+[│|:]\s?`) so a model that pasted
numbered output cannot inject the gutter. Identical content afterwards -> per-file no-change error.

### 5.3 `expected_matches`

- Absent -> replace every match, count reported per edit.
- Present -> mismatch is a **transaction-level abort** before any write, with
  `edits[i] on path matched N, expected M` plus the first 20 match locations.
- `0` is a legal assertion ("must not be present"); a 0/0 edit is a no-op for that edit, but the
  transaction as a whole must change at least one byte.

### 5.4 Transaction pipeline

```
edit(edits)
 ├── validate schema + per-mode fields                       → typed errors
 ├── group by canonical path, reject duplicate targets
 ├── withFileMutationQueue(path) for every target, sorted    → in-process serialization
 │    ├── readSnapshot (BOM/EOL/sha)
 │    ├── resolve + apply every edit against the ORIGINAL
 │    └── no-op check
 ├── history.append(txn)  — snapshots + meta, BEFORE any write (§6)
 ├── if anything failed: report all failures, write nothing
 └── write phase, per file: writeSnapshot()
      → write <file>.<pid>.<id>.tmp → chmod(original mode) → re-check file sha → rename
```

- Every edit is matched against the original file, never against a sibling edit's output.
- Validation is complete before the first byte hits disk; a mid-write failure restores the
  already-written files from the in-memory snapshots and still keeps the log entry.
- **Cross-process file races**: `withFileMutationQueue` is in-process only, so the sha re-check
  immediately before `rename` is the cross-process guard — if another agent wrote the file since
  our read, we abort with `path changed while editing (expected <sha8>, found <sha8>); re-read and
  retry` instead of clobbering. This is optimistic concurrency: it narrows the window to
  microseconds without needing an OS file lock, which neither Node nor pi exposes.
- Abort: check `signal.aborted` after each await (never via a rejecting listener — that releases
  the queue while IO is in flight).
- temp+rename costs the inode (breaks `tail -f` on the old inode, replaces hardlinks) but a
  half-written source file is the worse failure. Mode is preserved.

### 5.5 Shims (`prepareArguments`)

Mirroring pi's edit shims keeps the shadowed tool callable by models with muscle memory:

- `edits` as a JSON string -> parsed.
- single edit object instead of an array -> wrapped.
- `oldText`/`newText` (top level or inside `edits[]`) -> `mode: "exact", old, new`.
- top-level `{ path, edits: [...] }` -> `path` pushed down into each edit.

### 5.6 Result

```
Updated 2 files: 5 edits, 7 replacements.
  src/a.ts: 3 edits, 5 replacements
  src/b.ts: 2 edits, 2 replacements
Transaction k3n8f2a-7qx1 — rollback with rollback({ transaction_id: "k3n8f2a-7qx1" })
```

`details: { transactionId, diff, patch, firstChangedLine, files[], edits, replacements }`.
`diff` comes from `rendering/diff-output.ts`; `patch` is a new `createUnifiedPatch()` there
(`diff`'s `createTwoFilesPatch` over all touched files, as pi's edit does).

### 5.7 Safety/feature checklist carried over from pi's built-in edit

| pi edit feature | Verdict |
| --- | --- |
| BOM split/restore | Keep (in the snapshot layer) |
| EOL detect/normalize/restore | Keep (in the snapshot layer) |
| fuzzy fallback + unchanged-line preservation | **Replaced** by §4-S2's narrow tolerance (no port) |
| empty `old` rejection | Keep |
| no-change rejection | Keep, per file |
| overlap rejection | Keep, per file across all edits |
| duplicate/ambiguous match error | **Inverted** into replace-all + `expected_matches` |
| `prepareArguments` shims | Keep (§5.5) |
| `constrainedSampling` | **Not built** (S5) |
| `withFileMutationQueue` | Keep, multi-file, sorted |
| actionable error strings | Keep, add line locations |
| `details.diff/patch/firstChangedLine` | Keep (TUI + editor navigation) |
| `annotations: { destructiveHint: true, openWorldHint: false }` | Keep — lets permission extensions gate it |

## 6. `read` override

Built from the built-in definition, not from scratch:

```ts
const builtinFor = memoizeByCwd((cwd) => createReadToolDefinition(cwd)); // ctx.cwd is call-time
pi.registerTool({
  ...builtinFor(process.cwd()),          // schema, description, outputSchema, renderers, snippet
  async execute(id, args, signal, onUpdate, ctx) {
    const builtin = builtinFor(ctx.cwd);
    if (await isBinaryOrImage(args.path, ctx.cwd)) return builtin.execute(id, args, signal, onUpdate, ctx);
    return readNumbered(args, ctx);
  },
});
```

- Delegation decided by extension for known images/PDFs, then by a NUL-byte sniff, so attachments,
  resize hints and non-vision notices stay exactly as pi produces them.
- Text path: `truncateHead` with `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`, the same continuation
  notices, but each line emitted as `NN│content` with **absolute** (offset-aware) numbers.
- Renderers/snippet inherited from `builtin`, so the transcript is unchanged.
- Path resolution (`@` stripping, `~` expansion) is not exported; replicate it in `read/paths.ts`.
- `stripLineNumberGutter()` lives beside the formatter and is used by `applyRanges`.

## 7. History and rollback

### 7.1 Schema (`~/.cache/pi-wayfinder/history.db`)

```sql
PRAGMA busy_timeout = 5000;          -- must precede WAL (§0.1)
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS txn (
  id         TEXT PRIMARY KEY,       -- <base36 epoch-ms>-<rand4> : sortable, short enough to copy
  created_at INTEGER NOT NULL,
  cwd        TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- 'edit' | 'rollback'
  rolls_back TEXT REFERENCES txn(id),
  summary    TEXT NOT NULL           -- JSON: edits + counts, for humans
);
CREATE TABLE IF NOT EXISTS change (
  txn_id     TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,          -- repo-relative, as the model wrote it
  abs        TEXT NOT NULL,
  before     BLOB NOT NULL,          -- full pre-edit bytes
  after_sha  TEXT NOT NULL,
  PRIMARY KEY (txn_id, path)
);
```

- `append()` = one `BEGIN IMMEDIATE … COMMIT`; `get(id)`; `prune()`. Nothing else — no query API,
  no listing tool. Humans inspect with
  `sqlite3 ~/.cache/pi-wayfinder/history.db "select id, datetime(created_at/1000,'unixepoch'), kind, path from txn join change using(txn_id) order by created_at desc limit 20"`.
- One global DB; the `cwd` column scopes per repo, so "last transaction in this repo" is a WHERE
  clause rather than a directory layout.
- Rollback restores whole bytes, so there is no patch application, no fuzz, and `force` is
  meaningful. Storage stays small — 200 transactions of typical source files is single-digit MB.
- Retention: newest 500 transactions **or** 128 MB, whichever binds first; prune after a successful
  commit, `PRAGMA wal_checkpoint(TRUNCATE)` afterwards. Pruning failure is logged, never fatal.
- `import('node:sqlite')` failure -> history disabled, `edit` still edits, result says so.

### 7.2 `rollback`

```ts
rollback({ transaction_id: string, force?: boolean })   // "last" resolves within ctx.cwd
```

1. Load `txn` + `change`; unknown id -> error listing the 5 most recent ids in this repo.
2. Verify each file's current sha256 equals `after_sha`; a missing file counts as drift. Drift ->
   refuse with `path: expected …, found …` unless `force`.
3. Write `before` blobs back through the same snapshot writer and mutation queue.
4. Record the rollback as its own transaction (`kind: 'rollback'`, `rolls_back: <id>`), whose
   `before` blobs are the current contents — a mistaken rollback is itself undoable.
5. Return the restore diff.

## 8. De-anchoring the AST half

| File | Change |
| --- | --- |
| `ast/ast-anchor-bridge.ts` -> `ast/symbol-locator.ts` | Rename class to `SymbolLocator`; drop the `AnchorStateManager` parameter from `getFileSkeleton`, `getFunctions`, `getSymbolRange`; `formatLineWithHash` -> `formatNumberedLine`. |
| `ast/symbol-context-resolver.ts` | Drop the `anchors` option; numbered formatter. |
| `tools/get-file-skeleton.ts` | Drop the reconcile call; regex fallback emits numbers. |
| `tools/get-function.ts` | Drop `[Function Hash]` and the "anchors are stable, use edit_file" banner. |
| `tools/replace-symbol.ts` | Absorb `safe_delete_symbol`: `text: ""` deletes; pre-check references via `SymbolScanner`, refuse unless `force`, report the count. Drop `stripHashes` and `anchors.reconcile`. |
| `tools/insert-symbol.ts` | Drop `stripHashes`/reconcile. |
| `tools/find-symbol-references.ts` | `(<symbols>) NN│line`; drop `anchors`. |
| `tools/rename-symbol.ts` | Drop `anchors.reconcile`. |
| `rendering/pi-renderers.ts` | Numbered-prefix regex replaces the anchor regex; delete `[File\|Function] Hash` filtering and the multi-file read panel. |
| `rendering/diff-output.ts`, `tools/output-limits.ts`, `symbols/*`, `ast/{parse-file,language-parser,queries/*}` | Unchanged copies. |
| `anchors/*`, `mode.ts`, `index.ts` mode plumbing, `tools/{read-file,edit-file,edit-lines,safe-delete-symbol}.ts` | Deleted. |

`index.ts` becomes ~30 lines: create `SymbolCache`/`SymbolScanner`, register 8 tools, no flags, no
commands, no `setActiveTools`.

## 9. Prompt guidance

Via each tool's `promptSnippet`/`promptGuidelines` plus one short `before_agent_start` block:

- Explore with `get_file_skeleton` -> `get_function` -> `read` for narrow ranges.
- Prefer `replace_symbol` for whole symbols (`text: ""` deletes), `edit` for everything else.
- Mode selection: `exact` for small changes (replace-all by default; guard with
  `expected_matches`); `between` when the region is large (never retype it); `lines` when the
  numbers were read in this session.
- Batch all edits for a task into one `edit` call; all edits match the original file.
- Every `edit` returns a transaction id; use `rollback` instead of hand-repairing a bad edit.
- Line numbers in `read`/`get_function` output are never part of file content.

## 10. Target tree

```
pi-wayfinder/
├── package.json          # pi.extensions: ["./src/index.ts"]; deps diff, tree-sitter-wasms, web-tree-sitter
├── tsconfig.json         # copied from upstream
├── README.md             # rewritten (no anchors, new tool docs, sqlite inspect one-liner)
├── NOTICE                # Dirac (upstream queries) + pi-wayfinder + pi-coding-agent (shims authored after)
├── PLAN.md  PRELIM
├── src/
│   ├── index.ts
│   ├── prompt.ts
│   ├── edit/{schema.ts,resolve.ts,apply.ts,snapshot.ts,tool.ts,shims.ts}
│   ├── read/{tool.ts,numbering.ts,paths.ts}
│   ├── history/{db.ts,rollback.ts,hash.ts}
│   ├── ast/{parse-file.ts,language-parser.ts,symbol-context-resolver.ts,symbol-locator.ts,queries/*}
│   ├── symbols/{symbol-scanner.ts,symbol-cache.ts}
│   ├── rendering/{diff-output.ts,pi-renderers.ts}
│   └── tools/{get-file-skeleton,get-function,replace-symbol,insert-symbol,find-symbol-references,rename-symbol,output-limits}.ts
└── test/{…}.test.ts
```

## 11. Tests (vitest, `npm test`)

- `edit/resolve`: exact single/multi/replace-all counts, CRLF fold, single-line trailing-space
  tolerance, multi-line trailing-space must fail, empty `old`, non-match error text, between
  delimiter preservation/`include_delimiters`/nested starts/missing `end`/insertion, lines
  single/range/insert-before/out-of-range/pasted-gutter stripping.
- `edit/apply`: multi-edit ordering, overlap rejection, cross-file grouping, duplicate path
  rejection, `expected_matches` mismatch aborts everything, 0/0 assertion, no-change rejection.
- `edit/snapshot`: BOM round-trip, CRLF round-trip, mode preservation on temp+rename, sha
  re-check aborts a write when the file changed underneath it (simulated by writing between
  snapshot and write).
- `edit/tool`: atomicity (a failing edit leaves every file byte-identical), transaction id in
  result, `prepareArguments` shims, history-degraded path still edits.
- `history`: append-before-write, prune by count, rollback restores exact bytes, drift refuses,
  `force` overrides, rollback recorded as a transaction, two connections in the same process.
- `read`: numbered output with offset, truncation notices, gutter strip round-trip, binary
  delegation returns the builtin result unchanged.
- Ported upstream suites with anchor assertions stripped: `get-function`, `get-file-skeleton`,
  `replace-symbol` (incl. delete + `force`), `insert-symbol`, `find-symbol-references`,
  `rename-symbol`, `symbol-scanner`, `ast-parse-file`, `ast-language-parser`, `rendering`.
  `edit-file.test.ts` (33 KB, essentially all anchor-machinery cases) is dropped, not ported.

## 12. Milestones (each a commit)

1. **scaffold**: package.json/tsconfig/vitest, copy `ast/`, `symbols/`, `rendering/`,
   `output-limits.ts`; strip anchor plumbing; fold delete into `replace_symbol`; ported tests pass.
2. **read**: numbered override + `numbering.ts` + `paths.ts` + tests.
3. **edit core**: `snapshot.ts` + `resolve.ts` + `apply.ts` + `exact`/`lines` + registration +
   result payload + renderers; tests.
4. **edit between** + `expected_matches` + shims; tests.
5. **history**: `db.ts` (pragma order, warning shield, degrade), append-before-write, prune,
   `rollback`; tests.
6. **prompts + README**; dead code gone; typecheck clean.
7. **smoke**: `pi -e . -p "…"` in a scratch repo — shadowing, numbered reads, a between-edit, a
   rollback, and two concurrent pi sessions editing different files of the same repo.

## 13. Open questions

1. ~~Package name / publish scope~~ — settled: `pi-wayfinder`, published as
   `git:github.com/Squirreljetpack/pi-wayfinder`.
2. **`exact` replace-all by default** — mitigation is `expected_matches` + rollback + loud counts.
3. **`between`/`lines` are language-agnostic** (pure text); only the AST tools are language-gated.
4. **No git coupling** — rollback snapshots are the safety net; requiring a clean worktree would
   make the tool unusable outside repos.

## 14. Progress

Progress notes live here rather than in a separate `%%…_PROGRESS.md`; the plan and the log stay together.

### Milestone 1 — scaffold + de-anchored AST half (done)

Baseline before edits: upstream imported verbatim → `npm run typecheck` clean against pi 1.4.0,
`vitest` 180/180. That commit is the fork's starting point and the proof that the 0.74→1.4 delta
was additive for the code we kept.

Done:

- `src/anchors/` deleted. `AnchorStateManager`, `line-hashing.ts` (`ANCHOR_DELIMITER`,
  `formatLineWithHash`, `splitAnchor`, `stripHashes`, `contentHash`) are gone with it; the only
  anchor-era file that survived is the `diff` module declaration, moved to `src/types/diff.d.ts`.
- `ast/ast-anchor-bridge.ts` → `ast/symbol-locator.ts`, class `ASTAnchorBridge` → `SymbolLocator`.
  `getFileSkeleton(path)`, `getFunctions(path, relPath, names)`, `getSymbolRange(path, symbol, type?)`
  no longer take or reconcile anchors; every rendered row goes through `formatNumberedLine()`.
  `[Function Hash: …]` and the "anchors are stable, use edit_file" banner are gone.
- `tools/line-numbers.ts`: gutter is `12│code` (box-drawing separator, deliberately not `|`/`:`
  so a copied gutter can be stripped without mistaking `8080: host` for one). `stripLineNumbers()`
  matches `/^\s*\d+│/` — **no optional space after the separator**, because that space is content
  and eating it silently re-indented every replacement line (caught by ported tests).
- `replace_symbol` absorbed deletion (`text: ""`), with `computeDeleteRange` + `blockingReferences`
  moved in from the deleted `safe-delete-symbol.ts`; `force` is now a per-replacement flag and a
  refusal throws (naming each surviving reference location) instead of returning `deleted: false`.
  It also invalidates the scanner cache after writing, which upstream's version did not.
- `find_symbol_references`, `get_file_skeleton`, `get_function`, `insert_symbol`, `rename_symbol`
  render numbers, take no anchors, and no longer print "existing anchors are now stale" advisories.
- `rendering/pi-renderers.ts`: `stripAnchorPrefixesForDisplay` → `stripLineNumbersForDisplay`;
  hash-line filtering and the multi-file read panel (`TitledPanel` kept for multi-file diffs) gone.
- `index.ts` is 25 lines: two caches, six AST tools, one prompt hook, one cache reset. `mode.ts`,
  the three mode flags, the `/wayfinder` command and `setActiveTools` plumbing are deleted.
- Tests: 100 passing (upstream's 180 minus the deleted suites, plus the ported deletion suite).
  `symbol-locator.test.ts` asserts line numbers instead of anchor tokens.

Deviations from the plan: none. `read`, `edit` and `rollback` are not registered yet (milestones
2–5), so `prompt.ts` is provisional.

Breaking surface for anyone who used upstream: tool names `read_file` / `edit_file` / `edit_lines` /
`safe_delete_symbol` are gone; `registerReplaceSymbolTool(pi, scanner)` and
`SymbolLocator.getSymbolRange(path, symbol, type?)` changed shape; `stripAnchorPrefixesForDisplay`
was renamed.

### Milestone 2 — numbered `read` (done)

- `src/read/tool.ts` registers a tool literally named `read`, spreading pi's own
  `createReadToolDefinition(cwd)` for schema, description plumbing, `outputSchema`,
  `renderCall` and `renderResult`, then overriding `execute`.
- Live check in a scratch dir: pi loads the fork with no name-conflict error, the prompt's
  `<tools>` block contains exactly one `read`, and our guideline ("Every line of read output
  starts with its line number…") shows up in `<rules>` — so the builtin is genuinely replaced
  (`_refreshToolRegistry` writes extension tools over builtins, as read earlier).
- Text path mirrors pi's byte-for-byte semantics (offset bounds error, `limit` short-circuit,
  `truncateHead`, `firstLineExceedsLimit` bash hint, both continuation notices) and only adds the
  gutter. Numbers stay absolute under `offset`; a trailing newline does not produce a phantom
  numbered line; empty files stay empty.
- Images delegate to the builtin definition after a magic-byte sniff (PNG/JPEG/GIF/WEBP/BMP), so
  attachments, resize hints and non-vision notices are pi's own. Other binaries get a one-line
  `[Binary file (4KB), not shown: …]` notice instead of 50KB of mojibake — deliberately better
  than the builtin, which decodes them as text.
- `renderResult` strips the gutter before handing off to pi's renderer, so the TUI looks exactly
  like upstream `read`.
- `src/read/paths.ts` reimplements pi's `resolveToCwd` (unicode-space normalisation, `@` strip,
  `~` expansion) plus an NFD fallback. The macOS AM/PM narrow-space and curly-quote filename
  variants are **not** replicated — dead on Linux, and a two-`stat` tax on every read otherwise.

Notes:

- 109 tests, typecheck clean. `read` covered by `test/read.test.ts` (gutter, offset numbering,
  continuation notices, both path forms, binary notice, image delegation, renderer de-guttering).
- An end-to-end `pi -p` smoke run could not be completed: the configured models are not reachable
  from this environment (`Model "…" not found`), so tool-call round-trips are deferred to
  milestone 7. Registration itself is verified live (above).
- Upstream `pi-wayfinder` is still installed globally; pi refuses to load two extensions that
  register the same tool names, so the fork and upstream cannot coexist in one config. Worth a
  README line, not a code change.

### Milestone 3 — `edit` core: exact + lines (done)

- `src/edit/snapshot.ts`: `TextSnapshot` holds LF-normalized text (for matching), the exact raw
  bytes (for restore-on-failure), BOM, EOL, sha256 and mode. `writeSnapshot` writes a hidden
  sibling temp file, chmods it to the original mode, **re-hashes the target immediately before
  `rename`** (optimistic cross-process guard), and renames. `restoreSnapshot` puts raw bytes back.
- `src/edit/resolve.ts`: one validator + one resolver per mode, all producing `{start, end, text}`
  over the original text — so there is exactly one applier and one overlap check
  (`src/edit/apply.ts`). `expected_matches` (including `0` as an assertion), gutter stripping and
  line math live here.
- `lines` mode is line-oriented: the range covers whole lines including their break, and a non-empty
  replacement gains a trailing newline when the replaced block ended with one. That makes
  replace/delete/insert all behave ("delete line 2" leaves no blank line, "replace line 2 with X"
  does not join it to line 3). Insertion is `end_line = start_line - 1`; `start_line` may be
  `total + 1` to append.
- `exact` mode replaces every occurrence and tolerates only (a) CRLF in `old` and (b) trailing
  whitespace on a single-line match. Multi-line whitespace drift is a hard error with line
  locations — the deliberate S2 cut.
- `src/edit/tool.ts`: validate → group by canonical path → nested mutation queues (sorted) → snapshot
  and resolve **everything** → only then write. Any failure aborts before the first byte and is
  reported for every failing file at once; a mid-write failure restores every already-written file
  from its raw snapshot.
- `createUnifiedPatch()` added to `rendering/diff-output.ts` for `details.patch`; the TUI reuses
  `renderDiffResult`, so multi-file edits render as one panel per file.
- Tests: `test/edit.test.ts` (23). Totals: 132 passing, typecheck clean.

Design notes worth remembering:

- The no-change check is transaction-level, not per file: a file whose edits are all no-ops (or a
  passing `expected_matches: 0` assertion) is simply not written, but a call with nothing to write
  is an error.
- `between` already exists in `resolve.ts` (greedy start/end pairing, `include_delimiters`,
  dangling-start diagnostics); milestone 4 is therefore just the argument shims plus its tests.

### Milestone 4 — `between` mode + argument shims (done)

- `between` pairs every `start` occurrence with the first `end` at or after it, greedily: a start
  nested before that `end` belongs to the same region instead of opening a second one. Zero hits
  reports either "start delimiter not found" or the line of each dangling start.
- Replacement shaping is now one rule shared by `lines` and `between`: a non-empty replacement
  inherits the newline that ended the replaced region (and a whole-line insertion always gets one).
  Without it, replacing a block body produced `}…}`-style joins. `exact` never reshapes.
- `src/edit/shims.ts` + `prepareArguments`: accepts `oldText`/`newText` (per edit or flat at the top
  level), a single edit object, a JSON-stringified `edits`, and a top-level `path` pushed down into
  each edit. A modern call is returned untouched.
- Tests: 36 for edit (between subjects, shims, an end-to-end shimmed call). Totals: 145 passing.

### Milestone 5 — transaction log + rollback (done)

- `src/history/db.ts`: one SQLite database at `$PI_WAYFINDER_HOME` (default
  `~/.cache/pi-wayfinder`), `txn` + `change` tables, `ON DELETE CASCADE`, `BEGIN IMMEDIATE` per
  record, WAL. Pragma order is load-bearing (`busy_timeout` **before** `journal_mode`); retention is
  `DELETE` past 500 rows plus a page-count check, then `wal_checkpoint(TRUNCATE)` +
  `incremental_vacuum`, all best-effort.
- `node:sqlite` is loaded through `process.getBuiltinModule("node:sqlite")`, not `import()`: the
  test runner's resolver strips the `node:` prefix and tries to resolve `sqlite` as a package
  (`Failed to load url sqlite`), and a plain dynamic import would have the same problem under any
  bundler. The `ExperimentalWarning` is still suppressed during load only.
- `edit` records the transaction **before** the write phase, with each file's raw pre-edit bytes and
  the sha256 of the bytes it is about to write. The transcript gets
  `Transaction <id> — undo with rollback({ transaction_id: "<id>" })`. If the database cannot be
  opened the edit still happens and the result says history is unavailable.
- `src/history/rollback.ts`: `rollback({ transaction_id | "last", force? })` verifies every file's
  current hash against the recorded `after_sha`, refuses with a per-file diff of expected/found
  unless `force`, writes the stored bytes back, and records itself as a `kind: "rollback"`
  transaction — so a mistaken rollback is rollback-able. Unknown ids list the 5 most recent ids in
  the same repository (`cwd` column).
- Tests: `test/history.test.ts` (10) covering append/read, `last` per cwd, edit→rollback byte
  equality, rollback-of-rollback, drift refusal, force, unknown id, unavailable database.
  `test/setup.ts` points `PI_WAYFINDER_HOME` at a temp dir per test file so tests never touch the
  real cache. Totals: 155 passing, typecheck clean.

### Milestone 6 — prompt, README, annotations (done)

- `prompt.ts` rewritten around the real tool surface: skeleton → function → read, symbol tools for
  whole symbols, `edit` mode selection by cost ("exact" small, "between" large, "lines" when the
  numbers were just read), one batched call, transaction id → rollback.
- README rewritten: tool table, mode examples, transaction/rollback semantics, the SQLite
  inspection one-liner, and the incompatibility note (pi refuses two extensions that register the
  same tool names, so `pi-wayfinder` and `pi-wayfinder2` cannot both be enabled).
- `annotations` added to `edit` and `rollback` (`destructiveHint`, `openWorldHint: false`) so
  permission extensions can gate them.
- NOTICE now credits pi-wayfinder alongside Dirac.
- Verified against the live harness (`pi -p --mode json`, extension-only): the `<tools>` block lists
  our `read`, our `edit` (with its own snippet) and `rollback`, pi's built-in `edit` guidelines are
  gone, and our guidelines appear. `prepareArguments` is called by pi-agent-core's
  `prepareToolCallArguments` *before* `validateToolArguments`, so the shims are on the real path.

### Milestone 7 — smoke (partial)

Registration, tool listing, prompt injection and `prepareArguments` ordering are verified live.
An end-to-end tool-call round trip is still blocked: this environment's configured models are not
reachable (`Model "…" not found`), so no model ever emits a tool call here. The remaining check is
`pi -e .` in a scratch repo with a working model: one `edit` across two files, a `between` edit, and
a `rollback`.

### Post-milestone review fixes

- `rollback` now restores under the same per-file mutation queues as `edit` (a `rollback` and an
  `edit` can land in one parallel tool batch); the queue helper moved to `edit/snapshot.ts`.
- Retention skips the checkpoint/vacuum when nothing was pruned, so the common edit pays one
  `DELETE` probe instead of a WAL checkpoint.
- `read` drops the `\r` a CRLF file would otherwise leave at the end of every numbered line; models
  were copying it into `edit` payloads.
- Regression tests added for: the same exact edit twice in one call (must be an overlap error, not a
  double apply), BOM+CRLF with a pasted gutter in `lines` mode, and rollback of a file deleted after
  the edit (drift → refuse, `force` → recreate).
- Totals: 159 tests, typecheck clean.

### Publishing

- Local dev tree renamed to `pi-wayfinder`; the upstream checkout (a fork of `deevus/pi-wayfinder`)
  was archived at `~/gh/TEMP/pi-wayfinder`.
- Published to `github.com/Squirreljetpack/pi-wayfinder` as a force-pushed `main`: the repository
  history is this implementation's, the earlier fork commits live only in the TEMP checkout.
- Installed with `pi install git:github.com/Squirreljetpack/pi-wayfinder`, which clones to
  `~/.pi/agent/git/github.com/Squirreljetpack/pi-wayfinder`. Verified in a normal session (no
  `-ne`, no `-e`): the `<tools>` block lists this package's `read`, `edit` and `rollback` with its
  own guidelines, and no extension-load error is reported.
