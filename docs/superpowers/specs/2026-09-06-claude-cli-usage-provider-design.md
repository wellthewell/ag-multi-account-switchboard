# Claude CLI as a tracked provider — design

**Status:** proposed
**Date:** 2026-09-06
**Scope:** Account discovery, usage ingestion, and per-account attribution for Claude Code (`claude` CLI). Observe-only. Switching Claude accounts is out of scope.

---

## 1. Problem

The extension tracks one agent tool. The machine runs two.

Claude Code usage is invisible to the panel with one exception: a hand-made import from 2026-08-14 that sits in the ledger as the synthetic conversation `claude-code-imported`. That import is frozen, unattributed, and lossy:

```
175 entries, 12.94B tokens, 2026-01-22 → 2026-07-21
responseId  = cc-<model>-<date>        one row per model per DAY
reasoning   = 0 on every row           thinking tokens dropped at import
calls       = 175 (aggregator.ts:123)  counts entries, so six months reads as 175 calls
```

The call count is the clearest symptom. `aggregator.ts` increments `calls` once per `TokenEntry`, and the import collapsed every call in a day into one entry — so the panel reports 175 calls for a period that actually contained roughly 24,000.

Meanwhile the real data is on disk and complete. Claude Code writes one JSONL transcript per session under `~/.claude/projects/<slug>/<sessionId>.jsonl`, and every assistant message carries a full `usage` block. Measured 2026-09-06:

```
transcripts           191 files, 403 MB
usage blocks           12,034
unique requests         5,255   (deduped by requestId)
duplicate rows          6,694   replays across resumed sessions and sidechains
calls per prompt        mean 5.11   median 3   p90 11   max 61
calls ending in tool    82.5%
```

None of it is counted.

## 2. What the transcripts contain

Per-request `usage`, with strictly more detail than `TokenEntry` currently models:

```
input_tokens                                  12034
output_tokens                                 12034
cache_read_input_tokens                       12034
cache_creation_input_tokens                   12034
output_tokens_details.thinking_tokens          8513
cache_creation.ephemeral_5m_input_tokens      12034
cache_creation.ephemeral_1h_input_tokens      12034
server_tool_use.web_search_requests           12011
server_tool_use.web_fetch_requests            12011
service_tier / inference_geo / iterations / speed
```

One assistant turn spans 1–8 JSONL rows sharing a `requestId` (thinking, text and `tool_use` blocks are separate rows). **`requestId` is the unit of one API call**, and the dedupe key.

## 3. Goals

1. Claude usage is counted per call, not per day.
2. Every usage row carries the account that produced it.
3. Claude and Antigravity totals are shown side by side, never summed into one headline.
4. Existing Antigravity numbers do not move.
5. No Claude credential or config file is ever written.

## 4. Non-goals

- Switching the active Claude account. Read-only, permanently in this spec.
- Linking a Claude account to a Google account (a "persona" join table). Deferred; see §12.
- Reading conversation *content*. Usage metadata and account identity only.
- Recovering thinking tokens for the archive era. The source transcripts no longer exist.
- Cost estimation for Claude. `litellmPricing.ts` may already cover the model ids; verifying that is separate work.

## 5. Decisions

Settled during design, recorded so the plan does not relitigate them:

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | Per-provider identity. A Claude row carries a Claude account; an Antigravity row carries a Google account. Nothing links them. | A user-maintained persona join table (superset, no rework cost to add later). |
| 2 | One ledger, one cache file, totals **partitioned by provider** in the aggregator. | A separate cache + panel tab (duplicates aggregator, delta detection, rendering). |
| 3 | Observe only. | Switching Claude accounts via keychain writes. |
| 4 | Backlog attribution by pinned known eras, validated against `accountCreatedAt`. | A general timeline reconstructor parsing every dated `.claude.json` backup. |

## 6. Token semantics — the one correctness trap

`aggregator.ts:362` computes:

```ts
const totalTokens = totalIn + totalOut + totalCa + totalCaW + totalReas;
```

`reasoning` is **additive**. That is correct for Gemini, where thinking is a disjoint bucket — measured on the existing cache:

```
provider                      entries   out>0   reas>0   both>0     sum out   sum reasoning
API_PROVIDER_GOOGLE_GEMINI       4998    4997     4005     4005    2,989,168     1,215,033
anthropic (the import)            175     175        0        0   91,165,499             0
```

Claude inverts this. `output_tokens_details.thinking_tokens` is a **breakdown of** `output_tokens`, not an addend. Verified across every sample that has the field:

