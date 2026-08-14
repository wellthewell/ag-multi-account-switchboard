# Read usage from the conversation store — design

**Status:** proposed
**Date:** 2026-08-14
**Scope:** Phases 1 and 2 (correct data, then live data). Visualization work is deliberately out of scope and gets its own spec.

---

## 1. Problem

Usage statistics silently miss entire days of work.

The extension reads token usage by asking the Antigravity language server. That server can only answer for conversations that already existed on disk **when the server process started**. Conversations created afterwards by the `agy` command-line client are invisible to it, permanently, for the life of that process.

Measured on 2026-08-07, four language server instances against four conversations:

```
LS instance                      1d9ecd7c   ddcb660f   50163fed   b7dea06c
                                 (Jul 25)   (Aug 3)   (01:17:50) (16:17:06)
pid 22072  started Aug 7 01:17:15   OK        OK         500        500
pid 74697  started Aug 3 08:45:16   OK        500        500        500
pid 74874  started Aug 3 08:45:17   OK        500        500        500
```

`50163fed` was created 35 seconds after pid 22072 started. The boundary is process start, not recency.

The server cannot be persuaded to load one on demand. `LoadTrajectory`, `GetCascadeTrajectory`, `GetUserTrajectory` and `InitializeCascadePanelState` all refuse (`failed to load trajectory`, `not_found`, `unimplemented`).

**Consequence as of 2026-08-14:** 280+ model calls across four conversations sit on disk fully intact and have never been counted. Aug 7 and Aug 10 report zero usage.

A secondary defect makes the loss permanent. The mtime re-fetch gate added in 3.2.3 correctly marks these conversations dirty and re-fetches them; every fetch returns 500, so zero entries land — and the mtime is recorded anyway. When the session stops writing, the conversation is frozen at zero forever.

## 2. Root cause

The language server is not the source of truth. It is a reader of `~/.gemini/<install>/conversations/<id>.db`, the same files the extension can read. The extension currently caches a copy of a derived view, and inherits every limitation of the middleman.

Verified equivalence, three conversations, matched by `responseId`:

```
1d9ecd7c   207 calls matched   207 token values identical
ddcb660f   168 calls matched   168 identical
16193d7a   224 calls matched   224 identical
           599 / 599, zero discrepancies
```

## 3. Goals

1. Usage is correct regardless of which client produced it, or when.
2. No data is ever lost permanently. A missed read is retried; a successful read is never silently discarded.
3. The panel updates live during a running session.
4. The extension gets **lighter**, not heavier.
5. It works for users who are not the maintainer — no reliance on one machine's symlink layout.

## 4. Non-goals

- New visualizations (separate spec).
- Replacing the server for quota, account switching, titles or live cascade state. Those stay.
- Reading conversation *content*. Usage metadata only — see §11.
- Supporting Antigravity versions whose store schema differs from `user_version = 1`.

## 5. Architecture

```
  conversation store (source of truth)
    ~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/conversations/<id>.db
            │
            ├── conversationStore.ts   enumerate roots, resolve symlinks, dedupe by id
            ├── usageReader.ts         one conversation -> TokenEntry[]
            ├── enumMap.ts             model/provider enum -> display name
            └── watcher.ts             directory watch -> debounced change events
                        │
                        ▼
                  index.ts (orchestration)
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
      cache.ts (ledger)        verifier.ts (server cross-check, non-blocking)
            │
            ▼
      aggregator.ts -> DeepUsageStats -> sidebar / panel
```

The language server moves from the data path to two side roles: enrichment (titles, live cascade state) and verification.

### 5.1 `conversationStore.ts`

Enumerates conversations across all install roots.

- Roots: `antigravity`, `antigravity-ide`, `antigravity-cli` under `~/.gemini`. Non-existent roots are skipped.
- Each root is resolved with `fs.realpathSync` and deduplicated. On the maintainer's machine all three resolve to one directory; a normal install has three distinct ones.
- A conversation is identified by its id, not its path. If the same id appears under two roots, the file with the newest mtime wins.
- Returns `{ id, dbPath, brainPath, mtime }`, where `mtime` is `max(db, db-wal, db-shm, brain dir)` — see §7.1.

### 5.2 `usageReader.ts`

Reads one conversation and returns `TokenEntry[]`. Pure apart from the database read.

Two tables, both required:

- `gen_metadata` — the primary usage record.
- `steps.metadata` — carries usage for calls absent from `gen_metadata`. **3.3% of existing entries (125 of 3,796, across 66 conversations) come only from this source.** Reading `gen_metadata` alone loses them.

`steps.step_payload` is never read. It holds conversation content and is the bulk of the file.

Decoding uses the existing `src/shared/protobuf.ts` reader. No new dependency.

#### Field map

Path: `gen_metadata.data` → field 1 → field 4 (the usage submessage).

