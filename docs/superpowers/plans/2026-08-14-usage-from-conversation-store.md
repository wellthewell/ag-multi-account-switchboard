# Usage From The Conversation Store — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read token usage directly from Antigravity's conversation store so usage is correct regardless of which client produced it or when, and demote the language server to enrichment and cross-checking.

**Architecture:** Four new modules under `src/services/usage/store/` read `conversations/<id>.db` and produce the existing `TokenEntry[]` shape, reusing `extractTokens()` and `getModelDisplayName()` so interpretation cannot drift from the current path. `index.ts` orchestrates as before; the cache becomes an append-oriented ledger; the aggregator gains local-day bucketing and global dedupe.

**Tech Stack:** TypeScript, VS Code extension host (CommonJS), `@vscode/sqlite3` native module with `sqlite3` command-line fallback, the repo's dependency-free protobuf reader. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-usage-from-conversation-store-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **NR1 — Additive first run.** "Entries for conversations with no backing file are preserved, never reconciled away." It must be impossible for the upgrade to reduce the ledger.
- **NR2 — Both tables.** `gen_metadata` **and** `steps.metadata`. 3.3% of existing entries (125 of 3,796, across 66 conversations) come only from the steps source.
- **NR3 — Local-time day bucketing.** Days are bucketed by local date, not UTC.
- **NR4 — Global dedupe** by `responseId`, not per-conversation.
- **NR5 — No *suspect* or *unknown* field feeds cost.** Field 10 (observed as 44 where output was 445) and any unrecognised enum stay out of cost entirely. Fields marked *assumed* — currently field 9, reasoning — are used, because holding them at zero would understate cost on 72% of entries, which is worse than the risk. **Release gate: 3.3.0 does not ship until Task 9's verifier confirms field 9 against real calls.** (Ruled 2026-08-14; NR5 originally barred assumed fields too, which contradicted Task 3.)
- **NR6 — `steps.step_payload` is never read.** Usage metadata only. Content is never opened.
- **NR7 — Partial reads never truncate.** Replacement of a conversation's entries happens only after a complete, successful read of both tables.
- **Zero new dependencies.** Protobuf decoding uses `src/shared/protobuf.ts`; database access goes through `src/shared/db.ts`.
- **Unknown model enums are excluded from cost, never priced at zero.** Silent zero-cost is forbidden.

## Verified field map

Path: `gen_metadata.data` → field 1 → field 4 (the usage submessage).

| Field | Meaning | Status |
|-------|---------------------|-------------------------------------------------|
| 1     | model enum          | verified — `1000 + N` ↔ `MODEL_PLACEHOLDER_MN`  |
| 2     | inputTokens         | verified — 599/599 against the server            |
| 3     | outputTokens        | verified — 599/599                                |
| 5     | cacheReadTokens     | verified — 599/599                                |
| 6     | apiProvider enum    | verified — 24 Gemini, 26 Anthropic Vertex        |
| 9     | reasoning tokens    | assumed — one sample (401); on 2,743 of 3,796 entries |
| 10    | responseOutputTokens| assumed and suspect — seen as 44 where output was 445 |
| 11    | responseId          | verified                                          |

Timestamp: field 1 → field 9 → field 4 → field 1, unix seconds.

## File structure

| File | Responsibility |
|------|----------------|
| `src/shared/db.ts` (modify) | add multi-row, path-generic reads |
| `src/services/usage/store/enumMap.ts` (create) | model/provider enum ↔ name, learned pairs |
| `src/services/usage/store/usageReader.ts` (create) | one conversation → `TokenEntry[]` |
| `src/services/usage/store/conversationStore.ts` (create) | enumerate roots, dedupe, freshness |
| `src/services/usage/store/verifier.ts` (create) | cross-check file decode against the server |
| `src/services/usage/aggregator.ts` (modify) | local-day bucketing, global dedupe |
| `src/services/usage/cache.ts` (modify) | ledger semantics |
| `src/services/usage/index.ts` (modify) | orchestration; files primary |
| `src/services/usage/types.ts` (modify) | self-check host (existing pattern) |

**Testing pattern:** this repo has no test framework. It uses runnable self-checks executed as `node out/services/usage/types.js --self-check`. Every task below extends that single entry point. Build with `npm run compile:extension` before running a self-check.

---

### Task 1: Multi-row, path-generic database reads

`db.ts` currently exposes only `dbGet`/`dbQuery`, both hardcoded to `state.vscdb`. Worse, the two backends disagree: `nativeQuery` uses `db.get()` and returns **one row, first column only**, while `cliQuery` shells out and returns **all rows**. A conversation reader needs all rows from an arbitrary database, with both backends behaving identically.

**Files:**
- Modify: `src/shared/db.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `dbAllAt(dbPath: string, sql: string): Promise<string[][] | null>` — resolves to an array of rows, each an array of column values as strings; `null` when no backend is available or the read fails.

- [ ] **Step 1: Write the failing self-check**

The fixture below is deliberately minimal; **it is not sufficient on its own.** The test must also use multi-character values including one containing a space, select at least one blob column as `quote(...)` and assert it matches `/^X'[0-9A-F]+'$/`, and call `cliAll` directly rather than only through `dbAllAt` — which prefers the native backend and would otherwise leave the fallback untested. Single-character fixture data cannot detect a delimiter bug, which is exactly how one shipped here under a passing self-check. If `sqlite3` is absent from the environment, skip the fallback assertions with a printed note saying so; a silent skip is worse than no test.

Append inside the existing `--self-check` block in `src/services/usage/types.ts`, before the final `console.log`:

```typescript
    // ─── dbAllAt: multi-row reads from an arbitrary database ───
    const { dbAllAt } = require('../../shared/db');
    const os = require('os'); const fsm = require('fs'); const pathm = require('path');
    const tmpDb = pathm.join(os.tmpdir(), 'ag-switchboard-selfcheck.db');
    try { fsm.unlinkSync(tmpDb); } catch { /* absent is fine */ }
    require('child_process').execSync(
        `sqlite3 "${tmpDb}" "create table t(a,b); insert into t values(1,'x'),(2,'y'),(3,'z');"`,
    );
    const rows = await dbAllAt(tmpDb, 'select a, b from t order by a');
    assert.strictEqual(rows.length, 3, 'dbAllAt returns every row, not just the first');
    assert.strictEqual(rows[0][0], '1', 'first column of first row');
    assert.strictEqual(rows[2][1], 'z', 'second column of last row');
    assert.strictEqual(await dbAllAt(pathm.join(os.tmpdir(), 'does-not-exist.db'), 'select 1'), null,
        'missing database resolves null rather than throwing');
    fsm.unlinkSync(tmpDb);
    console.log('dbAllAt: all checks passed');