```
samples 8,513    thinking > output violations 0    thinking == output 0
sum output 14,851,469    sum thinking 6,510,886    ratio 43.8%
```

Writing `thinking` into `reasoning` unchanged would inflate every Claude row by 43.8% of its output.

**Resolution — normalize at ingestion:**

```ts
const thinking = u.output_tokens_details?.thinking_tokens ?? 0;

out:       u.output_tokens - thinking,   // visible output only
reasoning: thinking,                     // disjoint, matches Gemini
```

`out + reasoning === output_tokens`, so the existing additive formula is correct with **zero changes to `aggregator.ts`**. Both providers then mean the same thing by both fields, and `daily`, `hourly`, `models`, `weekday`, `monthly` and `usageTotal()` stay correct for free.

Rejected: a provider-aware sum. That conditional would need replicating in all eight places that total tokens; missing one produces a silently wrong number with no failing test.

**Invariant.** The reader asserts `thinking <= output_tokens` per entry and skips the entry with a warning if violated. This is the assumption the normalization rests on, and the one that would rot silently if the field's meaning changed upstream. It gets a self-check case in `types.ts` alongside the existing ones.

**Archive consequence.** The import keeps `out = full output_tokens, reasoning = 0`. That is arithmetically correct under this scheme, but its `reasoning: 0` means *unknown*, not *zero*. Since the archive is exactly one conversation id, the panel labels `claude-code-imported` as "thinking not broken out" rather than the schema growing a nullable field for one known row.

## 7. Account identity

Claude Code stores the active account in `~/.claude.json` under `oauthAccount`:

```json
{ "accountUuid": "...", "emailAddress": "...", "organizationUuid": "...",
  "billingType": "stripe_subscription", "seatTier": "team_tier_1",
  "accountCreatedAt": "2026-07-26T19:18:37Z" }
```