| Field | Meaning | Status |
|-------|------------------------|-------------------------------------------------|
| 1     | model enum             | verified — `1000 + N` ↔ `MODEL_PLACEHOLDER_MN`, 7 models |
| 2     | inputTokens            | verified — 599/599 against the server            |
| 3     | outputTokens           | verified — 599/599                                |
| 5     | cacheReadTokens        | verified — 599/599                                |
| 6     | apiProvider enum       | verified — 24 Gemini, 26 Anthropic Vertex        |
| 8     | responseHeader         | not needed                                        |
| 9     | reasoning tokens       | **assumed** — matches one sample (401); present on 2,743 of 3,796 entries |
| 10    | responseOutputTokens   | **assumed and suspect** — observed as 44 where outputTokens was 445 |
| 11    | responseId             | verified                                          |
| cache creation (write) | —        | **unknown** — never observed non-zero in Antigravity data |

Timestamp: field 1 → field 9 → field 4 → field 1, unix seconds.

**Fields marked assumed, suspect or unknown MUST be resolved by the verifier (§5.4) before their values are used in cost.** Reasoning tokens are priced and appear on 72% of entries; getting field 9 wrong understates cost materially.

### 5.3 `enumMap.ts`

Model and provider are numbers on disk, strings from the server.

1. Static seed: the `1000 + N` rule, plus observed provider values.
2. Learned: whenever the server can serve a conversation, pair its strings with the file's numbers and persist the mapping in the cache.
3. Fallback: unknown enum renders as `MODEL_UNKNOWN_<n>`, is **excluded from cost totals rather than priced at zero**, and is reported in the health card. Silent zero-cost is forbidden.

### 5.4 `verifier.ts`

For any conversation the server can also serve, decode the file and compare every field against the server's JSON.

- Runs opportunistically, never blocking a render.
- Divergence is logged and raises a flag in the health card.
- This is how the assumed fields in §5.2 get promoted to verified, and how store-format drift is caught.

### 5.5 `cache.ts` — ledger semantics

The cache stops being a scratch copy and becomes an append-oriented ledger.

- Entries for a conversation are replaced wholesale **only after a complete, successful read of both tables**. A partial read — one table unreadable, a decode error mid-file — is discarded and retried; it must never truncate an existing record. Replacement is the correct semantic because the file is the truth for that conversation, but only when the file was actually read in full.
- **Entries for conversations with no backing file are preserved, never reconciled away.** This protects the synthetic `claude-code-imported` conversation (175 entries, 12.94B tokens) and any conversation the user deletes from Antigravity later. A naive rebuild-from-disk deletes both.
- Schema version bumps migrate; they do not discard.

### 5.6 `aggregator.ts`

Two corrections, both of which change historical numbers:

- **Local-time day bucketing.** Days are currently bucketed by `ts.slice(0,10)`, which is UTC, while the activity grid uses local dates. 42 entries (1.1%) are timestamped at or after 17:00 UTC and therefore belong to the next day in ICT. The maintainer's own 01:17 and 01:39 sessions bucket into the previous day. A live "today" counter makes this immediately visible.
- **Global dedupe.** Dedupe is currently per-conversation. 7 `responseId`s already appear in more than one conversation, so those calls are double counted today. Counting sub-agent runs (§6) adds conversations that can reference the same work, so this must become global.

## 6. Sub-agent runs

Trajectories spawned by a parent session have never been counted — the server returns 500 for them. Measured: **5 conversations, 116 calls, 3.0% of all calls on disk.**

They are real spend and will be counted. The date of the change is recorded in the cache so comparisons can mark the discontinuity rather than present a phantom increase.

## 7. Live updates

### 7.1 Change detection

`fs.watch` on each resolved conversations directory. One watcher per directory, never per file. `fs.watchFile` is forbidden — it is stat polling.

**The main database file's timestamp is not trustworthy during a session.** SQLite writes land in the `-wal` sidecar and only reach the `.db` at a checkpoint. Measured mid-session: a call recorded at 14:08:17 while the `.db` still reported 14:06:44 — 92 seconds stale, with the row already readable. The brain directory was 7 minutes behind.

Freshness is therefore `max(mtime)` over `<id>.db`, `<id>.db-wal`, `<id>.db-shm` and `brain/<id>`. The 3.2.3 dirty gate must be corrected to match; it currently under-fires during live sessions.

### 7.2 Rules

| Rule | Reason |
|------|--------|
| Watcher is an optimisation; the existing periodic scan remains the guarantee | `fs.watch` coalesces and misses events, and is unreliable on network volumes |
| Debounce ~1s | SQLite emits many writes per model call |
| Re-read the whole changed conversation | measured equivalent in cost to an incremental read; removes cursor bookkeeping and drift |
| Watch only while a usage view is visible — the sidebar view resolved and shown, or the full dashboard panel open and not hidden | zero cost when not looking |
| One watching window; lock ownership follows visibility | prevents N windows duplicating work, and prevents a hidden lock-holder starving a visible window |
| **Live updates never write to disk** | the cache file is 898 KB; writing at 1 Hz would be ~54 MB/min of pointless I/O |
| Cache flushes on a slow timer, on hide, and on dispose | keeps the disk write rate at today's level |
| UI repaints capped at 1/second | the panel re-renders an HTML string |