```

The self-check block must become `async`. Change its opening from a bare `if (...) {` body to an immediately-invoked async function:

```typescript
if (require.main === module && process.argv.includes('--self-check')) {
    void (async () => {
        // ...existing assertions unchanged...
    })();
}
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `TypeError: dbAllAt is not a function`.

- [ ] **Step 3: Implement `dbAllAt`**

Add to `src/shared/db.ts`, after the existing `dbQuery`:

```typescript
/**
 * Read every row of an arbitrary database.
 *
 * dbQuery() is single-row and state.vscdb-only. Reading a conversation store
 * needs all rows from a path the caller chooses, and needs both backends to
 * agree — the native path uses db.get() (one row) while the CLI path returns
 * all of them, so they cannot share an implementation.
 *
 * Blob columns should be selected as quote(col); the CLI backend has no other
 * way to round-trip binary, and the native backend returns a Buffer which is
 * normalised to the same X'..' hex form here.
 */
export async function dbAllAt(dbPath: string, sql: string): Promise<string[][] | null> {
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    const native = await nativeAll(dbPath, sql);
    if (native !== undefined) return native;
    return cliAll(dbPath, sql);
}

function toCell(v: any): string {
    if (v === null || v === undefined) return '';
    if (Buffer.isBuffer(v)) return `X'${v.toString('hex').toUpperCase()}'`;
    return String(v);
}

function nativeAll(dbPath: string, sql: string): Promise<string[][] | null | undefined> {
    return new Promise((resolve) => {
        const sqlite3 = getNativeModule();
        if (!sqlite3) { resolve(undefined); return; }
        // Not OPEN_READONLY: a live write-ahead log needs the shared-memory
        // file, and a strict read-only open fails with "unable to open
        // database file" while a session is running. Nothing here writes.
        const db = new sqlite3.Database(dbPath, (err: any) => {
            if (err) { resolve(undefined); return; }
            db.all(sql, (err2: any, rows: any[]) => {
                db.close();
                if (err2) { resolve(undefined); return; }
                resolve((rows || []).map(r => Object.keys(r).map(k => toCell(r[k]))));
            });
        });
    });
}

function cliAll(dbPath: string, sql: string): Promise<string[][] | null> {
    return new Promise((resolve) => {
        try {
            const cp = require('child_process');
            // ASCII unit separator, not an empty one. An empty separator
            // concatenates the columns and leaves nothing to split on, so
            // splitting the result explodes every multi-character value into
            // single characters. Relies on values containing neither the
            // separator nor a newline, which holds for every query this serves:
            // quote()-wrapped blobs are hex, everything else is an integer.
            cp.execFile('sqlite3', ['-separator', '\x1f', dbPath, sql],
                { timeout: CONVERSATION_READ_TIMEOUT_MS, maxBuffer: CONVERSATION_READ_MAX_BUFFER },
                (err: any, stdout: string) => {
                    if (err) { resolve(null); return; }
                    const text = stdout.replace(/\n$/, '');
                    if (!text) { resolve([]); return; }
                    resolve(text.split('\n').map(line => line.split('\x1f')));
                });
        } catch { resolve(null); }
    });
}
```

Add the two constants beside the existing `TIMEOUT` and `MAX_BUFFER`:

```typescript
// Conversation stores are larger than state.vscdb and hex-encoded blobs
// double in size, so the shared 10 MB / 5 s limits are too tight.
const CONVERSATION_READ_TIMEOUT_MS = 15000;
const CONVERSATION_READ_MAX_BUFFER = 128 * 1024 * 1024;
```

`execFile` is used rather than `exec` so the path and SQL are passed as arguments and never go through a shell.

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `dbAllAt: all checks passed`, and the pre-existing `isConvoDirty` and `gridMode` lines still pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/db.ts src/services/usage/types.ts
git commit -m "feat(db): multi-row reads from an arbitrary database

dbQuery is single-row and state.vscdb-only, and the two backends disagree:
nativeQuery uses db.get() while cliQuery returns every row. Reading a
conversation store needs all rows from a caller-chosen path with both
backends agreeing. Opens without OPEN_READONLY because a strict read-only
open fails when a live write-ahead log is present; nothing here writes."
```

---

### Task 2: Enum map and unknown-model cost exclusion

Model and provider are numbers on disk and strings from the server. Unknown numbers must never be silently priced at zero.

**Files:**
- Create: `src/services/usage/store/enumMap.ts`
- Modify: `src/shared/usage-components.ts` (cost exclusion)
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `modelNameFromEnum(n: number, learned?: Record<number, string>): string`
  - `providerNameFromEnum(n: number, learned?: Record<number, string>): string`
  - `isUnknownEnumName(name: string): boolean`
  - `UNKNOWN_MODEL_PREFIX = 'MODEL_UNKNOWN_'`

- [ ] **Step 1: Write the failing self-check**

Append inside the self-check block in `src/services/usage/types.ts`:

```typescript
    // ─── enum map ───
    const { modelNameFromEnum, providerNameFromEnum, isUnknownEnumName } =
        require('./store/enumMap');
    assert.strictEqual(modelNameFromEnum(1073), 'MODEL_PLACEHOLDER_M73', '1000 + N rule');
    assert.strictEqual(modelNameFromEnum(1026), 'MODEL_PLACEHOLDER_M26', '1000 + N rule, second sample');
    assert.strictEqual(modelNameFromEnum(4242), 'MODEL_UNKNOWN_4242', 'unknown enum is named, not guessed');
    assert.ok(isUnknownEnumName('MODEL_UNKNOWN_4242'), 'unknown names are detectable');
    assert.ok(!isUnknownEnumName('MODEL_PLACEHOLDER_M73'), 'known names are not flagged');
    assert.strictEqual(modelNameFromEnum(4242, { 4242: 'MODEL_CLAUDE_9_OPUS' }), 'MODEL_CLAUDE_9_OPUS',
        'a learned pair beats the unknown fallback');
    assert.strictEqual(providerNameFromEnum(24), 'API_PROVIDER_GOOGLE_GEMINI', 'seeded provider');
    assert.strictEqual(providerNameFromEnum(26), 'API_PROVIDER_ANTHROPIC_VERTEX', 'seeded provider');
    assert.strictEqual(providerNameFromEnum(99), 'API_PROVIDER_UNKNOWN_99', 'unknown provider is named');

    // unknown models must not be priced
    const { calculateTotalCost } = require('../../shared/usage-components');
    const priced = calculateTotalCost([{ displayName: 'Claude Opus 4.8', input: 1e6, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 }]);
    assert.ok(priced > 0, 'a known model is priced');
    const unpriced = calculateTotalCost([{ displayName: 'MODEL_UNKNOWN_4242', input: 1e6, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 }]);
    assert.strictEqual(unpriced, 0, 'an unknown model contributes no cost');
    console.log('enumMap: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `Cannot find module './store/enumMap'`.

- [ ] **Step 3: Implement `enumMap.ts`**

```typescript
/**
 * Model and provider identifiers are enums on disk and strings from the
 * language server. Placeholder models follow 1000 + N (verified across
 * M20, M26, M71, M72, M73, M132, M187). Anything else must be learned from
 * the server, and until it is, must be visibly unknown rather than guessed.
 */

export const UNKNOWN_MODEL_PREFIX = 'MODEL_UNKNOWN_';
export const UNKNOWN_PROVIDER_PREFIX = 'API_PROVIDER_UNKNOWN_';

/** Providers observed paired with their server-side names. */
const PROVIDER_SEED: Record<number, string> = {
    24: 'API_PROVIDER_GOOGLE_GEMINI',
    26: 'API_PROVIDER_ANTHROPIC_VERTEX',
};

export function modelNameFromEnum(n: number, learned?: Record<number, string>): string {
    const known = learned?.[n];
    if (known) return known;
    if (n > 1000 && n < 2000) return `MODEL_PLACEHOLDER_M${n - 1000}`;
    return `${UNKNOWN_MODEL_PREFIX}${n}`;
}

export function providerNameFromEnum(n: number, learned?: Record<number, string>): string {
    return learned?.[n] || PROVIDER_SEED[n] || `${UNKNOWN_PROVIDER_PREFIX}${n}`;
}

export function isUnknownEnumName(name: string): boolean {
    return name.startsWith(UNKNOWN_MODEL_PREFIX) || name.startsWith(UNKNOWN_PROVIDER_PREFIX);
}
```

- [ ] **Step 4: Exclude unknown models from cost**

In `src/shared/usage-components.ts`, inside `calculateTotalCost`, skip unknown models. Add at the top of the loop body:

```typescript
    for (const m of models) {
        // An unrecognised model has no rate. Pricing it at zero would understate
        // cost silently; the health card reports these instead.
        if (m.displayName && m.displayName.startsWith('MODEL_UNKNOWN_')) continue;
        const p = matchPricing(m.displayName);
```

The prefix is repeated as a literal rather than imported: `usage-components.ts` is bundled for the browser webview and `enumMap.ts` is extension-host only.

- [ ] **Step 5: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `enumMap: all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add src/services/usage/store/enumMap.ts src/shared/usage-components.ts src/services/usage/types.ts
git commit -m "feat(usage): model and provider enum map, unknown models excluded from cost

Placeholder models follow 1000 + N, verified across seven. Anything else is
named MODEL_UNKNOWN_<n> and contributes no cost, because pricing an
unrecognised model at zero understates spend without saying so."
```

---

### Task 3: Read usage from `gen_metadata`

**Files:**
- Create: `src/services/usage/store/usageReader.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `dbAllAt` (Task 1); `modelNameFromEnum`, `providerNameFromEnum` (Task 2).
- Produces:
  - `decodeGenMetadataBlob(buf: Buffer, learned?: LearnedEnums): TokenEntry | null`
  - `type LearnedEnums = { models?: Record<number, string>; providers?: Record<number, string> }`
  - `readGenMetadata(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null>` — `null` means the read failed and the caller must not treat it as "no usage".

- [ ] **Step 1: Write the failing self-check**

The test builds a synthetic blob with the repo's own protobuf encoders rather than committing a binary fixture, so it stays readable and depends on no user data. Real-blob validation is the verifier's job in Task 9.

Append inside the self-check block in `src/services/usage/types.ts`:

```typescript
    // ─── usageReader: decode one gen_metadata blob ───
    const { encodeVarintField, encodeMessage, encodeString } = require('../../shared/protobuf');
    const { decodeGenMetadataBlob } = require('./store/usageReader');

    const usage = Buffer.concat([
        encodeVarintField(1, 1073),      // model enum -> MODEL_PLACEHOLDER_M73
        encodeVarintField(2, 15027),     // input
        encodeVarintField(3, 126),       // output
        encodeVarintField(5, 12232),     // cache read
        encodeVarintField(6, 24),        // provider -> Gemini
        encodeVarintField(9, 401),       // reasoning
        encodeString(11, 'eXZkatT5D8ONjuMPy9KhkA0'),  // responseId
    ]);
    const stamp = encodeMessage(9, encodeMessage(4, encodeVarintField(1, 1784968824)));
    const blob = encodeMessage(1, Buffer.concat([encodeMessage(4, usage), stamp]));

    const entry = decodeGenMetadataBlob(blob);
    assert.strictEqual(entry.inp, 15027, 'input tokens');
    assert.strictEqual(entry.out, 126, 'output tokens');
    assert.strictEqual(entry.cache, 12232, 'cache read tokens');
    assert.strictEqual(entry.reasoning, 401, 'reasoning tokens — priced, on 72% of entries');
    assert.strictEqual(entry.model, 'MODEL_PLACEHOLDER_M73', 'model resolved from enum');
    assert.strictEqual(entry.provider, 'API_PROVIDER_GOOGLE_GEMINI', 'provider resolved from enum');
    assert.strictEqual(entry.responseId, 'eXZkatT5D8ONjuMPy9KhkA0', 'response id');
    assert.strictEqual(entry.source, 'metadata', 'source tag');
    assert.strictEqual(entry.ts, new Date(1784968824000).toISOString(), 'timestamp from unix seconds');
    assert.strictEqual(decodeGenMetadataBlob(Buffer.from([0x00])), null, 'a malformed blob yields null, never a zero entry');
    console.log('usageReader: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `Cannot find module './store/usageReader'`.

- [ ] **Step 3: Implement `usageReader.ts`**

```typescript
/**
 * Reads token usage straight from a conversation store.
 *
 * The language server serves only conversations that existed when it started,
 * so anything the agy command-line client creates afterwards is invisible to
 * it. The store is the source of truth and is read directly.
 *
 * Interpretation is deliberately shared with the server path: the decoded
 * fields are shaped into a MetadataUsage and handed to extractTokens(), so the
 * two sources cannot drift apart in how a number becomes a token count.
 */

import { readFields } from '../../../shared/protobuf';
import { dbAllAt } from '../../../shared/db';
import { TokenEntry, MetadataUsage } from '../types';
import { extractTokens } from '../aggregator';
import { modelNameFromEnum, providerNameFromEnum } from './enumMap';
import { createLogger } from '../../../utils/logger';

const log = createLogger('UsageReader');

export type LearnedEnums = { models?: Record<number, string>; providers?: Record<number, string> };

/** usage submessage: gen_metadata.data -> field 1 -> field 4 */
const F_MODEL = 1, F_INPUT = 2, F_OUTPUT = 3, F_CACHE_READ = 5,
      F_PROVIDER = 6, F_REASONING = 9, F_RESPONSE_ID = 11;

function sub(buf: Buffer, field: number): Buffer | null {
    const f = readFields(buf).find(x => x.field === field && x.wireType === 2);
    return f?.bytes ?? null;
}

export function decodeGenMetadataBlob(buf: Buffer, learned?: LearnedEnums): TokenEntry | null {
    try {
        const outer = sub(buf, 1);
        if (!outer) return null;
        const usage = sub(outer, 4);
        if (!usage) return null;

        const g: Record<number, any> = {};
        for (const f of readFields(usage)) {
            g[f.field] = f.wireType === 0 ? f.varint : f.bytes;
        }
        if (g[F_INPUT] === undefined && g[F_OUTPUT] === undefined) return null;

        // timestamp: outer -> field 9 -> field 4 -> field 1 (unix seconds)
        let seconds = 0;
        const t1 = sub(outer, 9);
        const t2 = t1 ? sub(t1, 4) : null;
        if (t2) seconds = readFields(t2).find(f => f.field === 1)?.varint ?? 0;
        if (!seconds) return null;

        const model = modelNameFromEnum(Number(g[F_MODEL] ?? 0), learned?.models);
        const provider = providerNameFromEnum(Number(g[F_PROVIDER] ?? 0), learned?.providers);

        // Shaped as the server's JSON so extractTokens() stays the single
        // interpreter of token fields. Field 10 (responseOutputTokens) is
        // deliberately omitted: it has been observed disagreeing with field 3
        // and is unverified, so it must not reach cost.
        const usageJson: MetadataUsage = {
            inputTokens: String(g[F_INPUT] ?? 0),
            outputTokens: String(g[F_OUTPUT] ?? 0),
            cacheReadTokens: String(g[F_CACHE_READ] ?? 0),
            reasoningTokens: String(g[F_REASONING] ?? 0),
            model,
            apiProvider: provider,
        };
        const t = extractTokens(usageJson);

        const ridBuf = g[F_RESPONSE_ID];
        return {
            responseId: Buffer.isBuffer(ridBuf) ? ridBuf.toString('utf-8') : undefined,
            source: 'metadata',
            inp: t.inp, out: t.out, cache: t.cache, cacheWrite: t.cacheWrite, reasoning: t.reasoning,
            model, provider,
            ts: new Date(seconds * 1000).toISOString(),
        };
    } catch { /* a malformed row must not take the conversation down */
        return null;
    }
}

/** null means the read failed — never conflate that with "no usage". */
export async function readGenMetadata(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null> {
    const rows = await dbAllAt(dbPath, 'select quote(data) from gen_metadata order by idx');
    if (rows === null) { log.warn(`gen_metadata unreadable: ${dbPath}`); return null; }
    const entries: TokenEntry[] = [];
    for (const r of rows) {
        const cell = r[0];
        if (!cell || !cell.startsWith("X'")) continue;
        const e = decodeGenMetadataBlob(Buffer.from(cell.slice(2, -1), 'hex'), learned);
        if (e) entries.push(e);
    }
    return entries;
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `usageReader: all checks passed`.

- [ ] **Step 5: Verify against the real store**

```bash
node -e "require('./out/services/usage/store/usageReader').readGenMetadata(process.env.HOME+'/.gemini/antigravity-cli/conversations/1d9ecd7c-ecf8-418f-bd4e-15add0b07db7.db').then(e=>console.log('entries:',e.length,'first:',JSON.stringify(e[0])))"
```

Expected: **207** entries; the first shows non-zero `inp` and a plausible `ts`. If the count is zero, the read failed — do not proceed.

The conversation holds 210 `gen_metadata` rows, but 3 of them carry a zero-length usage submessage — user-cancelled streaming requests, identifiable by a `context canceled by user` string in the row. Decoding them to nothing is correct: they consumed no billable tokens. (An earlier draft of this plan said 210, taken from the row count rather than the count of rows carrying usage. Verified: 210 rows, 207 with a usage message, 3 empty, 0 malformed.)

- [ ] **Step 6: Commit**

```bash
git add src/services/usage/store/usageReader.ts src/services/usage/types.ts
git commit -m "feat(usage): decode token usage from a conversation store

Shapes decoded fields into MetadataUsage and reuses extractTokens so the file
and server paths cannot drift in interpretation. Field 10 is omitted: it has
been observed disagreeing with field 3 and is unverified, so it must not
reach cost."
```

---

### Task 4: Read the `steps` source

3.3% of existing entries (125 of 3,796, across 66 conversations) exist only in the steps source. Reading `gen_metadata` alone loses them.

**Files:**
- Modify: `src/services/usage/store/usageReader.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `decodeGenMetadataBlob`, `readGenMetadata` (Task 3).
- Produces: `readConversationUsage(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null>` — merged, deduplicated by `entryFingerprint`, metadata preferred. `null` if **either** table failed to read.

- [ ] **Step 1: Write the failing self-check**

**The merge assertions below are not sufficient on their own.** They exercise `mergeSources` with hand-built arrays, so an implementation whose `readStepsUsage` always returns `[]` passes every one of them — which is exactly the failure this task shipped on its first attempt, with a fully green self-check. The section must also drive `readStepsUsage` end-to-end against a fixture database: build a temporary sqlite file with a `steps` row whose `metadata` blob is a synthetic protobuf carrying a usage submessage at field 9 and a timestamp at field 1 → field 1, then assert `readStepsUsage` returns one entry with the expected tokens and `source: 'steps'`. Place it inside the existing `hasSqlite3` guard from Task 1, since the fixture needs the command-line tool to exist. Without that, nothing in the repeatable suite can tell a working steps reader from one that silently extracts nothing.

```typescript
    // ─── steps merge: metadata wins, steps fills gaps ───
    const { mergeSources } = require('./store/usageReader');
    const fromMeta = { responseId: 'A', source: 'metadata', inp: 10, out: 1, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
    const fromStepsSame = { responseId: 'A', source: 'steps', inp: 99, out: 9, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
    const fromStepsOnly = { responseId: 'B', source: 'steps', inp: 5, out: 1, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
    const merged = mergeSources([fromMeta], [fromStepsSame, fromStepsOnly]);
    assert.strictEqual(merged.length, 2, 'the duplicate collapses, the steps-only entry survives');
    assert.strictEqual(merged.find(e => e.responseId === 'A').inp, 10, 'metadata wins for a shared response id');
    assert.ok(merged.find(e => e.responseId === 'B'), 'steps-only entries are kept — 3.3% of history depends on this');
    console.log('usageReader steps merge: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `mergeSources is not a function`.

- [ ] **Step 3: Implement the steps read and merge**

Append to `src/services/usage/store/usageReader.ts`:

```typescript
import { entryFingerprint, mergePreferredEntry } from '../types';

/**
 * A steps row carries the same usage submessage as gen_metadata, but reached by
 * a different path — measured across 3,527 rows in 34 conversations:
 *
 *     gen_metadata:  usage at 1 -> 4     timestamp at 1 -> 9 -> 4 -> 1
 *     steps:         usage at 9          timestamp at 1 -> 1
 *
 * 1,644 of those rows carry usage at field 9 and every row has a timestamp at
 * 1.1. The submessage's own field numbering is identical in both, which is why
 * the two share one decoder for it.
 *
 * The usage message is mirrored at 28.2 in the same blob; only field 9 is read,
 * so the duplicate never enters the list.
 *
 * step_payload is never selected: it holds conversation content and is the bulk
 * of the file.
 */
export async function readStepsUsage(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null> {
    const rows = await dbAllAt(dbPath, 'select quote(metadata) from steps where metadata is not null order by idx');
    if (rows === null) {
        // Lazy + guarded: see readGenMetadata.
        try { require('../../../utils/logger').createLogger('UsageReader').warn(`steps unreadable: ${dbPath}`); }
        catch { /* outside the extension host — the caller reports the failure count */ }
        return null;
    }
    const entries: TokenEntry[] = [];
    for (const r of rows) {
        const cell = r[0];
        if (!cell || !cell.startsWith("X'")) continue;
        const buf = Buffer.from(cell.slice(2, -1), 'hex');

        // Same guard as decodeGenMetadataBlob: one malformed row must not take
        // down the conversation. The protobuf reader clamps rather than throws,
        // but a garbage varint reaching `new Date(seconds * 1000)` raises
        // RangeError, which would otherwise reject the promise and bypass the
        // documented "null if either table fails" contract entirely.
        try {
            const usage = sub(buf, 9);
            if (!usage || usage.length === 0) continue;      // a step with no model call
            const stamp = sub(buf, 1);
            const seconds = stamp ? (readFields(stamp).find(f => f.field === 1)?.varint ?? 0) : 0;
            if (!seconds) continue;

            const e = decodeUsageSubmessage(usage, seconds, 'steps', learned);
            if (e) entries.push(e);
        } catch { /* skip this row; siblings still count */ }
    }
    return entries;
}

/** Metadata is the canonical accounting; steps only fills gaps. */
export function mergeSources(metadata: TokenEntry[], steps: TokenEntry[]): TokenEntry[] {
    const byFingerprint = new Map<string, TokenEntry>();
    for (const e of metadata) byFingerprint.set(entryFingerprint(e), e);
    for (const e of steps) {
        const fp = entryFingerprint(e);
        const existing = byFingerprint.get(fp);
        byFingerprint.set(fp, existing ? mergePreferredEntry(existing, e) : e);
    }
    return [...byFingerprint.values()];
}

/**
 * Full usage for one conversation. Returns null if either table failed —
 * a partial read must never be mistaken for a complete one, or it would
 * truncate the ledger.
 */
export async function readConversationUsage(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null> {
    const [meta, steps] = await Promise.all([readGenMetadata(dbPath, learned), readStepsUsage(dbPath, learned)]);
    if (meta === null || steps === null) return null;
    return mergeSources(meta, steps);
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `usageReader steps merge: all checks passed`.

- [ ] **Step 5: Verify against a conversation the server cannot serve**

```bash
node -e "require('./out/services/usage/store/usageReader').readConversationUsage(process.env.HOME+'/.gemini/antigravity-cli/conversations/50163fed-a506-4f62-a1ca-55a7435a09d0.db').then(e=>console.log('stranded conversation entries:',e.length))"
```

Expected: at least 187 entries — the conversation the language server answers 500 for.

- [ ] **Step 6: Commit**

```bash
git add src/services/usage/store/usageReader.ts src/services/usage/types.ts
git commit -m "feat(usage): read the steps source and merge it with gen_metadata

3.3% of entries (125 of 3,796, across 66 conversations) exist only in steps.
Returns null when either table fails so a partial read can never be mistaken
for a complete one. step_payload is never selected."
```

---

### Task 5: Enumerate conversations across all install roots

The extension looks in one install root. On a machine without the maintainer's symlinks, command-line conversations are in a different root and are invisible.

**Files:**
- Create: `src/services/usage/store/conversationStore.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type StoredConversation = { id: string; dbPath: string; brainPath: string; mtimeMs: number }`
  - `listConversations(): StoredConversation[]`
  - `conversationFreshness(dbPath: string, brainPath: string): number`

- [ ] **Step 1: Write the failing self-check**

```typescript
    // ─── conversation store ───
    const { conversationFreshness, listConversations } = require('./store/conversationStore');
    const tmpDir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'ag-store-'));
    const dbFile = pathm.join(tmpDir, 'x.db');
    const brainDir = pathm.join(tmpDir, 'brain-x');
    fsm.writeFileSync(dbFile, 'x'); fsm.mkdirSync(brainDir);
    // new Date(n) is n MILLISECONDS after the epoch, and statSync reports mtimeMs
    // in milliseconds too — so these must be scaled to match the assertion below.
    // The gap between the .db and the -wal is what gives this test its power: an
    // implementation that stats only the .db returns 1000000 and fails.
    fsm.utimesSync(dbFile, new Date(1000000), new Date(1000000));
    fsm.utimesSync(brainDir, new Date(1000000), new Date(1000000));
    fsm.writeFileSync(dbFile + '-wal', 'w');
    fsm.utimesSync(dbFile + '-wal', new Date(9000000), new Date(9000000));
    assert.strictEqual(conversationFreshness(dbFile, brainDir), 9000 * 1000,
        'the write-ahead log is the freshest signal — the .db timestamp lags up to a checkpoint');
    assert.ok(Array.isArray(listConversations()), 'listing never throws, even with roots missing');
    fsm.rmSync(tmpDir, { recursive: true, force: true });
    console.log('conversationStore: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `Cannot find module './store/conversationStore'`.

- [ ] **Step 3: Implement `conversationStore.ts`**

```typescript
/**
 * Enumerates conversations across every Antigravity install root.
 *
 * Antigravity keeps data under antigravity, antigravity-ide and
 * antigravity-cli. Looking in only one means a normal install hides every
 * command-line conversation. Roots are resolved to real paths first, because
 * on a symlinked setup all three are the same directory and would otherwise
 * be scanned three times.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type StoredConversation = { id: string; dbPath: string; brainPath: string; mtimeMs: number };

const INSTALL_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const UUID_LENGTH = 36;

function realRoots(): { conversations: string; brain: string }[] {
    const seen = new Set<string>();
    const out: { conversations: string; brain: string }[] = [];
    for (const name of INSTALL_ROOTS) {
        const base = path.join(os.homedir(), '.gemini', name);
        const conversations = path.join(base, 'conversations');
        try {
            const real = fs.realpathSync(conversations);
            if (seen.has(real)) continue;
            seen.add(real);
            let brain = path.join(base, 'brain');
            try { brain = fs.realpathSync(brain); } catch { /* brain may not exist */ }
            out.push({ conversations: real, brain });
        } catch { /* root not installed */ }
    }
    return out;
}

/**
 * Newest signal for a conversation. SQLite writes land in the write-ahead log
 * first and only reach the .db at a checkpoint — a call was observed recorded
 * while the .db timestamp was 92 seconds stale, and the brain directory lagged
 * seven minutes. Taking the maximum is what makes live sessions detectable.
 */
export function conversationFreshness(dbPath: string, brainPath: string): number {
    let newest = 0;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, brainPath]) {
        try {
            const m = fs.statSync(p).mtimeMs;
            if (m > newest) newest = m;
        } catch { /* absent files simply do not contribute */ }
    }
    return newest;
}

/** Deduplicated by conversation id; when an id appears twice, newest wins. */
export function listConversations(): StoredConversation[] {
    const byId = new Map<string, StoredConversation>();
    for (const root of realRoots()) {
        let files: string[] = [];
        try { files = fs.readdirSync(root.conversations); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.db')) continue;
            const id = f.slice(0, -3);
            if (id.length !== UUID_LENGTH) continue;
            const dbPath = path.join(root.conversations, f);
            const brainPath = path.join(root.brain, id);
            const entry: StoredConversation = { id, dbPath, brainPath, mtimeMs: conversationFreshness(dbPath, brainPath) };
            const existing = byId.get(id);
            if (!existing || entry.mtimeMs > existing.mtimeMs) byId.set(id, entry);
        }
    }
    return [...byId.values()];
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `conversationStore: all checks passed`.

- [ ] **Step 5: Verify against the real store**

```bash
node -e "const s=require('./out/services/usage/store/conversationStore');const c=s.listConversations();console.log('conversations found:',c.length);console.log('newest:',c.sort((a,b)=>b.mtimeMs-a.mtimeMs)[0])"
```

Expected: 90 or more conversations; the newest is a recent one with a plausible `mtimeMs`.

- [ ] **Step 6: Commit**

```bash
git add src/services/usage/store/conversationStore.ts src/services/usage/types.ts
git commit -m "feat(usage): enumerate conversations across all install roots

Antigravity keeps data under three roots; scanning one hides every
command-line conversation on a normal install. Roots are resolved to real
paths so a symlinked setup is not scanned three times. Freshness takes the
write-ahead log into account, which the .db timestamp lags by up to a
checkpoint."
```

---

### Task 6: Local-day bucketing and global dedupe

Two aggregator defects. Days are bucketed by UTC (`aggregator.ts:95`) while weekdays are bucketed by local time (`aggregator.ts:174`) and the activity grid uses local dates — so they already disagree with each other. And dedupe is per-conversation, while 7 `responseId`s already appear in more than one conversation.

**Files:**
- Modify: `src/services/usage/aggregator.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `isoDay` from `src/shared/helpers.ts` (already exists).
- Produces: no new exports; `aggregateFromPerConvo` behaviour changes.

- [ ] **Step 1: Write the failing self-check**

```typescript
    // ─── local-day bucketing and global dedupe ───
    const { aggregateFromPerConvo } = require('./aggregator');
    const mk = (rid, ts) => ({ responseId: rid, source: 'metadata', inp: 100, out: 10, cache: 0, cacheWrite: 0, reasoning: 0, model: 'MODEL_PLACEHOLDER_M73', provider: 'API_PROVIDER_GOOGLE_GEMINI', ts });

    // 23:30 local on the 5th. In a positive-offset zone that is the 5th, not the 6th.
    const local = new Date(2026, 7, 5, 23, 30, 0);
    const statsDay = aggregateFromPerConvo({ c1: { entries: [mk('R1', local.toISOString())] } }, new Map());
    const { isoDay } = require('../../shared/helpers');
    assert.strictEqual(statsDay.daily[0].date, isoDay(local), 'a day bucket uses the local date, not the UTC one');

    // the same call recorded under two conversations must count once
    const statsDup = aggregateFromPerConvo({
        parent: { entries: [mk('SHARED', local.toISOString())] },
        child:  { entries: [mk('SHARED', local.toISOString())] },
    }, new Map());
    assert.strictEqual(statsDup.totalCalls, 1, 'dedupe is global — 7 response ids already span two conversations');
    assert.strictEqual(statsDup.totalInput, 100, 'a globally deduplicated call is counted once');
    // The monthly buckets are built from allEntries, which is populated before the
    // date filter — dedupe has to cover that path too, not just the filtered one.
    const monthTotal = statsDup.monthly.reduce((n, m) => n + m.calls, 0);
    assert.strictEqual(monthTotal, 1, 'monthly buckets are deduplicated too');
    console.log('aggregator: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: the day assertion fails when the local time is within the UTC-offset window; the dedupe assertion fails with `totalCalls` of 2.

- [ ] **Step 3: Switch day bucketing to local time**

In `src/services/usage/aggregator.ts`, add the import:

```typescript
import { isoDay } from '../../shared/helpers';
```

Replace line 95:

```typescript
        // Local date, not ts.slice(0,10). The stored timestamp is UTC, so a
        // 01:39 session in a positive-offset zone would otherwise land on the
        // previous day — and the activity grid buckets by local date, so the
        // two would disagree. Weekday bucketing below is already local.
        const day = isoDay(new Date(e.ts));
```

- [ ] **Step 4: Make dedupe global**

At the top of `aggregateFromPerConvo`, before iterating conversations, build a global seen-set and skip repeats. Insert immediately after the `from`/`to` lines:

```typescript
    // Dedupe across conversations, not within one. A sub-agent trajectory can
    // record the same model call as its parent, and 7 response ids already
    // span two conversations before sub-agent counting is enabled.
    const seenGlobally = new Set<string>();
```

Then insert the check at the **very top of the inner `for (const e of data.entries)` loop, before `allEntries.push(e)`** — not after the date filter:

```typescript
        for (const e of data.entries) {
            // Placement is load-bearing. allEntries feeds the monthly buckets and
            // is populated before the date filter, so a check placed after the
            // filter would leave monthly totals double-counted. And a duplicate
            // outside the window would consume the fingerprint, suppressing the
            // in-window copy. A duplicate is a duplicate regardless of window.
            const fp = entryFingerprint(e);
            if (seenGlobally.has(fp)) continue;
            seenGlobally.add(fp);

            allEntries.push(e);
```

A call recorded by both a parent and a sub-agent conversation is attributed to whichever is iterated first. That is arbitrary but stable, and counting it once in an arbitrary conversation beats counting it twice; identifying the true parent needs data the store does not expose.

`entryFingerprint` is already imported by this module; if not, add it to the existing `./types` import.

- [ ] **Step 5: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `aggregator: all checks passed`.

- [ ] **Step 6: Measure the change against real data**

```bash
node -e "
const {aggregateFromPerConvo}=require('./out/services/usage/aggregator.js');
const c=require(process.env.HOME+'/.gemini/antigravity/brain/.deep_stats_cache.json');
const s=aggregateFromPerConvo(c.perConvo,new Map(Object.entries(c.titleMap||{})),'');
console.log('calls after global dedupe:',s.totalCalls,'(cache holds',Object.values(c.perConvo).reduce((n,v)=>n+v.entries.length,0),'entries)');
"
```

Expected: `totalCalls` is lower than the raw entry count by roughly the 7 known cross-conversation duplicates. Record the numbers in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/services/usage/aggregator.ts src/services/usage/types.ts
git commit -m "fix(usage): bucket days by local time and deduplicate globally

Days were bucketed by UTC while weekdays and the activity grid used local
dates, so a late-evening session landed on the previous day. Dedupe was
per-conversation while 7 response ids already span two conversations, and
counting sub-agent runs will grow that class."
```

---

### Task 7: Cache becomes a ledger

A rebuild from disk must never shrink the ledger. The synthetic `claude-code-imported` conversation has no backing file and holds 175 entries and 12.94B tokens; a naive reconcile deletes it, along with any conversation the user later removes from Antigravity.

**Files:**
- Modify: `src/services/usage/cache.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `StoredConversation` (Task 5).
- Produces: `mergeIntoLedger(existing: Record<string, ConvoTokenData>, fresh: Record<string, ConvoTokenData>, presentIds: Set<string>): Record<string, ConvoTokenData>`

- [ ] **Step 1: Write the failing self-check**

```typescript
    // ─── ledger semantics ───
    const { mergeIntoLedger } = require('./cache');
    const e1 = { responseId: 'X', source: 'metadata', inp: 1, out: 1, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
    const existingLedger = {
        'claude-code-imported': { entries: [e1, e1] },     // synthetic, no file on disk
        'deleted-by-user':      { entries: [e1] },          // file removed since
        'still-present':        { entries: [e1] },
    };
    const freshRead = { 'still-present': { entries: [e1, e1, e1] } };
    const present = new Set(['still-present']);
    const ledger = mergeIntoLedger(existingLedger, freshRead, present);
    assert.strictEqual(ledger['claude-code-imported'].entries.length, 2,
        'a conversation with no backing file is preserved — 12.94B tokens depend on this');
    assert.strictEqual(ledger['deleted-by-user'].entries.length, 1, 'history survives deleting a conversation');
    assert.strictEqual(ledger['still-present'].entries.length, 3, 'a conversation present on disk is replaced by the fresh read');
    const before = Object.values(existingLedger).reduce((n, v) => n + v.entries.length, 0);
    const after = Object.values(ledger).reduce((n, v) => n + v.entries.length, 0);
    assert.ok(after >= before, 'the ledger never shrinks');
    console.log('cache ledger: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `mergeIntoLedger is not a function`.

- [ ] **Step 3: Implement `mergeIntoLedger`**

Add to `src/services/usage/cache.ts`:

```typescript
/**
 * The cache is a ledger, not a mirror of disk.
 *
 * A conversation present on disk is replaced by its fresh read — the file is
 * the truth for it, and callers only pass a fresh read that succeeded in full.
 * A conversation with no backing file keeps whatever it already had: that
 * covers the synthetic Claude Code import, which exists only here, and any
 * conversation the user deletes from Antigravity later.
 */
export function mergeIntoLedger(
    existing: Record<string, ConvoTokenData>,
    fresh: Record<string, ConvoTokenData>,
    presentIds: Set<string>,
): Record<string, ConvoTokenData> {
    const out: Record<string, ConvoTokenData> = {};
    for (const [cid, data] of Object.entries(existing)) {
        if (!presentIds.has(cid)) out[cid] = data;   // no file — preserve verbatim
    }
    for (const [cid, data] of Object.entries(fresh)) out[cid] = data;
    for (const [cid, data] of Object.entries(existing)) {
        if (!out[cid]) out[cid] = data;              // present but not re-read this pass
    }
    return out;
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `cache ledger: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add src/services/usage/cache.ts src/services/usage/types.ts
git commit -m "feat(usage): cache becomes an append-oriented ledger

Conversations with no backing file are preserved rather than reconciled away.
Without this the upgrade silently deletes the synthetic Claude Code import —
175 entries, 12.94B tokens — and any conversation deleted from Antigravity."
```

---

### Task 8: Make the store the data path

**Files:**
- Modify: `src/services/usage/index.ts`
- Modify: `package.json` (the `usageSource` setting)

**Interfaces:**
- Consumes: `listConversations`, `conversationFreshness` (Task 5); `readConversationUsage` (Task 4); `mergeIntoLedger` (Task 7); `isConvoDirty` (existing).
- Produces: no new exports; `fetchDeepStats` reads from the store.

- [ ] **Step 1: Add the rollback setting**

In `package.json`, under `contributes.configuration.properties`:

```json
"ag-switchboard.usageSource": {
  "type": "string",
  "enum": ["auto", "server"],
  "default": "auto",
  "description": "Where token usage is read from. 'auto' reads the conversation store directly. 'server' restores the previous language-server path, which cannot see sessions created after it started. Temporary; will be removed once the store path has run a release without divergence."
}
```

- [ ] **Step 2: Add the store refresh**

Add to `UsageStatsService` in `src/services/usage/index.ts`:

```typescript
    /**
     * Refresh usage from the conversation store.
     *
     * Replaces the language-server fetch as the data path. The server only
     * serves conversations that existed when it started, so anything the agy
     * command-line client creates afterwards is permanently invisible to it.
     */
    private async refreshFromStore(diskCache: DiskCacheData | null): Promise<DeepUsageStats | null> {
        const conversations = listConversations();
        if (conversations.length === 0) {
            log.warn('refreshFromStore: no conversations found in any install root');
            return this.deepStatsCache;
        }

        const cachedMtimes = diskCache?.mtimes || {};
        const cachedPerConvo = diskCache?.perConvo || {};
        const presentIds = new Set(conversations.map(c => c.id));

        // A conversation sitting at zero entries is always retried, whatever
        // its recorded timestamp says — that is what recovers conversations
        // stranded by the previous server-only path.
        const dirty = conversations.filter(c => {
            const hasEntries = !!cachedPerConvo[c.id]?.entries?.length;
            if (!hasEntries) return true;
            return c.mtimeMs > (cachedMtimes[c.id] ?? 0);
        });

        log.info(`refreshFromStore: ${dirty.length} of ${conversations.length} conversations to read`);

        const fresh: Record<string, ConvoTokenData> = {};
        const mtimes: Record<string, number> = { ...cachedMtimes };
        let failed = 0;
        for (const c of dirty) {
            const before = c.mtimeMs;                       // stamp before reading
            const entries = await readConversationUsage(c.dbPath);
            if (entries === null) { failed++; continue; }   // partial read must not truncate
            fresh[c.id] = { entries };
            mtimes[c.id] = before;
        }
        if (failed > 0) log.warn(`refreshFromStore: ${failed} conversations unreadable this pass; will retry`);

        const merged = mergeIntoLedger(cachedPerConvo, fresh, presentIds);
        const titleMap = this.currentTitleMap.size > 0
            ? this.currentTitleMap
            : new Map<string, string>(Object.entries(diskCache?.titleMap || {}));
        const stats = aggregateFromPerConvo(merged, titleMap);

        this.deepStatsCache = stats;
        this.currentPerConvo = merged;
        this.cache.write(merged, [...presentIds, ...Object.keys(merged)], stats, titleMap,
            this.currentStepCounts, diskCache?.entryCounts, mtimes);
        log.info(`refreshFromStore: complete — ${stats.totalCalls} calls across ${Object.keys(merged).length} conversations`);
        return stats;
    }
```

Add the imports at the top of the file:

```typescript
import { listConversations } from './store/conversationStore';
import { readConversationUsage } from './store/usageReader';
import { mergeIntoLedger } from './cache';
```

- [ ] **Step 3: Route `fetchDeepStats` through the store**

In `fetchDeepStats`, replace the call to `this.incrementalRefresh(serverInfo, diskCache)` with a source check, and replace the cold-boot `twoPhaseFullFetch` call likewise:

```typescript
    private useServerSource(): boolean {
        try {
            const vscode = require('vscode');
            return vscode.workspace.getConfiguration('ag-switchboard').get('usageSource') === 'server';
        } catch { return false; }
    }
```

Then, in the disk-cache branch:

```typescript
                const updated = this.useServerSource()
                    ? await this.incrementalRefresh(serverInfo, diskCache).catch((e: any) => {
                        log.warn('fetchDeepStats: incrementalRefresh threw:', e?.message);
                        return false;
                    })
                    : !!(await this.refreshFromStore(diskCache).catch((e: any) => {
                        log.warn('fetchDeepStats: refreshFromStore threw:', e?.message);
                        return null;
                    }));
```

And in the cold-boot branch:

```typescript
            return this.useServerSource()
                ? await this.twoPhaseFullFetch(serverInfo, onBackfillComplete, onProgress)
                : await this.refreshFromStore(null);
```

`fetchTrajectorySummaries` continues to run for titles; the server keeps that role.

- [ ] **Step 4: Verify the stranded conversations are recovered**

Build, package, install, then reload the window:

```bash
npm run compile && npx vsce package
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension ./ag-multi-account-switchboard-*.vsix --force
```

After reloading, confirm the previously stranded days now report usage:

```bash
node -e "
const c=require(process.env.HOME+'/.gemini/antigravity/brain/.deep_stats_cache.json');
const d={};for(const v of Object.values(c.perConvo))for(const e of v.entries){const k=new Date(e.ts).toISOString().slice(0,10);d[k]=(d[k]||0)+1}
for(const k of ['2026-08-07','2026-08-10']) console.log(k, d[k]||0);
console.log('claude import preserved:', !!c.perConvo['claude-code-imported']);
"
```

Expected: Aug 7 and Aug 10 report non-zero counts, and the Claude import is still present. If the import is missing, stop — NR1 has been violated.

- [ ] **Step 5: Commit**

```bash
git add src/services/usage/index.ts package.json
git commit -m "feat(usage): read usage from the conversation store, not the server

The language server only serves conversations that existed when it started,
so agy sessions created afterwards were permanently invisible — 280 calls
across four conversations went uncounted. Conversations at zero entries are
always retried, which recovers them. usageSource restores the old path if
needed; it is temporary."
```

---

### Task 9: Verifier

Promotes the assumed fields in the field map to verified, and catches store-format drift.

**Files:**
- Create: `src/services/usage/store/verifier.ts`
- Modify: `src/services/usage/index.ts`

**Interfaces:**
- Consumes: `readGenMetadata` (Task 3); `callLsJson`, `EP` (existing).
- Produces:
  - `type Divergence = { conversationId: string; responseId: string; field: string; file: number | string; server: number | string }`
  - `verifyConversation(serverInfo: ServerInfo, cid: string, dbPath: string): Promise<{ compared: number; divergences: Divergence[] } | null>`

- [ ] **Step 1: Implement the verifier**

```typescript
/**
 * Cross-checks a store read against the language server for any conversation
 * the server can still serve.
 *
 * Three fields were validated against 599 calls before this existed: input,
 * output and cache read. Reasoning was matched on a single sample and appears
 * on 72% of entries, and responseOutputTokens has been seen disagreeing with
 * outputTokens. This is what promotes those from assumed to verified, and
 * what catches the store format changing under us.
 */
import { ServerInfo } from '../../../types';
import { callLsJson } from '../../../utils/lsClient';
import { EP, MetadataUsage } from '../types';
import { readGenMetadata } from './usageReader';
import { extractTokens } from '../aggregator';
import { createLogger } from '../../../utils/logger';

const log = createLogger('UsageVerifier');

export type Divergence = { conversationId: string; responseId: string; field: string; file: number | string; server: number | string };

export async function verifyConversation(
    serverInfo: ServerInfo, cid: string, dbPath: string,
): Promise<{ compared: number; divergences: Divergence[] } | null> {
    const resp: any = await callLsJson(serverInfo, EP.METADATA, { cascade_id: cid }, 10000).catch(() => null);
    const items: any[] = resp?.generatorMetadata || resp?.generator_metadata || [];
    if (!items.length) return null;                 // the server cannot serve it; nothing to compare

    const fileEntries = await readGenMetadata(dbPath);
    if (!fileEntries) return null;

    const byRid = new Map(fileEntries.filter(e => e.responseId).map(e => [e.responseId!, e]));
    const divergences: Divergence[] = [];
    let compared = 0;

    for (const item of items) {
        const usage: MetadataUsage = item?.chatModel?.usage || item?.chat_model?.usage;
        const rid = usage?.responseId || usage?.response_id;
        if (!usage || !rid) continue;
        const mine = byRid.get(rid);
        if (!mine) continue;
        compared++;
        const theirs = extractTokens(usage);
        for (const field of ['inp', 'out', 'cache', 'cacheWrite', 'reasoning'] as const) {
            if ((mine as any)[field] !== (theirs as any)[field]) {
                divergences.push({ conversationId: cid, responseId: rid, field, file: (mine as any)[field], server: (theirs as any)[field] });
            }
        }
        const theirModel = usage.model || '';
        if (theirModel && mine.model !== theirModel) {
            divergences.push({ conversationId: cid, responseId: rid, field: 'model', file: mine.model, server: theirModel });
        }
    }

    if (divergences.length) {
        log.warn(`verifier: ${divergences.length} divergences in ${cid.slice(0, 8)} across ${compared} calls`);
        for (const d of divergences.slice(0, 5)) {
            log.warn(`  ${d.field}: file=${d.file} server=${d.server} (${d.responseId})`);
        }
    } else {
        log.info(`verifier: ${cid.slice(0, 8)} clean across ${compared} calls`);
    }
    return { compared, divergences };
}
```

- [ ] **Step 2: Run it opportunistically after a store refresh**

At the end of `refreshFromStore`, before the return, verify a small sample without blocking:

```typescript
        // Non-blocking: compare a few conversations the server can still serve.
        void (async () => {
            let compared = 0, diverged = 0;
            for (const c of conversations.slice(0, 5)) {
                const r = await verifyConversation(serverInfo, c.id, c.dbPath).catch(() => null);
                if (!r) continue;
                compared += r.compared; diverged += r.divergences.length;
            }
            this.lastVerification = { compared, diverged, at: new Date().toISOString() };
            if (diverged > 0) log.warn(`verifier: ${diverged} divergences across ${compared} compared calls`);
        })();
```

`refreshFromStore` takes `serverInfo` as an additional parameter for this; add a `lastVerification` field to the class:

```typescript
    /** Surfaced by the health card. */
    public lastVerification: { compared: number; diverged: number; at: string } | null = null;
```

- [ ] **Step 3: Verify against real conversations**

```bash
npm run compile:extension
node -e "
const {verifyConversation}=require('./out/services/usage/store/verifier.js');
// Fill in a reachable language server port and token, then compare a conversation it can serve.
" 
```

Run the extension with the developer log open instead, reload the window, and confirm a `verifier: ... clean across N calls` line appears. **If any divergence is reported, stop and resolve it before Task 10** — the field map is wrong.

- [ ] **Step 4: Commit**

```bash
git add src/services/usage/store/verifier.ts src/services/usage/index.ts
git commit -m "feat(usage): cross-check store reads against the language server

Three fields were validated across 599 calls; reasoning was matched on one
sample and responseOutputTokens has been seen disagreeing with outputTokens.
Runs non-blocking on conversations the server can still serve, and is how the
assumed fields get promoted and format drift gets caught."
```

---

### Task 10: Health card, honest empty states, changeover marker

Numbers move for four independent reasons at once — recovered sessions, sub-agent runs, local-time bucketing, global dedupe. Users cannot tell that from a bug. And a range with zero calls currently renders as a wall of zeros, which is what made the original failure look like a broken toggle.

**Files:**
- Modify: `src/shared/usage-components.ts` (empty state, health card)
- Modify: `src/webview/renderers/usage.ts` (sidebar)
- Modify: `src/providers/usageStatsPanel.ts` (panel)
- Modify: `src/webview/panel.css`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `lastVerification` (Task 9); `isUnknownEnumName` (Task 2).
- Produces:
  - `renderEmptyRange(lastActivityIso: string | null, rangeLabelText: string): string`
  - `renderHealthCard(h: UsageHealth): string`
  - `type UsageHealth = { source: 'store' | 'server'; conversations: number; unreadable: number; unknownModels: string[]; verification: { compared: number; diverged: number; at: string } | null; countingChangedAt: string | null }`

- [ ] **Step 1: Write the failing self-check**

```typescript
    // ─── empty state names the last activity instead of showing zeros ───
    const { renderEmptyRange } = require('../../shared/usage-components');
    const empty = renderEmptyRange('2026-08-06T09:20:30.000Z', 'Last 24 Hours');
    assert.ok(empty.includes('Last 24 Hours'), 'the empty state names the range');
    assert.ok(/Aug\s*6/.test(empty), 'the empty state names when activity last happened');
    const never = renderEmptyRange(null, 'All Time');
    assert.ok(never.length > 0 && !never.includes('undefined'), 'no recorded activity still renders cleanly');
    console.log('empty state: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `renderEmptyRange is not a function`.

- [ ] **Step 3: Implement the empty state**

Add to `src/shared/usage-components.ts`:

```typescript
/**
 * A range with no calls renders as an explicit statement, never a wall of
 * zeros. A silent zero is indistinguishable from a broken tool — that is
 * exactly how the store-blindness bug presented for four days.
 */
export function renderEmptyRange(lastActivityIso: string | null, rangeLabelText: string): string {
    let html = '<div class="usage-empty-range">';
    html += `<div class="usage-empty-title">No activity in ${escHtml(rangeLabelText)}</div>`;
    html += lastActivityIso
        ? `<div class="usage-empty-sub">Last session ${fmtShortDate(lastActivityIso.slice(0, 10))}</div>`
        : '<div class="usage-empty-sub">No usage recorded yet</div>';
    html += '</div>';
    return html;
}
```

Add the styles to `src/webview/panel.css`:

```css
.usage-empty-range {
    padding: 18px 12px;
    text-align: center;
}

.usage-empty-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
}

.usage-empty-sub {
    font-size: 10px;
    color: var(--muted);
    margin-top: 4px;
}
```

- [ ] **Step 4: Use it in both views**

In `src/webview/renderers/usage.ts`, inside `renderCompactDashboard`, before rendering the activity section:

```typescript
    if (stats.totalCalls === 0) {
        html += '<div class="deep-section">';
        html += renderEmptyRange(stats.dateRange?.to || null, rangeLabel(state));
        html += '</div>';
    } else {
        // ...existing activity section unchanged...
    }
```

Apply the same guard in `renderHeatmapCard` in `src/providers/usageStatsPanel.ts`, replacing the current `<div class="up-empty">No data</div>` fallbacks.

- [ ] **Step 5: Implement the health card**

Add to `src/shared/usage-components.ts`:

```typescript
export type UsageHealth = {
    source: 'store' | 'server';
    conversations: number;
    unreadable: number;
    unknownModels: string[];
    verification: { compared: number; diverged: number; at: string } | null;
    countingChangedAt: string | null;
};

/** Says plainly where numbers came from and what would make them wrong. */
export function renderHealthCard(h: UsageHealth): string {
    const rows: string[] = [];
    rows.push(`<div class="uh-row"><span>Source</span><span>${h.source === 'store' ? 'conversation store' : 'language server (legacy)'}</span></div>`);
    rows.push(`<div class="uh-row"><span>Conversations read</span><span>${fmtNum(h.conversations)}</span></div>`);
    if (h.unreadable > 0) {
        rows.push(`<div class="uh-row uh-warn"><span>Unreadable</span><span>${fmtNum(h.unreadable)} — will retry</span></div>`);
    }
    if (h.unknownModels.length > 0) {
        rows.push(`<div class="uh-row uh-warn"><span>Unrecognised models</span><span>${h.unknownModels.length} — excluded from cost</span></div>`);
    }
    if (h.verification) {
        const v = h.verification;
        rows.push(v.diverged === 0
            ? `<div class="uh-row"><span>Cross-check</span><span>clean across ${fmtNum(v.compared)} calls</span></div>`
            : `<div class="uh-row uh-warn"><span>Cross-check</span><span>${fmtNum(v.diverged)} divergences of ${fmtNum(v.compared)}</span></div>`);
    }
    if (h.countingChangedAt) {
        rows.push(`<div class="uh-note">Counting changed on ${fmtShortDate(h.countingChangedAt)}: sessions the language server could not see are now included, along with sub-agent runs. Totals before and after that date are not directly comparable.</div>`);
    }
    return `<div class="up-card up-bento-full"><div class="up-card-hdr">Data health</div>${rows.join('')}</div>`;
}
```

Add to `src/webview/panel.css`:

```css
.uh-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 11px;
    padding: 3px 0;
    color: var(--muted);
}

.uh-row.uh-warn {
    color: var(--vscode-editorWarning-foreground, #d29922);
}

.uh-note {
    font-size: 10px;
    color: var(--muted);
    padding-top: 8px;
    line-height: 1.5;
}
```

- [ ] **Step 6: Record the changeover date**

In `src/services/usage/types.ts`, add to `DiskCacheData`:

```typescript
    /** ISO date on which store-sourced counting began. Totals before and after are not comparable. */
    countingChangedAt?: string;
```

Set it once in `refreshFromStore`, when it is absent:

```typescript
        const countingChangedAt = diskCache?.countingChangedAt || new Date().toISOString();
```

and pass it through `cache.write` alongside `mtimes`.

- [ ] **Step 7: Render the health card in the panel**

In `src/providers/usageStatsPanel.ts`, add `this.renderHealthCard(s)` to the bento grid in `renderDashboard`, after `renderConversationsCard(s)`, populated from the service's `lastVerification` and the counts recorded during the refresh.

- [ ] **Step 8: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `empty state: all checks passed`, and every earlier self-check line still passes.

- [ ] **Step 9: Verify in the running extension**

Build, package, install, reload, then check: the sidebar on a range with no calls states the range and the last session rather than showing zeros; the dashboard shows a Data health card naming the source, conversation count and cross-check result.

- [ ] **Step 10: Commit**

```bash
git add src/shared/usage-components.ts src/webview/renderers/usage.ts src/providers/usageStatsPanel.ts src/webview/panel.css src/services/usage/types.ts src/services/usage/index.ts
git commit -m "feat(usage): health card, honest empty states, counting-change marker

A range with no calls now says so and names the last session, instead of
rendering zeros that are indistinguishable from a broken tool. The health
card states where numbers came from, what was unreadable, which models were
excluded from cost, and the cross-check result."
```

---

### Task 11: Key live pricing by model id, not display name

Added mid-plan after review of Task 2 exposed that the dynamic pricing catalog has never once been used.

`src/extension.ts:59` registers the LiteLLM resolver and hands it a **humanized display name**. The catalog is keyed by **API model id**. Probed against the live catalog (2,158 models):

```
display names the extension passes today    raw / resolved model ids
  Claude Opus 4.8        MISS                 claude-opus-4-8    HIT  $5.00/M in, $25.00/M out
  Fable 5                MISS                 claude-fable-5     HIT  $10.00/M in, $50.00/M out
  Gemini 3.6 Flash       MISS                 gemini-3-flash     HIT  $0.50/M in, $3.00/M out
```

Every cost figure the extension has ever shown came from the hardcoded keyword guesser at `usage-components.ts:449-471`, not from live pricing. Fable 5 is under-priced 3.3× — guessed as Sonnet at $3/$15 against a real $10/$50 — so correcting this moves totals **up**.

The right key is neither the display name nor always the raw enum: it is the **resolved** id that `getModelDisplayName` computes internally before humanizing (`MODEL_PLACEHOLDER_M47` → `gemini-3-flash-c`, which the catalog's alias logic matches by stripping `-c`).

**Files:**
- Modify: `src/services/usage/aggregator.ts` — extract the resolution step, export it
- Modify: `src/types.ts` — `ModelBucket.rawModel?: string`
- Modify: `src/shared/usage-components.ts` — `matchPricing` takes the key; three call sites pass it
- Modify: `src/services/usage/types.ts` — self-check

**Interfaces:**
- Consumes: `PLACEHOLDER_MAP`, `OPUS_46_CUTOFF` (existing).
- Produces:
  - `getModelPricingKey(raw: string, ts?: string): string` — the resolved id, before humanization
  - `matchPricing(displayName: string, pricingKey?: string): PricingEntry` — tries the external resolver on `pricingKey` first, then `displayName`, then the keyword table
  - `ModelBucket.rawModel?: string` — optional, so caches written before this task still load

- [ ] **Step 1: Write the failing self-check**

The load-bearing assertion is the stub resolver: it records what string it was handed, which is the only thing that proves the bug is fixed rather than merely worked around.

```typescript
    // ─── live pricing is keyed by model id, not display label ───
    const { getModelPricingKey } = require('./aggregator');
    const uc = require('../../shared/usage-components');

    assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M47'), 'gemini-3-flash-c', 'mapped placeholder resolves to its id');
    assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M26', '2026-01-01T00:00:00.000Z'), 'claude-opus-4-5-thinking', 'M26 is date-aware before the cutoff');
    assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M26', '2026-08-01T00:00:00.000Z'), 'claude-opus-4-6-thinking', 'M26 after the cutoff');
    assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M266'), 'MODEL_PLACEHOLDER_M266', 'an unmapped placeholder has no better key than itself');

    // The regression this task exists for: the resolver must receive the id, not the label.
    const seen: string[] = [];
    uc.setExternalPricingResolver((key: string) => {
        seen.push(key);
        return key === 'claude-fable-5' ? { input: 10, output: 50, cache: 1, reasoning: 50 } : null;
    });
    const p = uc.matchPricing('Fable 5', 'claude-fable-5');
    assert.strictEqual(p.input, 10, 'live pricing wins when the key resolves');
    assert.strictEqual(p.output, 50, 'live output rate applied');
    assert.ok(seen.includes('claude-fable-5'), 'the resolver was asked about the model id');
    assert.strictEqual(seen[0], 'claude-fable-5', 'the id is tried FIRST, before the display label');
    uc.setExternalPricingResolver(null);   // restore, or later assertions inherit the stub
    console.log('pricing key: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `getModelPricingKey is not a function`.

- [ ] **Step 3: Extract the resolution step in `aggregator.ts`**

`getModelDisplayName` already computes this; lift it so both share one implementation rather than duplicating the date rule.

```typescript
/**
 * The id a model should be priced under — resolved from its placeholder, but
 * before humanization.
 *
 * The pricing catalog is keyed by API model id (`claude-fable-5`), while the
 * display layer produces labels (`Fable 5`). Handing the catalog a label
 * matches nothing, which is why dynamic pricing silently never applied.
 */
export function getModelPricingKey(raw: string, ts?: string): string {
    if (!raw || raw === 'Unknown') return '';
    if (raw === 'MODEL_PLACEHOLDER_M26' && ts && ts.slice(0, 10) < OPUS_46_CUTOFF) {
        return 'claude-opus-4-5-thinking';
    }
    return PLACEHOLDER_MAP[raw] || raw;
}
```

Then rewrite the opening of `getModelDisplayName` to call it:

```typescript
    let resolved = getModelPricingKey(raw, ts);
```

replacing the existing `let resolved = PLACEHOLDER_MAP[raw] || raw;` and the `if (raw === 'MODEL_PLACEHOLDER_M26' ...)` block that follows it. Everything below that point is unchanged.

- [ ] **Step 4: Carry the key through to pricing**

In `src/types.ts`, add to `ModelBucket`:

```typescript
    /** Resolved model id for pricing. Optional: caches written before this existed have no value. */
    rawModel?: string;
```

In `aggregator.ts` `buildModelBuckets`, record it on first sight of each display name — entries carry `e.model`, and the bucket key is the display name:

```typescript
        if (!map[dn]) map[dn] = { displayName: dn, rawModel: getModelPricingKey(e.model, e.ts), input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
```

In `usage-components.ts`, widen `matchPricing`:

```typescript
export function matchPricing(displayName: string, pricingKey?: string): PricingEntry {
    if (externalResolver) {
        // The id first — the catalog is keyed by id, and the display label
        // matches nothing. Falling back to the label costs one failed lookup
        // and keeps older cached buckets, which carry no id, working.
        const external = (pricingKey && externalResolver(pricingKey)) || externalResolver(displayName);
        if (external) return external;
    }
    // ... keyword table unchanged ...
```

Pass the key at all three cost sites: `calculateTotalCost` (`matchPricing(m.displayName, m.rawModel)`), `estimateTopModelCosts`, and `renderCostEstimate`.

- [ ] **Step 5: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `pricing key: all checks passed`, all earlier sections still passing.

- [ ] **Step 6: Measure the correction against real data**

```bash
node -e "
const {aggregateFromPerConvo}=require('./out/services/usage/aggregator.js');
const {calculateTotalCost}=require('./out/shared/usage-components.js');
const fs=require('fs'),os=require('os'),path=require('path');
const c=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.gemini','antigravity','brain','.deep_stats_cache.json'),'utf8'));
const s=aggregateFromPerConvo(c.perConvo,new Map(Object.entries(c.titleMap||{})),'');
for(const m of s.models.slice(0,8)) console.log(String(m.displayName).padEnd(30), (m.rawModel||'(none)').padEnd(28), '\$'+calculateTotalCost([m]).toFixed(0));
console.log('TOTAL \$'+calculateTotalCost(s.models).toFixed(0));
"
```

Every model should show a resolved `rawModel`. Record the before and after totals in the commit message — this changes user-visible numbers and the change must be traceable. Note that this runs outside the extension host, so no external resolver is registered and the keyword table still answers; the point of this step is to confirm the key is populated, not to observe the new prices.

- [ ] **Step 7: Commit**

```bash
git add src/services/usage/aggregator.ts src/types.ts src/shared/usage-components.ts src/services/usage/types.ts
git commit -m "fix(pricing): key the live catalog by model id, not display label

The LiteLLM resolver was registered against humanized display names while the
catalog is keyed by API model id, so no lookup has ever matched and every cost
figure came from the hardcoded keyword guesser. Fable 5 was priced as Sonnet
at \$3/\$15 against a real \$10/\$50."
```

### Task 12: The year grid keys its cells in UTC

Found by Task 6's implementer, out of that task's scope, and verified by the controller.

`renderDailyGrid` walks a cursor built from local dates (`new Date(selectedYear, 0, 1)`) but keys each cell with `cursor.toISOString().slice(0, 10)`. For any positive-offset timezone, local midnight is the previous day in UTC, so every cell is keyed one day earlier than the slot it occupies. `renderDayStrip` does not have this bug — it already uses `isoDay`.

Demonstrated against the built code:

```
Aug 10 2026 is a Monday
its cell lands in weekday row 1 (Tue) — expected row 0
first cell of the 2026 grid is keyed "Dec 28" — the Monday-aligned start is Dec 29
```

The tooltip prints the key rather than the slot, which is why this has never looked obviously wrong: a Monday's usage renders in the Tuesday row with a correct-looking "Aug 10" label.

Task 6 does not cause this — it is pre-existing — but Task 6 makes it systematic. Before Task 6 the daily buckets were keyed in UTC too, so the two wrongs partially cancelled; now the buckets are correct local dates and the grid alone is shifted.

**Files:**
- Modify: `src/shared/usage-components.ts` — `renderDailyGrid`
- Modify: `src/services/usage/types.ts` — self-check

**Interfaces:** none change.

- [ ] **Step 1: Write the failing self-check**

The assertion must check cell *position*, not the tooltip — the tooltip renders the key and so agrees with itself under either implementation.

```typescript
    // ─── the year grid must key cells by local date ───
    const { renderDailyGrid: rdg } = require('../../shared/usage-components');
    // 2026-08-10 is a Monday; in a Monday-first grid its cell belongs in row 0.
    const gridHtml = rdg([{ date: '2026-08-10', input: 1000, output: 100, cache: 0, cacheWrite: 0, reasoning: 0, calls: 5 }], false, 2026, 0);
    const gridCells = [...gridHtml.matchAll(/<div class="gh-cell gh-lvl-(\d)" data-tip="([^"]*)"><\/div>/g)];
    const litIndex = gridCells.findIndex(c => c[1] !== '0');
    assert.ok(litIndex >= 0, 'the bucket lights a cell at all');
    assert.strictEqual(litIndex % 7, 0, 'a Monday bucket lands in the Monday row — cells are keyed by local date, not UTC');
    console.log('daily grid keys: all checks passed');
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected, in a positive-offset timezone: `litIndex % 7` is 1, not 0. **In a zero or negative-offset timezone this assertion passes before the fix** — the bug is offset-dependent. If it passes at RED, re-run with `TZ=Asia/Bangkok` prefixed to force a positive offset, and note in the report that the check is offset-sensitive.

- [ ] **Step 3: Key the cells by local date**

In `renderDailyGrid`, replace the two UTC date derivations:

```typescript
    const today = isoDay(new Date());
```

replacing `const today = new Date().toISOString().slice(0, 10);`, and inside the cursor walk:

```typescript
        const iso = isoDay(cursor);
```

replacing `const iso = cursor.toISOString().slice(0, 10);`.

`isoDay` is already imported in this file for `renderDayStrip`. Add a comment at the cursor line: the cursor is built from local dates, so it must be read back as one — `toISOString` re-interprets local midnight as the previous day for positive offsets and shifts every cell.

- [ ] **Step 4: Make both timezone-sensitive assertions discriminate unconditionally**

Task 6's review raised this against its day-bucketing fixture, and the same weakness applies to the assertion added above: **both only fail against the unfixed code on a machine with a positive UTC offset.** On a UTC or negative-offset machine — a default CI runner, for instance — they pass whether or not the fix is present. That is the fixture-blindness failure this plan has now hit five times, in a form that would only appear on someone else's machine.

Neither production fix is timezone-dependent; `isoDay` is correct under any offset. Only the tests are.

Make both assertions self-guarding rather than relying on the ambient timezone. In `src/services/usage/types.ts`, at the day-bucketing assertion added by Task 6 (the `new Date(2026, 7, 5, 1, 30, 0)` fixture) and at the grid assertion above, assert the precondition explicitly before asserting the behaviour:

```typescript
    // These two assertions only tell a correct implementation from a UTC one when
    // local midnight and UTC midnight fall on different dates. State that as a
    // requirement rather than letting the check quietly pass under a UTC runner.
    const offsetMinutes = -new Date().getTimezoneOffset();
    assert.ok(offsetMinutes > 0,
        `local-date assertions need a positive UTC offset to discriminate; this runtime is UTC${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes / 60}. Re-run with TZ=Asia/Bangkok.`);
```

A failing precondition is the correct outcome: it says "this check could not be performed here" instead of reporting a pass it did not earn.

- [ ] **Step 5: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: `daily grid keys: all checks passed`, all earlier sections still passing.

Then confirm the guard itself works — run once forcing a zero offset and check that it fails loudly rather than passing:

```bash
TZ=UTC node out/services/usage/types.js --self-check
```

Expected: the precondition assertion fails with the "needs a positive UTC offset" message. Put that output in your report.

- [ ] **Step 6: Commit**

```bash
git add src/shared/usage-components.ts src/services/usage/types.ts
git commit -m "fix(usage): key year-grid cells by local date

The cursor is built from local dates but was read back with toISOString, so
for positive-offset timezones every cell was keyed one day earlier than the
slot it occupies — a Monday's usage rendered in the Tuesday row. The tooltip
prints the key rather than the slot, which is why it looked correct.
renderDayStrip already used isoDay; the year grid now matches."
```

## Release

After Task 10, bump to `3.3.0`, add a CHANGELOG entry covering all four reasons numbers change, package, and install. **Do not deploy without asking.**

## Phase 2

Live updating is a separate plan, written once 3.3.0 has run without the verifier reporting divergence. It adds `store/watcher.ts` and the budget rules from spec §7.2 — one directory watcher, debounce, visibility gating, memory-only updates, slow flush.

## Self-review

**Spec coverage:** §5.1 → Task 5. §5.2 → Tasks 3 and 4. §5.3 → Task 2. §5.4 → Task 9. §5.5 → Task 7. §5.6 → Task 6. §6 sub-agent counting → Task 5 (they are ordinary conversations once enumerated from disk) plus the marker in Task 10. §8 database opening → Task 1. §9 additive first run → Tasks 7 and 8. §10 → Task 10. §11 privacy → Task 4 (`step_payload` never selected). §12 failure modes → Tasks 3, 4, 8, 10. §13 rollback → Task 8. §14 testing → every task. §7 live updating → deferred to Phase 2 by design.

**Placeholders:** none. Every step carries the code or the command it needs.

**Type consistency:** `readConversationUsage` and `readGenMetadata` both return `TokenEntry[] | null`, with `null` meaning failure throughout. `mergeIntoLedger` takes and returns `Record<string, ConvoTokenData>`. `conversationFreshness` returns milliseconds, matching `DiskCacheData.mtimes`. `LearnedEnums` is defined in Task 3 and used in Task 4.