Only the *current* account — it is overwritten on switch. **Transcripts carry no account stamp**, verified by grepping all 191 files for `accountUuid` / `organizationUuid` / `emailAddress` (zero hits; the single match was this design session's own tool output).

So: rows ingested from now on are stamped exactly, by reading `oauthAccount` at read time. Historical rows need inference.

### 7.1 The account timeline

The dated `.claude.json` backups happen to record account history:

```
well.j@honestdocs.co           account 348cc96d-a86f-4963-9db5-bf1da5ba879a
                               org     c7a3268b-57c7-4a9b-9db0-5d1292cface4
                               created 2025-08-13   last seen in a backup 2026-06-18

varakorn.j@topgunthailand.com  account 49a38d72-c70f-4169-bcf3-bf7f31a5b8f7
                               org     45ef9fdf-86a0-4957-a97a-6856cb1e873b
                               created 2026-07-26   first seen in a backup 2026-07-30
```

This maps cleanly onto the two data eras: the archive (Jan 22 – Jul 21) is `well.j`; the transcript era is `varakorn.j`. Note the transcript era begins **2026-07-30 by content timestamp**, though the earliest transcript *file mtime* is Aug 5 — attribution must key on the row's `timestamp`, never the file's mtime. Jul 30 falls after `accountCreatedAt` (Jul 26), so the guard in §7.2 is satisfied with four days to spare.

### 7.2 Pinned eras, with a boundary guard

Per decision 4, two constants rather than a general reconstructor:

```ts
// Backlog only. Rows read after this feature ships are stamped live from oauthAccount.
const WELL     = { email: 'well.j@honestdocs.co',          uuid: '348cc96d-a86f-4963-9db5-bf1da5ba879a', createdAt: '2025-08-13' };
const VARAKORN = { email: 'varakorn.j@topgunthailand.com', uuid: '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7', createdAt: '2026-07-26' };

const PINNED_ERAS = [
  { convoId: 'claude-code-imported', account: WELL     },  // rule 1
  { before:  '2026-07-26',           account: WELL     },  // rule 2
  { from:    '2026-07-26',           account: VARAKORN },  // rule 3
];
```

**Precedence is first-match, in the order written.** A `convoId` rule beats a date rule, so the archive resolves by identity rather than by its row dates — which matters because its rows span Jan–Jul and would otherwise be split across rule 2 and rule 3.

The guard is `accountCreatedAt`: a row dated before an account existed can never be attributed to it, even if a rule says otherwise. A row that matches no rule, or matches one the guard rejects, is stamped `unknown` and rendered as such — never silently folded into the active account.

Rule 2 is defensive. No transcript on this machine predates 2026-07-30, so it currently matches nothing; it exists so that recovering an older transcript later cannot misattribute it to `varakorn.j`.

### 7.3 Discovering accounts

"Every account on the computer" needs care, because the honest finding is that this machine has **one** Claude config root. `~/.claude-science` is a different tool (`operon-cli`) — no `projects/`, no `.claude.json`, no `history.jsonl`.

**The identity file moves depending on how the root was configured.** Verified 2026-09-06 against Claude Code 2.1.263 by running `CLAUDE_CONFIG_DIR=<tmp> claude mcp list`:

```
default layout    ~/.claude/          projects/        identity at ~/.claude.json      (ADJACENT, sibling of the root)
CLAUDE_CONFIG_DIR <dir>/              projects/        identity at <dir>/.claude.json  (INSIDE the root)
                  <dir>/backups/                       also created
```

Discovery must therefore try `<root>/.claude.json` **then** `<root>/../.claude.json`. Assuming either one alone misses half the cases.

**A valid root may have no identity at all.** The freshly created root's `.claude.json` contained only `firstStartTime`, `firstStartVersion`, `machineID`, `migrationVersion`, `userID`, and migration flags — **no `oauthAccount`**. That key is written on login, not on init. So "root exists, account unknown" is a legitimate state, not corruption.

`userID` and `machineID` are **not** usable as account keys: the fresh root was assigned its own new `userID`, so they identify a config dir, not a person. `oauthAccount.accountUuid` is the only stable account identifier.

Discovery therefore enumerates config roots, never credentials:

1. `CLAUDE_CONFIG_DIR` if set, else `~/.claude`.
2. A root is valid if it contains `projects/`. Resolve identity by trying `<root>/.claude.json`, then `<root>/../.claude.json`.
3. Each root yields at most one *currently active* account, or `unknown`. Historical accounts come from §7.2.
4. Deduplicate roots by `accountUuid` where present, by realpath otherwise.

Designed for N roots, expected to find one. No credential access, no keychain reads — see §12 for why the second keychain entry is not an account.

## 8. Architecture

```
  ~/.claude/projects/<slug>/<sessionId>.jsonl        (source of truth, append-only)
  ~/.claude.json → oauthAccount                      (identity)
            │
            ├── claudeAccounts.ts   enumerate roots -> ClaudeAccount[]
            ├── claudeReader.ts     one transcript -> TokenEntry[]   (dedupe by requestId)
            └── claudePins.ts       backlog era attribution + accountCreatedAt guard
                        │
                        ▼
        cache.ts  mergeIntoLedger      (unchanged — already preserves fileless convos)
        aggregator.ts                  (+ provider partition, + account facet)
        usageStatsPanel.ts             (+ provider split, + account column)
```

New files live in `src/services/usage/claude/`, mirroring the existing `store/` layout. `claudeReader.ts` has no dependency on `ServerInfo` — Claude ingestion is pure filesystem, so it runs even when no language server is reachable.

### 8.1 Ledger keys

One ledger entry per Claude session, keyed `claude:<sessionId>`. The prefix keeps the Claude and Antigravity id spaces from ever colliding, and makes a provider filter a string test rather than a lookup.

**The archive is the exception and must stay one.** It is already keyed `claude-code-imported`, with no prefix. Renaming it would orphan it — `mergeIntoLedger` preserves entries by key, so a rename reads as "old key deleted, new key added" and the old key has no backing file to re-read from. It keeps its legacy id forever. Consequently the provider test is:

```ts
const isClaude = (cid: string) => cid.startsWith('claude:') || cid === 'claude-code-imported';
```

That literal is load-bearing, not a nicety. It belongs in one exported helper, not inlined at each call site.

`TokenEntry.responseId = requestId`. `entryFingerprint()` already returns `rid:${e.responseId}` when present, so cross-session replay dedupe — 6,694 duplicate rows on current data — comes free from the existing sanitizer.

### 8.2 Schema change

`TokenEntry` gains one optional field:

```ts
accountKey?: string;   // provider-scoped account id; absent = unknown
```

`DeepUsageStats` gains a provider partition and an account facet. `totalTokens` and friends stay for backward compatibility but the panel stops rendering them as a single headline (§10).

`CACHE_SCHEMA_VERSION` goes 2 → 3. `cache.read()` already returns `null` on a version mismatch, which forces a clean rebuild — acceptable for Antigravity data (re-read from the store) but **not** for the archive, which has no source. The migration must therefore carry `claude-code-imported` across the version bump explicitly; a plain bump silently destroys 12.94B tokens.

### 8.3 Delta strategy

Transcripts are append-only, so the existing mtime machinery applies: `mtimes[claude:<sessionId>]` skips unchanged files. A changed file is re-parsed in full and deduped by `requestId` — cheaper to implement than byte offsets and correct by construction. Byte-offset tailing is the upgrade path if the full-reparse budget (§9) is ever exceeded.

## 9. Performance budget

Current corpus is 403 MB across 191 files, but a refresh only parses files whose mtime moved — in a normal session, one.

| Case | Budget |
|------|--------|
| Cold rebuild, whole corpus | < 15 s, off the UI thread, once |
| Warm refresh, one active session file | < 250 ms |
| Warm refresh, nothing changed | < 20 ms (mtime stat only) |

The reader must stream line-by-line, never `readFileSync` a transcript whole — the largest active files reach tens of megabytes.

## 10. Panel

Per decision 2, the hero number stops being one figure. The panel shows a per-provider row set, each with its own totals, and an account facet beneath:

Measured figures, for the shape of the thing (2026-09-06):

```
Claude Code                     15.04B                       2 accounts
  varakorn.j@topgunthailand.com  2.09B    5,255 calls   Jul 30 – today
  well.j@honestdocs.co          12.94B    — (est. 24K)  Jan 22 – Jul 21  ⚠ day rollup, thinking not broken out
Antigravity                      0.53B    5,151 calls   105 conversations
```

The proportion is worth noticing: Claude is ~28× the token volume of Antigravity on this machine, while having a comparable call count. A single summed headline would have been ~97% Claude and told you nothing about either tool — which is the concrete reason decision 2 went the way it did.

Two honesty markers are required, not optional:

- The archive's call count is a **day-rollup artifact**, not a call count. It renders as an estimate or as `—`, never as `175`.
- `countingChangedAt` already exists to mark "totals before and after are not comparable". Claude ingestion sets it, because Claude totals appear where there were none.

## 11. Failure modes

| Failure | Behaviour |
|---------|-----------|
| `.claude.json` missing, unparseable, or lacking `oauthAccount` | Discovery yields no active account; ingestion still runs, rows stamped `unknown`. The third case is normal for a never-logged-in root (§7.3), not an error, and must not log as one. |
| Identity file in the unexpected position | Try `<root>/.claude.json` then `<root>/../.claude.json`. Only after both miss is the account `unknown`. |
| A model id resolves to no pricing | Render the row with tokens and calls, cost suppressed. Never render cost as `$0.00`. |
| A transcript line is truncated mid-write | Skip that line, continue. Never abort a file for one bad line. |
| `thinking > output_tokens` | Skip the entry, warn once per file. Invariant violated (§6). |
| Schema bump loses the archive | Guarded by an explicit migration test (§13) asserting 175 entries / 12.94B survive 2→3. |
| Two roots report the same `accountUuid` | Deduplicate by `accountUuid`, not by root path. |
| `usage` block absent on an assistant row | Normal — it is a content-block continuation row. Not an error. |

## 12. Resolved questions

All three blocking questions were settled by test on 2026-09-06 against Claude Code 2.1.263. Findings are folded into §7.3 and §12.3; recorded here so the reasoning is not lost.

### 12.1 Identity file location — RESOLVED

`.claude.json` sits **inside** the root when `CLAUDE_CONFIG_DIR` is set, **adjacent** to it in the default layout. Both must be tried. A fresh root has no `oauthAccount`. See §7.3 for the full result and its consequences.

### 12.2 The `-69ff85f3` keychain entry — NOT AN ACCOUNT

It is a dead artifact, and discovery must ignore it. Evidence:

```
Claude Code-credentials            cdat 2026-07-27 02:28:44   mdat 2026-09-06 15:58:40   (live, refreshed)
Claude Code-credentials-69ff85f3   cdat 2026-07-20 09:11:44   mdat 2026-07-20 09:11:49   (5s lifespan, then never)
```

Created and last modified five seconds apart on Jul 20, untouched for seven weeks since. The unsuffixed entry was created Jul 27 — the day after `varakorn.j`'s account — and is refreshed live. The suffix matched none of 40 hash combinations (md5/sha1/sha256/sha512 over ten candidate paths, emails, account and org UUIDs), and creating a fresh config root did **not** produce a new keychain entry, so the suffix is not a per-root hash written at init.

Conclusion: a one-off from the `well.j` era, most likely an abandoned login attempt. **Enumerating keychain entries would report a phantom account.** Config roots are the only account source. The suffix scheme remains unexplained and is immaterial to this design.

### 12.3 Pricing coverage — RESOLVED, one fix needed

Replicating `normalize()`, `buildAliases()` and `resolveLiteLlmPricing()` against the live LiteLLM catalog (3,818 entries) over the ten Claude model ids present in the data: **9 of 10 resolve exactly.**

```
claude-opus-4-8 / 4-7 / 4-6 / opus-5      exact    $5.00 / $25.00 per Mtok
claude-sonnet-4-6 / sonnet-4-5-20250929   exact    $3.00 / $15.00
claude-sonnet-5                           exact    $2.00 / $10.00
claude-haiku-4-5-20251001                 exact    $1.00 /  $5.00
claude-fable-5-1                          exact   $10.00 / $50.00
fable-5                                   *** UNRESOLVED ***
```

`fable-5` is the bare id, missing the vendor prefix; the catalog has `claude-fable-5`. It carries **320.8M tokens** in the archive, so it is not negligible. Fix is one line in `normalize()` or a lookup alias: bare `fable-*` → `claude-fable-*`. This belongs in `feat/claude-panel` alongside cost rendering, with a test asserting all ten ids resolve.

## 12.4 Deferred

**Persona linking** (Claude ↔ Google account) — decision 1. Additive when wanted: a nullable `personaId` plus a settings pane, no migration.

## 13. Testing

Following the existing `types.ts` self-check pattern — `assert`-based, runnable under plain Node, no framework:

1. **Thinking subset invariant** — a synthetic entry with `thinking > output` is skipped; one with `thinking <= output` normalizes to `out + reasoning === output_tokens`.
2. **requestId dedupe** — the same `requestId` across two rows and two files yields one `TokenEntry`.
3. **Multi-row turn** — 8 rows sharing a `requestId` (thinking + text + tool_use) collapse to one call.
4. **Archive survives the schema bump** — load a v2 fixture containing `claude-code-imported`, migrate to v3, assert 175 entries and 12,942,976,240 total tokens.
5. **Pinned-era guard** — a row dated before `accountCreatedAt` is never attributed to that account; it resolves to the earlier era or `unknown`.
6. **Provider partition** — a ledger with both providers produces separate totals and never one summed headline.
7. **Pricing resolution** — all ten Claude model ids in §12.3 resolve, `fable-5` included. Guards the prefix normalization against a future catalog rename.
8. **Identity file discovery** — a root with the identity file inside resolves; a root with it adjacent resolves; a root with neither yields `unknown` without logging an error.

Test 4 is the one that protects irreplaceable data and should be written first.

## 14. Phasing — three stacked branches

Each branch is independently reviewable and merges in order. The split follows the schema dependency, not the roadmap numbering: identity is foundation work, because ingestion cannot stamp a field that does not exist.

**`feat/claude-foundation`** — schema and identity, no ingestion.
`TokenEntry.accountKey`, `CACHE_SCHEMA_VERSION` 2→3 with the archive-preserving migration, `claudeAccounts.ts`, `claudePins.ts`. Tests 4 and 5. Nothing user-visible; existing numbers must not move.

**`feat/claude-ingest`** — the reader.
`claudeReader.ts`, ledger keys, mtime delta, the thinking normalization and its invariant. Tests 1, 2, 3. Claude data now lands in the ledger; the panel may render it crudely.

**`feat/claude-panel`** — presentation.
Provider partition in `aggregator.ts`, account facet, per-provider totals, the two honesty markers. Test 6.

Roadmap mapping: item 1 spans foundation + ingest, item 2 is mostly panel, item 3 is foundation.

## 15. Rollback

Each branch reverts independently. Reverting `feat/claude-foundation` reverts the schema, which discards Claude rows — the archive survives because it predates the change and is preserved by `mergeIntoLedger`. Take a copy of `.deep_stats_cache.json` before the first v3 write regardless; it is the only home of the archive.

## 16. Privacy

Transcript *content* is never read — the reader consumes `message.usage`, `message.model`, `requestId`, `timestamp` and `type`, and ignores content blocks except to detect a `tool_use` type. No credential store is read. Account identity is limited to email, `accountUuid`, `organizationUuid` and `seatTier`, all already on disk in plaintext.