### 7.3 Performance budget

Measured on the maintainer's store (93 conversations, 136 MB):

```
read one conversation, all rows          9.6 ms
decode 54 calls                          0.6 ms
worst case (35.8 MB conversation)       13 ms      110 usage rows
steps.metadata on that conversation      9 ms      225 KB
re-aggregate all stats                  16 ms
cache stringify + write                  3.3 ms    898 KB
```

Budget: **idle 0% CPU and one watcher per directory; ≤30 ms per debounced burst, at most once per second; disk write rate unchanged from today.**

For comparison, the path being replaced costs **241.5 ms and 3,084 KB per conversation** (137.3 ms / 701 KB metadata plus 104.2 ms / 2,383 KB steps), or roughly 20 s and 253 MB of JSON parsing on a cold boot of 84 conversations. The live design is the cheaper of the two.

## 8. Reading a database that is being written

A strict read-only open fails with `unable to open database file` when a write-ahead log is present — observed repeatedly during investigation, while the command-line tool read the same files successfully.

The reader must open in a mode that tolerates a live write-ahead log and must never write. `src/shared/db.ts` already abstracts the native module with a command-line fallback and is the only place that opens databases; the strategy is decided and tested there. On Windows there is no command-line fallback, so a missing native module must degrade to "usage unavailable, reason shown" rather than to silence.

## 9. First run must be additive

The upgrade rebuilds usage from a new source. It must be impossible for that to reduce the ledger.

1. Load the existing cache.
2. Read conversations from disk and merge by `responseId`.
3. Preserve every cached entry whose conversation has no backing file.
4. Retry every conversation currently sitting at zero entries, ignoring recorded mtimes — this recovers the 280+ stranded calls.
5. Write once, at the end.

A self-check asserts that total entries after migration is greater than or equal to before, for a fixture cache containing a file-less conversation.

## 10. Numbers will change, and we say so

Four independent causes land at once: recovered sessions, sub-agent runs, local-time bucketing, global dedupe. Users cannot distinguish that from a bug.

The health card records the changeover date and states, in one line, that counting changed and why. Comparisons spanning the date mark it.

## 11. Privacy

Only usage metadata is read: token counts, model, provider, timestamp, response id. `steps.step_payload` and the brain directory's `content.md` files are never opened. The change **reduces** exposure — it removes local network calls carrying conversation data.

## 12. Failure modes

| Failure | Behaviour |
|---------|-----------|
| Native sqlite module and command-line tool both missing | usage unavailable, reason shown in the health card. Never silent zeros |
| Database unreadable or corrupt | that conversation is skipped, flagged, retried next scan. Others unaffected |
| Unknown model enum | excluded from cost, shown as unknown, flagged |
| Store schema `user_version` unexpected | stop reading, flag loudly, keep the existing ledger |
| Watcher fails to start | fall back to the periodic scan, no user-visible change beyond latency |
| Server unreachable | no effect on usage; titles fall back to existing resolution |

A range with zero calls renders an explicit empty state naming the last activity, never a silent zero — this is what made the original failure look like a broken toggle.

## 13. Rollback

`ag-switchboard.usageSource`: `auto` (default, files) or `server` (previous behaviour). A deliberate exception to the project's no-configuration preference, justified by data-integrity risk, and to be **removed after one release with no divergence reported**.

## 14. Testing

No test framework exists; the project uses runnable self-checks (`node out/services/usage/types.js --self-check`). Extending that pattern:

- `enumMap` — the `1000 + N` rule, unknown-enum fallback, learned-pair precedence.
- `usageReader` — decodes a committed fixture blob to known values, including reasoning tokens; ignores `step_payload`.
- Merge/migration — additive guarantee from §9, including the file-less conversation case.
- Dedupe — one `responseId` in two conversations counts once.
- Bucketing — a 23:30 ICT call lands on the local day, not the UTC day.
- Freshness — `-wal` newer than `.db` marks the conversation dirty.
- `gridMode` and `isConvoDirty` self-checks continue to pass, with the blank-conversation assertion corrected: a conversation at zero entries must never be considered clean.

## 15. Phasing

**Phase 1 — correct data.** Store reader, enum map, verifier, ledger semantics, local bucketing, global dedupe, sub-agent counting, additive migration, health card, honest empty states. Ships as `3.3.0`.

**Phase 2 — live.** Watcher, visibility gating, debounce, memory-only updates, slow flush. Ships as `3.4.0`.

Phase 2 depends on Phase 1 and on no divergence reported by the verifier.

## 16. Open questions

None blocking. Two to settle during implementation:

1. Whether `steps.metadata` needs the same enum treatment as `gen_metadata`, or already carries resolved values.
2. Whether the verifier should run on every start or sample a subset once the field map is fully verified.
