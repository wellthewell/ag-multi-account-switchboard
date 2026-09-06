# Claude CLI as a tracked provider — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Claude Code usage into the existing ledger, per call and per account, with Claude and Antigravity totals shown side by side rather than summed.

**Architecture:** A filesystem-only reader turns `~/.claude/projects/**/*.jsonl` into `TokenEntry[]`, keyed `claude:<sessionId>` in the same `perConvo` ledger the Antigravity store already uses. Claude's `thinking_tokens` is normalized at ingestion so the aggregator's existing additive total stays correct with no change to `aggregator.ts`. Provider split is achieved by partitioning `perConvo` and calling the existing aggregator twice, not by modifying it.

**Tech Stack:** TypeScript, VS Code extension host, Node `fs`/`readline`. No test framework — runnable self-checks under plain Node.

**Spec:** `docs/superpowers/specs/2026-09-06-claude-cli-usage-provider-design.md`

## Global Constraints

- **Observe only.** No task writes a Claude credential, keychain entry, or any file under a Claude config root. Reads only.
- **Testing pattern:** this repo has no test framework. Self-checks are appended inside the existing `--self-check` block in `src/services/usage/types.ts` and run as `npm run compile:extension && node out/services/usage/types.js --self-check`. Every task below extends that single entry point.
- **`thinking <= output_tokens`** is the invariant the whole normalization rests on. Verified across 8,513 samples with 0 violations. An entry violating it is skipped, never stored.
- **The archive is irreplaceable.** `claude-code-imported` — 175 entries, 12,942,976,240 tokens — has no source files. Any code path that can drop it must be guarded by a test.
- **Provider test literal:** `cid.startsWith('claude:') || cid === 'claude-code-imported'`. Lives in exactly one exported helper.
- **Never render cost as `$0.00`** for an unresolved model. Suppress the figure instead.
- Never `readFileSync` a transcript whole. Stream it.
- Existing Antigravity numbers must not move. Branch 1 is invisible to the user by design.

## Refinement of the spec

The spec says `TokenEntry` gains `accountKey` and that the v2→v3 migration must carry the archive across. This plan makes that concrete in the safest available way, which is slightly narrower than the spec implies:

**The migration does not mutate entries.** It stamps the version and nothing else. `accountKey` is written only by the new reader, for rows it reads. Every pre-existing row — the archive included — is left byte-identical, and its account is resolved at *aggregation* time via `claudePins.ts`. This keeps the one irreplaceable dataset out of the write path entirely, and leaves pins as the single source of truth for backlog attribution rather than duplicating that logic into a one-shot migration.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/usage/types.ts` (modify) | `TokenEntry.accountKey`, `CACHE_SCHEMA_VERSION` 2→3, `isClaudeConvo()`, self-check host |
| `src/services/usage/cache.ts` (modify) | v2→v3 migration in `read()` |
| `src/services/usage/claude/claudeAccounts.ts` (create) | Enumerate config roots, resolve `oauthAccount` identity |
| `src/services/usage/claude/claudePins.ts` (create) | Backlog era attribution + `accountCreatedAt` guard |
| `src/services/usage/claude/claudeReader.ts` (create) | One transcript → `TokenEntry[]`; dedupe, normalization, invariant |
| `src/services/usage/claude/index.ts` (create) | Discover transcripts, mtime delta, produce ledger fragment |
| `src/services/usage/index.ts` (modify) | Call Claude ingestion during refresh |
| `src/services/usage/aggregator.ts` (modify) | `aggregateByProvider()` wrapper — partitions and delegates |
| `src/services/litellmPricing.ts` (modify) | Bare `fable-*` → `claude-fable-*` in `normalize()` |
| `src/providers/usageStatsPanel.ts` (modify) | Per-provider sections, account facet, honesty markers |

---

# Branch 1 — `feat/claude-foundation`

Schema, identity, migration. No ingestion. Nothing user-visible; existing numbers must not move.

- [ ] **Create the branch**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/claude-foundation
```

---

### Task 1: Archive survives the schema bump

Written first because it protects data that cannot be regenerated.

**Files:**
- Modify: `src/services/usage/types.ts:12` (version constant), self-check block at `:266`
- Modify: `src/services/usage/cache.ts:60-63` (version gate)

**Interfaces:**
- Consumes: nothing
- Produces: `CACHE_SCHEMA_VERSION = 3`; `migrateV2ToV3(data: DiskCacheData): DiskCacheData` exported from `cache.ts`

- [ ] **Step 1: Write the failing self-check**

Append inside the existing `--self-check` block in `src/services/usage/types.ts`, before the final `console.log`:

```typescript
// ─── v2 → v3 migration preserves the Claude archive ───
{
    const { migrateV2ToV3 } = require('./cache');
    const ARCHIVE_TOTAL = 12942976240;

    // Minimal stand-in for the real archive: fileless convo, metadata source,
    // one entry per model-day. Totals are what matter, not the row count.
    const v2: any = {
        schemaVersion: 2,
        perConvo: {
            'claude-code-imported': {
                entries: [
                    { responseId: 'cc-claude-opus-4-8-2026-06-05', source: 'metadata',
                      inp: 0, out: 0, cache: ARCHIVE_TOTAL, cacheWrite: 0, reasoning: 0,
                      model: 'claude-opus-4-8', provider: 'anthropic', ts: '2026-06-05T12:00:00.000Z' },
                ],
            },
            'some-antigravity-convo': {
                entries: [
                    { responseId: 'ag-1', source: 'metadata', inp: 10, out: 20, cache: 30,
                      cacheWrite: 40, reasoning: 50, model: 'MODEL_PLACEHOLDER_M20',
                      provider: 'API_PROVIDER_GOOGLE_GEMINI', ts: '2026-08-01T09:00:00.000Z' },
                ],
            },
        },
        fetchedIds: ['claude-code-imported', 'some-antigravity-convo'],
        stats: {},
        updatedAt: '2026-08-14T00:00:00.000Z',
    };

    const v3 = migrateV2ToV3(JSON.parse(JSON.stringify(v2)));

    assert.strictEqual(v3.schemaVersion, 3, 'migration must stamp v3');
    assert.ok(v3.perConvo['claude-code-imported'], 'archive convo must survive migration');

    const archived = v3.perConvo['claude-code-imported'].entries;
    assert.strictEqual(archived.length, 1, 'archive entry count must be preserved');
    const total = archived.reduce((s: number, e: any) =>
        s + e.inp + e.out + e.cache + e.cacheWrite + e.reasoning, 0);
    assert.strictEqual(total, ARCHIVE_TOTAL, 'archive token total must be preserved exactly');

    assert.deepStrictEqual(archived[0], v2.perConvo['claude-code-imported'].entries[0],
        'migration must not mutate archive entries at all');

    assert.ok(v3.fetchedIds.includes('claude-code-imported'),
        'archive must stay in fetchedIds or it will be re-fetched and lost');

    console.log('v2->v3 migration: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — `migrateV2ToV3 is not a function`.

- [ ] **Step 3: Bump the version constant**

In `src/services/usage/types.ts:12`:

```typescript
export const CACHE_SCHEMA_VERSION = 3;
```

- [ ] **Step 4: Add the migration to `cache.ts`**

Add above the `StatsCache` class in `src/services/usage/cache.ts`:

```typescript
/**
 * v2 → v3 is additive: v3 only introduces the optional TokenEntry.accountKey,
 * which the Claude reader writes and pins resolve for everything older. So this
 * stamps the version and touches nothing else.
 *
 * It exists at all because read() returns null on a version mismatch, and a
 * rebuild would permanently destroy `claude-code-imported` — 12.94B tokens with
 * no source files to re-read.
 */
export function migrateV2ToV3(data: DiskCacheData): DiskCacheData {
    return { ...data, schemaVersion: 3 };
}
```

- [ ] **Step 5: Route v2 caches through it**

In `src/services/usage/cache.ts`, replace the version gate at `:60-63`:

```typescript
            if (data.schemaVersion === 2) {
                log.info('Cache read: migrating v2 -> v3 in place (archive preserved)');
                data = migrateV2ToV3(data);
            }
            if (data.schemaVersion !== CACHE_SCHEMA_VERSION) {
                log.info(`Cache read: ignoring schema v${data.schemaVersion ?? 1}; rebuild required for v${CACHE_SCHEMA_VERSION}`);
                return null;
            }
```

Change `const data = JSON.parse(raw) as DiskCacheData;` to `let data = ...` so it can be reassigned.

- [ ] **Step 6: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS, including `v2->v3 migration: all checks passed`.

- [ ] **Step 7: Verify against the real cache, read-only**

```bash
cp ~/.gemini/antigravity/brain/.deep_stats_cache.json /tmp/cache-backup-pre-v3.json
node -e "
const d=require('/tmp/cache-backup-pre-v3.json');
const e=d.perConvo['claude-code-imported'].entries;
const t=e.reduce((s,x)=>s+x.inp+x.out+x.cache+x.cacheWrite+x.reasoning,0);
console.log('entries:',e.length,'total:',t);
console.assert(e.length===175,'expected 175 entries'); console.assert(t===12942976240,'expected 12.94B');
console.log('baseline OK');
"
```

Keep `/tmp/cache-backup-pre-v3.json` until Branch 3 is merged. It is the only other copy of the archive.

- [ ] **Step 8: Commit**

```bash
git add src/services/usage/types.ts src/services/usage/cache.ts
git commit -m "feat(usage): v2->v3 cache migration that preserves the Claude archive"
```

---

### Task 2: Schema field and the provider test

**Files:**
- Modify: `src/services/usage/types.ts:55-66` (`TokenEntry`), self-check block

**Interfaces:**
- Consumes: `CACHE_SCHEMA_VERSION` from Task 1
- Produces: `TokenEntry.accountKey?: string`; `isClaudeConvo(cid: string): boolean`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── provider test ───
{
    assert.strictEqual(isClaudeConvo('claude:456d535f-1489-442b-a5dd-8f69c5acfc8e'), true,
        'prefixed session id is Claude');
    assert.strictEqual(isClaudeConvo('claude-code-imported'), true,
        'the legacy archive id is Claude and cannot be renamed');
    assert.strictEqual(isClaudeConvo('00b78c15-c64b-490f-8dec-7187d9e8c06a'), false,
        'a bare uuid is an Antigravity conversation');
    assert.strictEqual(isClaudeConvo('claude-code-something-else'), false,
        'only the exact legacy id is grandfathered, not any claude-code prefix');
    console.log('provider test: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — `isClaudeConvo is not defined`.

- [ ] **Step 3: Add the field and the helper**

In `src/services/usage/types.ts`, add to `TokenEntry` after `provider: string;`:

```typescript
    /** Provider-scoped account id. Absent means resolve via claudePins, or unknown. */
    accountKey?: string;
```

And after the `ConvoTokenData` interface:

```typescript
/** The archive predates the `claude:` prefix and keeps its id forever — renaming it orphans 12.94B tokens. */
export const LEGACY_CLAUDE_ARCHIVE_ID = 'claude-code-imported';

/** Single source of truth for "is this ledger key a Claude conversation". */
export function isClaudeConvo(cid: string): boolean {
    return cid.startsWith('claude:') || cid === LEGACY_CLAUDE_ARCHIVE_ID;
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `provider test: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add src/services/usage/types.ts
git commit -m "feat(usage): TokenEntry.accountKey and the single provider test"
```

---

### Task 3: Account discovery

**Files:**
- Create: `src/services/usage/claude/claudeAccounts.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface ClaudeAccount { email: string; accountUuid: string; organizationUuid?: string; seatTier?: string; accountCreatedAt?: string; root: string; }`
  - `discoverClaudeRoots(homeDir?: string, env?: NodeJS.ProcessEnv): string[]`
  - `readAccountForRoot(root: string): ClaudeAccount | null`
  - `discoverClaudeAccounts(): ClaudeAccount[]`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── Claude account discovery ───
{
    const { discoverClaudeRoots, readAccountForRoot } = require('./claude/claudeAccounts');
    const fsA = require('fs');
    const pathA = require('path');
    const osA = require('os');

    const tmp = fsA.mkdtempSync(pathA.join(osA.tmpdir(), 'ag-claude-accounts-'));

    // Layout A — CLAUDE_CONFIG_DIR style: identity INSIDE the root.
    const rootInside = pathA.join(tmp, 'inside');
    fsA.mkdirSync(pathA.join(rootInside, 'projects'), { recursive: true });
    fsA.writeFileSync(pathA.join(rootInside, '.claude.json'), JSON.stringify({
        oauthAccount: {
            emailAddress: 'inside@example.com', accountUuid: 'uuid-inside',
            organizationUuid: 'org-inside', seatTier: 'team_tier_1',
            accountCreatedAt: '2026-07-26T19:18:37.058600Z',
        },
    }));

    // Layout B — default style: identity ADJACENT to the root.
    const homeB = pathA.join(tmp, 'homeB');
    const rootAdjacent = pathA.join(homeB, '.claude');
    fsA.mkdirSync(pathA.join(rootAdjacent, 'projects'), { recursive: true });
    fsA.writeFileSync(pathA.join(homeB, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'adjacent@example.com', accountUuid: 'uuid-adjacent' },
    }));

    // Layout C — a valid root that was never logged into: no oauthAccount.
    const rootFresh = pathA.join(tmp, 'fresh');
    fsA.mkdirSync(pathA.join(rootFresh, 'projects'), { recursive: true });
    fsA.writeFileSync(pathA.join(rootFresh, '.claude.json'), JSON.stringify({
        userID: 'per-config-dir-id', machineID: 'per-machine-id', firstStartTime: 1,
    }));

    // Layout D — not a Claude root at all (no projects/).
    const notARoot = pathA.join(tmp, 'operon');
    fsA.mkdirSync(notARoot, { recursive: true });
    fsA.writeFileSync(pathA.join(notARoot, 'operon-cli.db'), 'x');

    const inside = readAccountForRoot(rootInside);
    assert.ok(inside, 'identity inside the root must resolve');
    assert.strictEqual(inside.email, 'inside@example.com');
    assert.strictEqual(inside.accountUuid, 'uuid-inside');
    assert.strictEqual(inside.accountCreatedAt, '2026-07-26T19:18:37.058600Z');

    const adjacent = readAccountForRoot(rootAdjacent);
    assert.ok(adjacent, 'identity adjacent to the root must resolve');
    assert.strictEqual(adjacent.email, 'adjacent@example.com');

    assert.strictEqual(readAccountForRoot(rootFresh), null,
        'a never-logged-in root has no account, and that is not an error');

    // CLAUDE_CONFIG_DIR wins when set and valid.
    assert.deepStrictEqual(
        discoverClaudeRoots(homeB, { CLAUDE_CONFIG_DIR: rootInside }), [rootInside],
        'CLAUDE_CONFIG_DIR takes precedence');
    assert.deepStrictEqual(
        discoverClaudeRoots(homeB, {}), [rootAdjacent],
        'default root is <home>/.claude');
    assert.deepStrictEqual(
        discoverClaudeRoots(tmp, { CLAUDE_CONFIG_DIR: notARoot }), [],
        'a dir without projects/ is not a root');

    console.log('claude account discovery: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — cannot find module `./claude/claudeAccounts`.

- [ ] **Step 3: Implement**

Create `src/services/usage/claude/claudeAccounts.ts`:

```typescript
/**
 * Claude Code account discovery — read-only.
 *
 * Enumerates config ROOTS, never credentials. The keychain holds a second
 * entry (`Claude Code-credentials-69ff85f3`) that is a dead artifact from an
 * abandoned Jul 2026 login; enumerating keychain entries would report a
 * phantom account. See the spec, §12.2.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeAccount {
    email: string;
    accountUuid: string;
    organizationUuid?: string;
    seatTier?: string;
    accountCreatedAt?: string;
    /** Config root this identity was read from. */
    root: string;
}

/** A root is a directory containing `projects/`. */
function isRoot(dir: string): boolean {
    try { return fs.statSync(path.join(dir, 'projects')).isDirectory(); }
    catch { return false; }
}

export function discoverClaudeRoots(
    homeDir: string = os.homedir(),
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const candidates = env.CLAUDE_CONFIG_DIR
        ? [env.CLAUDE_CONFIG_DIR]
        : [path.join(homeDir, '.claude')];
    return candidates.filter(isRoot);
}

/**
 * The identity file's position depends on how the root was configured:
 * INSIDE when CLAUDE_CONFIG_DIR is set, ADJACENT in the default layout.
 * Verified against Claude Code 2.1.263. Both must be tried.
 */
export function readAccountForRoot(root: string): ClaudeAccount | null {
    const candidates = [
        path.join(root, '.claude.json'),
        path.join(path.dirname(root), '.claude.json'),
    ];

    for (const file of candidates) {
        let parsed: any;
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); }
        catch { continue; }

        const o = parsed?.oauthAccount;
        // A valid root may legitimately have no oauthAccount — it is written on
        // login, not on init. Not an error, and must not log as one.
        if (!o?.emailAddress || !o?.accountUuid) continue;

        return {
            email: o.emailAddress,
            accountUuid: o.accountUuid,
            organizationUuid: o.organizationUuid,
            seatTier: o.seatTier,
            accountCreatedAt: o.accountCreatedAt,
            root,
        };
    }
    return null;
}

export function discoverClaudeAccounts(): ClaudeAccount[] {
    const byUuid = new Map<string, ClaudeAccount>();
    for (const root of discoverClaudeRoots()) {
        const acct = readAccountForRoot(root);
        if (acct && !byUuid.has(acct.accountUuid)) byUuid.set(acct.accountUuid, acct);
    }
    return [...byUuid.values()];
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `claude account discovery: all checks passed`.

- [ ] **Step 5: Sanity-check against the real machine**

```bash
node -e "
const {discoverClaudeRoots,discoverClaudeAccounts}=require('./out/services/usage/claude/claudeAccounts');
console.log('roots:',discoverClaudeRoots());
console.log('accounts:',discoverClaudeAccounts().map(a=>a.email+' / '+a.accountUuid));
"
```

Expected: one root (`/Users/mobyd/.claude`), one account (`varakorn.j@topgunthailand.com`).

- [ ] **Step 6: Commit**

```bash
git add src/services/usage/claude/claudeAccounts.ts src/services/usage/types.ts
git commit -m "feat(usage): discover Claude config roots and their identities"
```

---

### Task 4: Backlog attribution via pinned eras

**Files:**
- Create: `src/services/usage/claude/claudePins.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `LEGACY_CLAUDE_ARCHIVE_ID` from Task 2
- Produces:
  - `interface PinnedAccount { email: string; accountUuid: string; createdAt: string; }`
  - `resolveBacklogAccount(convoId: string, ts: string): PinnedAccount | null`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── pinned-era backlog attribution ───
{
    const { resolveBacklogAccount } = require('./claude/claudePins');

    // Rule 1 — the archive resolves by identity, not by row date. Its rows span
    // Jan-Jul and would otherwise straddle the date rules.
    const arch = resolveBacklogAccount('claude-code-imported', '2026-06-05T12:00:00.000Z');
    assert.ok(arch, 'archive must resolve');
    assert.strictEqual(arch.email, 'well.j@honestdocs.co');
    const archLate = resolveBacklogAccount('claude-code-imported', '2026-07-21T12:00:00.000Z');
    assert.strictEqual(archLate.email, 'well.j@honestdocs.co',
        'archive stays well.j even for rows dated after the switch');

    // Rule 3 — transcript era.
    const live = resolveBacklogAccount('claude:abc', '2026-07-30T10:00:00.000Z');
    assert.ok(live, 'transcript-era row must resolve');
    assert.strictEqual(live.email, 'varakorn.j@topgunthailand.com');

    // Rule 2 — defensive: a transcript older than the new account goes to well.j.
    const old = resolveBacklogAccount('claude:xyz', '2026-05-01T10:00:00.000Z');
    assert.strictEqual(old.email, 'well.j@honestdocs.co',
        'a pre-switch transcript must not be attributed to the newer account');

    // The accountCreatedAt guard: nothing predates well.j's own creation.
    assert.strictEqual(resolveBacklogAccount('claude:xyz', '2024-01-01T00:00:00.000Z'), null,
        'a row older than every known account is unknown, never guessed');

    // Boundary is inclusive of the created date going forward.
    assert.strictEqual(
        resolveBacklogAccount('claude:xyz', '2026-07-26T00:00:00.000Z').email,
        'varakorn.j@topgunthailand.com', 'the createdAt date itself belongs to the new account');
    assert.strictEqual(
        resolveBacklogAccount('claude:xyz', '2026-07-25T23:59:59.000Z').email,
        'well.j@honestdocs.co', 'the day before belongs to the old account');

    assert.strictEqual(resolveBacklogAccount('claude:xyz', ''), null,
        'a row with no timestamp is unknown');

    console.log('pinned-era attribution: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — cannot find module `./claude/claudePins`.

- [ ] **Step 3: Implement**

Create `src/services/usage/claude/claudePins.ts`:

```typescript
/**
 * Backlog account attribution.
 *
 * Transcripts carry no account stamp, and `~/.claude.json` holds only the
 * CURRENT account — it is overwritten on switch. Rows ingested from now on are
 * stamped exactly, at read time. Everything older is attributed here, from two
 * pinned eras recovered from dated .claude.json backups.
 *
 * This is inference. The accountCreatedAt guard is what keeps it honest: a row
 * dated before an account existed is never attributed to it.
 */

import { LEGACY_CLAUDE_ARCHIVE_ID } from '../types';

export interface PinnedAccount {
    email: string;
    accountUuid: string;
    createdAt: string;
}

const WELL: PinnedAccount = {
    email: 'well.j@honestdocs.co',
    accountUuid: '348cc96d-a86f-4963-9db5-bf1da5ba879a',
    createdAt: '2025-08-13',
};

const VARAKORN: PinnedAccount = {
    email: 'varakorn.j@topgunthailand.com',
    accountUuid: '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7',
    createdAt: '2026-07-26',
};

type Rule =
    | { convoId: string; account: PinnedAccount }
    | { before: string; account: PinnedAccount }
    | { from: string; account: PinnedAccount };

/** First match wins, in written order. A convoId rule beats a date rule. */
const PINNED_ERAS: Rule[] = [
    { convoId: LEGACY_CLAUDE_ARCHIVE_ID, account: WELL },
    { before: VARAKORN.createdAt, account: WELL },
    { from: VARAKORN.createdAt, account: VARAKORN },
];

export function resolveBacklogAccount(convoId: string, ts: string): PinnedAccount | null {
    for (const rule of PINNED_ERAS) {
        if ('convoId' in rule) {
            if (convoId === rule.convoId) return guard(rule.account, ts, convoId);
            continue;
        }
        if (!ts) return null;
        const day = ts.slice(0, 10);
        if ('before' in rule && day < rule.before) return guard(rule.account, ts, convoId);
        if ('from' in rule && day >= rule.from) return guard(rule.account, ts, convoId);
    }
    return null;
}

/**
 * A row cannot belong to an account that did not exist yet. The archive is
 * exempt: it is attributed by identity, and its own rows postdate WELL anyway.
 */
function guard(account: PinnedAccount, ts: string, convoId: string): PinnedAccount | null {
    if (convoId === LEGACY_CLAUDE_ARCHIVE_ID) return account;
    if (!ts) return null;
    return ts.slice(0, 10) >= account.createdAt ? account : null;
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `pinned-era attribution: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add src/services/usage/claude/claudePins.ts src/services/usage/types.ts
git commit -m "feat(usage): pinned-era backlog attribution with a createdAt guard"
```

- [ ] **Step 6: Confirm the branch is invisible**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
git log --oneline main..HEAD
```

Existing Antigravity numbers must be untouched — no aggregator or panel file was modified on this branch. Branch 1 is complete.

---

# Branch 2 — `feat/claude-ingest`

The reader. Claude data starts landing in the ledger.

- [ ] **Create the branch**

```bash
git checkout -b feat/claude-ingest
```

---

### Task 5: Read one transcript, normalize thinking

**Files:**
- Create: `src/services/usage/claude/claudeReader.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `TokenEntry` (Task 2)
- Produces: `readClaudeTranscript(filePath: string): Promise<TokenEntry[]>`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── Claude transcript reader ───
{
    const { readClaudeTranscript } = require('./claude/claudeReader');
    const fsR = require('fs');
    const pathR = require('path');
    const osR = require('os');

    const dir = fsR.mkdtempSync(pathR.join(osR.tmpdir(), 'ag-claude-reader-'));
    const file = pathR.join(dir, 'session-1.jsonl');

    const row = (o: any) => JSON.stringify(o);
    const usage = (over: any = {}) => Object.assign({
        input_tokens: 100, output_tokens: 1000,
        cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000,
        output_tokens_details: { thinking_tokens: 400 },
    }, over);

    fsR.writeFileSync(file, [
        // A three-row turn sharing one requestId: thinking, text, then tool_use.
        row({ type: 'assistant', requestId: 'req-1', timestamp: '2026-08-01T10:00:00.000Z',
              message: { model: 'claude-opus-4-8', usage: usage(),
                         content: [{ type: 'thinking', thinking: 'x' }] } }),
        row({ type: 'assistant', requestId: 'req-1', timestamp: '2026-08-01T10:00:01.000Z',
              message: { model: 'claude-opus-4-8', usage: usage(),
                         content: [{ type: 'text', text: 'hi' }] } }),
        row({ type: 'assistant', requestId: 'req-1', timestamp: '2026-08-01T10:00:02.000Z',
              message: { model: 'claude-opus-4-8', usage: usage(),
                         content: [{ type: 'tool_use', name: 'Bash' }] } }),
        // A second, genuinely separate call.
        row({ type: 'assistant', requestId: 'req-2', timestamp: '2026-08-01T10:01:00.000Z',
              message: { model: 'claude-sonnet-5',
                         usage: usage({ output_tokens: 500, output_tokens_details: undefined }),
                         content: [{ type: 'text', text: 'done' }] } }),
        // Non-assistant rows and a tool_result user row are not calls.
        row({ type: 'user', timestamp: '2026-08-01T10:00:30.000Z',
              message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
        row({ type: 'last-prompt', leafUuid: 'x', sessionId: 'session-1' }),
        // Synthetic model rows are not billable calls.
        row({ type: 'assistant', requestId: 'req-3', timestamp: '2026-08-01T10:02:00.000Z',
              message: { model: '<synthetic>', usage: usage(), content: [] } }),
        // Invariant violation: thinking > output. Must be skipped, not stored.
        row({ type: 'assistant', requestId: 'req-4', timestamp: '2026-08-01T10:03:00.000Z',
              message: { model: 'claude-opus-4-8',
                         usage: usage({ output_tokens: 10, output_tokens_details: { thinking_tokens: 999 } }),
                         content: [] } }),
        // A truncated line mid-write must not abort the file.
        '{"type":"assistant","requestId":"req-5","mess',
        '',
    ].join('\n'));

    const entries = await readClaudeTranscript(file);

    assert.strictEqual(entries.length, 2,
        'one entry per requestId: req-1 collapses 3 rows, req-2 is separate, req-3/4/5 excluded');

    const e1 = entries.find((e: any) => e.responseId === 'req-1');
    assert.ok(e1, 'req-1 must be present');
    assert.strictEqual(e1.model, 'claude-opus-4-8');
    assert.strictEqual(e1.provider, 'anthropic');
    assert.strictEqual(e1.inp, 100);
    assert.strictEqual(e1.cache, 50000);
    assert.strictEqual(e1.cacheWrite, 2000);

    // The normalization: thinking is a SUBSET of output_tokens, so it is split
    // out rather than added. out + reasoning must equal the reported output.
    assert.strictEqual(e1.reasoning, 400, 'thinking becomes reasoning');
    assert.strictEqual(e1.out, 600, 'out is output minus thinking');
    assert.strictEqual(e1.out + e1.reasoning, 1000,
        'out + reasoning must reconstruct the reported output_tokens exactly');

    const e2 = entries.find((e: any) => e.responseId === 'req-2');
    assert.strictEqual(e2.reasoning, 0, 'absent output_tokens_details means zero reasoning');
    assert.strictEqual(e2.out, 500, 'and out is the full output');

    assert.ok(!entries.some((e: any) => e.responseId === 'req-4'),
        'an entry violating thinking <= output must be skipped');
    assert.ok(!entries.some((e: any) => e.model === '<synthetic>'),
        'synthetic rows are not billable calls');

    console.log('claude transcript reader: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — cannot find module `./claude/claudeReader`.

- [ ] **Step 3: Implement**

Create `src/services/usage/claude/claudeReader.ts`:

```typescript
/**
 * One Claude Code transcript -> TokenEntry[].
 *
 * Two things make this non-obvious:
 *
 * 1. One assistant turn spans 1-8 JSONL rows sharing a `requestId` (thinking,
 *    text and tool_use arrive as separate rows, each repeating the same usage
 *    block). `requestId` is the unit of one API call, and the dedupe key.
 *    Counting rows overstates calls by ~2.3x.
 *
 * 2. `output_tokens_details.thinking_tokens` is a BREAKDOWN of `output_tokens`,
 *    not an addend — unlike Gemini, where reasoning is a disjoint bucket. The
 *    aggregator's total is additive, so thinking is split out of output here.
 *    That keeps `out + reasoning === output_tokens` and needs no aggregator change.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { TokenEntry } from '../types';
import { createLogger } from '../../../utils/logger';

const log = createLogger('ClaudeReader');

export async function readClaudeTranscript(filePath: string): Promise<TokenEntry[]> {
    const byRequest = new Map<string, TokenEntry>();
    let violations = 0;

    // Streamed: active transcripts reach tens of megabytes.
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line || line.indexOf('"usage"') === -1) continue;

        let row: any;
        // A transcript being appended to can end mid-line. Skip it, keep going.
        try { row = JSON.parse(line); } catch { continue; }

        if (row.type !== 'assistant') continue;

        const msg = row.message;
        const u = msg?.usage;
        if (!u || typeof u !== 'object') continue;

        const model = msg.model;
        if (!model || model === '<synthetic>') continue;

        const key = row.requestId || msg.id;
        if (!key || byRequest.has(key)) continue;

        const output = u.output_tokens ?? 0;
        const thinking = u.output_tokens_details?.thinking_tokens ?? 0;

        if (thinking > output) {
            violations++;
            continue;
        }

        byRequest.set(key, {
            responseId: key,
            source: 'metadata',
            inp: u.input_tokens ?? 0,
            out: output - thinking,
            cache: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            reasoning: thinking,
            model,
            provider: 'anthropic',
            ts: row.timestamp || '',
        });
    }

    if (violations > 0) {
        log.warn(`${filePath}: skipped ${violations} entries with thinking > output_tokens`);
    }

    return [...byRequest.values()];
}
```

If `source: 'metadata'` is not assignable, check the `TokenEntrySource` union in `types.ts` and use its metadata member; `mergePreferredEntry` treats `'metadata'` as authoritative, which is what we want for a file-derived read.

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `claude transcript reader: all checks passed`.

- [ ] **Step 5: Verify against a real transcript**

```bash
node -e "
const {readClaudeTranscript}=require('./out/services/usage/claude/claudeReader');
const f=require('child_process').execSync('ls -S \$HOME/.claude/projects/*/*.jsonl | head -1').toString().trim();
readClaudeTranscript(f).then(es=>{
  const sum=k=>es.reduce((s,e)=>s+e[k],0);
  console.log('file:',f); console.log('calls:',es.length);
  console.log('in',sum('inp'),'out',sum('out'),'reasoning',sum('reasoning'),'cacheRd',sum('cache'));
  console.assert(es.every(e=>e.reasoning<=e.out+e.reasoning),'invariant');
});
"
```

Expected: a plausible call count well below the raw row count, and non-zero reasoning.

- [ ] **Step 6: Commit**

```bash
git add src/services/usage/claude/claudeReader.ts src/services/usage/types.ts
git commit -m "feat(usage): Claude transcript reader with thinking normalized out of output"
```

---

### Task 6: Discover transcripts and build the ledger fragment

**Files:**
- Create: `src/services/usage/claude/index.ts`
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `readClaudeTranscript` (Task 5), `discoverClaudeRoots`/`readAccountForRoot` (Task 3)
- Produces:
  - `ledgerIdFor(transcriptPath: string): string`
  - `discoverClaudeTranscripts(roots?: string[]): string[]`
  - `interface IngestOptions { roots?: string[]; mtimes?: Record<string, number>; }`
  - `interface IngestResult { perConvo: Record<string, ConvoTokenData>; mtimes: Record<string, number>; ids: string[]; }`
  - `ingestClaudeUsage(opts?: IngestOptions): Promise<IngestResult>`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── Claude ingestion: keys, dedupe across files, mtime delta ───
{
    const { discoverClaudeTranscripts, ingestClaudeUsage } = require('./claude');
    const fsI = require('fs');
    const pathI = require('path');
    const osI = require('os');

    const root = fsI.mkdtempSync(pathI.join(osI.tmpdir(), 'ag-claude-ingest-'));
    const proj = pathI.join(root, 'projects', '-Users-someone-repo');
    fsI.mkdirSync(proj, { recursive: true });

    const usage = { input_tokens: 1, output_tokens: 100,
                    cache_read_input_tokens: 10, cache_creation_input_tokens: 2,
                    output_tokens_details: { thinking_tokens: 40 } };
    const mk = (rid: string, ts: string) => JSON.stringify({
        type: 'assistant', requestId: rid, timestamp: ts,
        message: { model: 'claude-opus-4-8', usage, content: [{ type: 'text', text: 'x' }] },
    });

    const sessA = pathI.join(proj, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
    const sessB = pathI.join(proj, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
    fsI.writeFileSync(sessA, [mk('shared-req', '2026-08-01T10:00:00.000Z'),
                              mk('only-a',     '2026-08-01T10:01:00.000Z')].join('\n'));
    // `shared-req` appears in BOTH files — a resumed session replays it.
    fsI.writeFileSync(sessB, [mk('shared-req', '2026-08-01T10:00:00.000Z'),
                              mk('only-b',     '2026-08-02T10:00:00.000Z')].join('\n'));

    const found = discoverClaudeTranscripts([root]);
    assert.strictEqual(found.length, 2, 'both transcripts discovered');

    const first = await ingestClaudeUsage({ roots: [root] });

    assert.deepStrictEqual(
        Object.keys(first.perConvo).sort(),
        ['claude:aaaaaaaa-1111-2222-3333-444444444444',
         'claude:bbbbbbbb-1111-2222-3333-444444444444'],
        'ledger keys are claude:<sessionId>');

    const total = Object.values(first.perConvo)
        .reduce((n: number, c: any) => n + c.entries.length, 0);
    assert.strictEqual(total, 4,
        'each session stores what its own file contains — 2 + 2. `shared-req` ' +
        'legitimately appears in both, because a resumed session replays it.');

    // Cross-file dedupe is NOT this layer's job: aggregateFromPerConvo already
    // carries a `seenGlobally` set keyed on responseId for exactly this case
    // (sub-agent trajectories recording a parent's call). Duplicating it here
    // would double-suppress and undercount.
    const { aggregateFromPerConvo } = require('./aggregator');
    const agg = aggregateFromPerConvo(first.perConvo, new Map(), '');
    assert.strictEqual(agg.totalCalls, 3,
        'the aggregator collapses the replayed responseId across sessions');

    for (const c of Object.values(first.perConvo) as any[]) {
        for (const e of c.entries) {
            assert.strictEqual(e.out + e.reasoning, 100, 'normalization survives ingestion');
            assert.ok(e.accountKey === undefined || typeof e.accountKey === 'string');
        }
    }

    assert.strictEqual(Object.keys(first.mtimes).length, 2, 'mtimes recorded per session');

    // Second pass with the same mtimes must skip everything.
    const second = await ingestClaudeUsage({ roots: [root], mtimes: first.mtimes });
    assert.strictEqual(Object.keys(second.perConvo).length, 0,
        'unchanged transcripts are skipped entirely');

    // Touch one file: only that one comes back.
    const later = Date.now() / 1000 + 10;
    fsI.utimesSync(sessA, later, later);
    const third = await ingestClaudeUsage({ roots: [root], mtimes: first.mtimes });
    assert.deepStrictEqual(Object.keys(third.perConvo),
        ['claude:aaaaaaaa-1111-2222-3333-444444444444'],
        'only the changed transcript is re-read');

    console.log('claude ingestion: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — cannot find module `./claude`.

- [ ] **Step 3: Implement**

Create `src/services/usage/claude/index.ts`:

```typescript
/**
 * Claude usage ingestion — filesystem only.
 *
 * Deliberately has no ServerInfo dependency: unlike the Antigravity store path,
 * this works with no language server running.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConvoTokenData, TokenEntry } from '../types';
import { readClaudeTranscript } from './claudeReader';
import { discoverClaudeRoots, readAccountForRoot } from './claudeAccounts';

export interface IngestOptions {
    /** Override roots (tests). Defaults to discovered roots. */
    roots?: string[];
    /** Previously recorded mtimes, keyed by ledger id. Unchanged files are skipped. */
    mtimes?: Record<string, number>;
}

export interface IngestResult {
    perConvo: Record<string, ConvoTokenData>;
    mtimes: Record<string, number>;
    ids: string[];
}

/** `claude:<sessionId>` — the prefix keeps Claude and Antigravity id spaces disjoint. */
export function ledgerIdFor(transcriptPath: string): string {
    return `claude:${path.basename(transcriptPath, '.jsonl')}`;
}

export function discoverClaudeTranscripts(roots: string[] = discoverClaudeRoots()): string[] {
    const out: string[] = [];
    for (const root of roots) {
        const projects = path.join(root, 'projects');
        let slugs: string[];
        try { slugs = fs.readdirSync(projects); } catch { continue; }
        for (const slug of slugs) {
            const dir = path.join(projects, slug);
            let files: string[];
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
            }
        }
    }
    return out;
}

export async function ingestClaudeUsage(opts: IngestOptions = {}): Promise<IngestResult> {
    const roots = opts.roots ?? discoverClaudeRoots();
    const known = opts.mtimes ?? {};

    // The active account stamps rows read now. Everything older is resolved by
    // claudePins at aggregation time.
    const activeKey = roots
        .map(readAccountForRoot)
        .find((a) => a)?.accountUuid;

    const perConvo: Record<string, ConvoTokenData> = {};
    const mtimes: Record<string, number> = {};
    const ids: string[] = [];

    for (const file of discoverClaudeTranscripts(roots)) {
        const id = ledgerIdFor(file);
        ids.push(id);

        let mtime: number;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        mtimes[id] = mtime;

        if (known[id] === mtime) continue;   // unchanged, skip the parse

        const entries: TokenEntry[] = await readClaudeTranscript(file);
        if (entries.length === 0) continue;

        if (activeKey) for (const e of entries) e.accountKey = activeKey;
        perConvo[id] = { entries };
    }

    return { perConvo, mtimes, ids };
}
```

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `claude ingestion: all checks passed`.

Note: the `shared-req` assertion expects 3 entries, meaning the duplicate is stored once *per ledger id* — `sessA` keeps it, `sessB` does not. If the implementation stores it in both (4 entries), add a module-level `seen` set across files within one `ingestClaudeUsage` call, matching `aggregateFromPerConvo`'s existing cross-conversation dedupe comment.

- [ ] **Step 5: Commit**

```bash
git add src/services/usage/claude/index.ts src/services/usage/types.ts
git commit -m "feat(usage): discover Claude transcripts and ingest with mtime delta"
```

---

### Task 7: Wire ingestion into the refresh path

**Files:**
- Modify: `src/services/usage/index.ts` (`refreshFromStore`, around `:246`)

**Interfaces:**
- Consumes: `ingestClaudeUsage` (Task 6), `mergeIntoLedger` (existing, `cache.ts`)
- Produces: Claude entries present in the persisted ledger after a refresh

- [ ] **Step 1: Read the existing merge site**

```bash
grep -n "mergeIntoLedger\|this.cache.write\|presentIds" src/services/usage/index.ts
```

Understand how `presentIds` is built before changing anything. Claude ids must be included in `presentIds` when their file exists, or `mergeIntoLedger` will treat them as fileless and never update them.

- [ ] **Step 2: Add the ingestion call**

In `refreshFromStore`, after the Antigravity per-convo map is assembled and before the ledger merge:

```typescript
        // Claude ingestion is independent of the language server and runs even
        // when the Antigravity store path finds nothing.
        let claudeMtimes: Record<string, number> = {};
        try {
            const claude = await ingestClaudeUsage({
                mtimes: this.claudeMtimes,
            });
            Object.assign(freshPerConvo, claude.perConvo);
            for (const id of claude.ids) presentIds.add(id);
            claudeMtimes = claude.mtimes;
        } catch (e: any) {
            log.warn('Claude ingestion failed; Antigravity data unaffected:', e?.message);
        }
        this.claudeMtimes = { ...this.claudeMtimes, ...claudeMtimes };
```

Add the field to the class alongside the other cached state near `:49`:

```typescript
    private claudeMtimes: Record<string, number> = {};
```

And the import at the top of the file:

```typescript
import { ingestClaudeUsage } from './claude';
```

Adapt `freshPerConvo` and `presentIds` to the actual local names at the merge site — do not rename existing locals.

- [ ] **Step 3: Persist the Claude mtimes**

`claudeMtimes` must survive a restart or every launch re-parses 403 MB. Reuse the existing `mtimes` field on `DiskCacheData` — already `Record<string, number>` keyed by ledger id, and Claude ids are namespaced so they cannot collide.

Where the service loads the disk cache (the method that reads `diskCache` and populates `this.currentPerConvo`), seed the Claude mtimes from it:

```typescript
        // Claude ids are namespaced, so the shared mtimes map is safe to split.
        this.claudeMtimes = Object.fromEntries(
            Object.entries(diskCache.mtimes ?? {}).filter(([id]) => isClaudeConvo(id)),
        );
```

Where the cache is written, merge them back in so they persist:

```typescript
            mtimes: { ...convoMtimes, ...this.claudeMtimes },
```

Add `isClaudeConvo` to the existing import from `./types`. Adapt `convoMtimes` to the actual local name at the write site.

- [ ] **Step 4: Verify the performance budget from the spec (§9)**

```bash
node -e "
const {ingestClaudeUsage}=require('./out/services/usage/claude');
(async()=>{
  let t=Date.now(); const cold=await ingestClaudeUsage({});
  const coldMs=Date.now()-t;
  const sessions=Object.keys(cold.perConvo).length;
  t=Date.now(); await ingestClaudeUsage({mtimes:cold.mtimes});
  const warmMs=Date.now()-t;
  console.log('cold rebuild:',coldMs,'ms over',sessions,'sessions  (budget 15000)');
  console.log('no-change refresh:',warmMs,'ms  (budget 20)');
  if(coldMs>15000) console.error('COLD OVER BUDGET — consider byte-offset tailing');
  if(warmMs>20) console.error('NO-CHANGE OVER BUDGET — mtime gate is not short-circuiting');
})();
"
```

A no-change pass over budget means the mtime gate is being bypassed and every refresh is re-parsing the corpus. Fix that before continuing rather than accepting a slow panel.

- [ ] **Step 5: Compile and run all self-checks**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS, all sections.

- [ ] **Step 6: Verify end to end in the extension host**

Launch the extension (F5), open the usage panel, and confirm:
- Antigravity totals are unchanged from before the branch.
- Claude entries are present in `~/.gemini/antigravity/brain/.deep_stats_cache.json` under `claude:` keys.
- `claude-code-imported` is still present with 175 entries.

```bash
node -e "
const d=require(process.env.HOME+'/.gemini/antigravity/brain/.deep_stats_cache.json');
const ks=Object.keys(d.perConvo);
console.log('schemaVersion:',d.schemaVersion);
console.log('claude: keys:',ks.filter(k=>k.startsWith('claude:')).length);
console.log('archive entries:',d.perConvo['claude-code-imported']?.entries.length);
"
```

Expected: `schemaVersion: 3`, a non-zero count of `claude:` keys, archive still `175`.

- [ ] **Step 7: Commit**

```bash
git add src/services/usage/index.ts
git commit -m "feat(usage): ingest Claude usage during refresh, independent of the language server"
```

---

# Branch 3 — `feat/claude-panel`

Presentation, provider split, pricing fix.

- [ ] **Create the branch**

```bash
git checkout -b feat/claude-panel
```

---

### Task 8: Pricing resolves every Claude model id

**Files:**
- Modify: `src/services/litellmPricing.ts:99-103` (`normalize`)
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `resolveLiteLlmPricing` (existing)
- Produces: `normalize()` maps bare `fable-*` to `claude-fable-*`

- [ ] **Step 1: Write the failing self-check**

This one needs the network. Append inside the `--self-check` block:

```typescript
// ─── pricing resolves every Claude model id in the data ───
{
    const { initPricingCatalog, resolveLiteLlmPricing } = require('../litellmPricing');
    await initPricingCatalog();

    const ids = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-5', 'fable-5',
                 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-5',
                 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929',
                 'claude-fable-5-1'];

    const unresolved = ids.filter((m) => !resolveLiteLlmPricing(m));
    if (resolveLiteLlmPricing('claude-opus-4-8')) {
        assert.deepStrictEqual(unresolved, [],
            'every Claude model id present in the ledger must resolve to pricing');
        console.log('pricing resolution: all checks passed');
    } else {
        console.log('pricing resolution: SKIPPED (catalog unavailable — offline?)');
    }
}
```

The guard matters: a silent pass when the catalog failed to load would be worse than no test. A clearly printed skip is honest.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — `unresolved` is `['fable-5']`.

- [ ] **Step 3: Add the prefix mapping**

In `src/services/litellmPricing.ts`, extend `normalize`:

```typescript
function normalize(name: string): string {
    return name.toLowerCase()
        .replace(/^(models[/\-_]|vertex_ai\/|anthropic\/|google\/|openai\/)/, '')
        // Claude Code reports some ids without the vendor prefix the catalog
        // uses: `fable-5` vs `claude-fable-5`. Worth 320.8M tokens of otherwise
        // silently-free usage in the archive alone.
        .replace(/^fable-/, 'claude-fable-')
        .trim();
}
```

Safe in both directions: `normalize` runs over catalog keys too, and no catalog key starts with `fable-`.

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `pricing resolution: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add src/services/litellmPricing.ts src/services/usage/types.ts
git commit -m "fix(pricing): resolve bare fable-5 to the catalog's claude-fable-5"
```

---

### Task 9: Provider partition

**Files:**
- Modify: `src/services/usage/aggregator.ts` (append; do not alter `aggregateFromPerConvo`)
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `aggregateFromPerConvo(perConvo, titleMap, dateFilter)` (existing), `isClaudeConvo` (Task 2)
- Produces:
  - `interface ProviderSplit { claude: DeepUsageStats; antigravity: DeepUsageStats; }`
  - `aggregateByProvider(perConvo: Record<string, ConvoTokenData>, titleMap: Map<string, string>, dateFilter?: DateFilter): ProviderSplit`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── provider partition ───
{
    const { aggregateByProvider } = require('./aggregator');

    const entry = (rid: string, ts: string, provider: string, model: string) => ({
        responseId: rid, source: 'metadata', inp: 1, out: 10, cache: 100,
        cacheWrite: 5, reasoning: 4, model, provider, ts,
    });

    const perConvo: any = {
        'claude:sess-1': { entries: [entry('r1', '2026-08-01T10:00:00.000Z', 'anthropic', 'claude-opus-4-8')] },
        'claude-code-imported': { entries: [entry('cc-1', '2026-06-01T12:00:00.000Z', 'anthropic', 'claude-opus-4-7')] },
        '00b78c15-c64b-490f-8dec-7187d9e8c06a': {
            entries: [entry('g1', '2026-08-01T11:00:00.000Z', 'API_PROVIDER_GOOGLE_GEMINI', 'MODEL_PLACEHOLDER_M20')] },
    };

    const split = aggregateByProvider(perConvo, new Map(), '');

    assert.strictEqual(split.claude.totalCalls, 2,
        'the claude: session and the legacy archive both count as Claude');
    assert.strictEqual(split.antigravity.totalCalls, 1, 'the bare uuid is Antigravity');

    const per = 1 + 10 + 100 + 5 + 4;
    assert.strictEqual(split.claude.totalTokens, per * 2);
    assert.strictEqual(split.antigravity.totalTokens, per);

    // Nothing was lost or double-counted in the partition: the two sides must
    // account for every entry exactly once.
    assert.strictEqual(
        split.claude.totalCalls + split.antigravity.totalCalls, 3,
        'partition is exhaustive and disjoint');

    // An empty side must be a valid zeroed stats object, not a crash or null.
    const onlyClaude = aggregateByProvider(
        { 'claude:x': perConvo['claude:sess-1'] } as any, new Map(), '');
    assert.strictEqual(onlyClaude.antigravity.totalCalls, 0);
    assert.strictEqual(onlyClaude.antigravity.totalTokens, 0);
    assert.ok(Array.isArray(onlyClaude.antigravity.daily), 'zeroed side still has bucket arrays');

    console.log('provider partition: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — `aggregateByProvider is not a function`.

- [ ] **Step 3: Implement**

Append to `src/services/usage/aggregator.ts`:

```typescript
export interface ProviderSplit {
    claude: DeepUsageStats;
    antigravity: DeepUsageStats;
}

/**
 * Partition the ledger by provider and aggregate each side independently.
 *
 * Deliberately a wrapper rather than a change to aggregateFromPerConvo. That
 * function is the only producer of every headline number in the panel, and
 * threading a provider conditional through its eight bucket builders is how a
 * silently-wrong total gets shipped. Partitioning the input costs one shallow
 * object split and reuses every bucket builder unchanged.
 */
export function aggregateByProvider(
    perConvo: Record<string, ConvoTokenData>,
    titleMap: Map<string, string>,
    dateFilter: DateFilter = '',
): ProviderSplit {
    const claudeConvos: Record<string, ConvoTokenData> = {};
    const antigravityConvos: Record<string, ConvoTokenData> = {};

    for (const [cid, data] of Object.entries(perConvo)) {
        (isClaudeConvo(cid) ? claudeConvos : antigravityConvos)[cid] = data;
    }

    return {
        claude: aggregateFromPerConvo(claudeConvos, titleMap, dateFilter),
        antigravity: aggregateFromPerConvo(antigravityConvos, titleMap, dateFilter),
    };
}
```

Add `isClaudeConvo` to the existing import from `./types`.

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `provider partition: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add src/services/usage/aggregator.ts src/services/usage/types.ts
git commit -m "feat(usage): aggregate per provider by partitioning the ledger"
```

---

### Task 10: Panel — provider sections, account facet, honesty markers

**Files:**
- Modify: `src/providers/usageStatsPanel.ts:252` (hero), `:377` (model breakdown)
- Modify: `src/shared/usage-components.ts` (a new account-facet renderer)
- Modify: `src/services/usage/types.ts` (self-check)

**Interfaces:**
- Consumes: `aggregateByProvider` (Task 9), `resolveBacklogAccount` (Task 4), `discoverClaudeAccounts` (Task 3)
- Produces:
  - `interface AccountFacetRow { label: string; accountUuid: string | null; tokens: number; calls: number | null; from: string; to: string; note?: string; }`
  - `accountFacetFor(perConvo: Record<string, ConvoTokenData>): AccountFacetRow[]`
  - `renderProviderSection(title: string, stats: DeepUsageStats, facet: AccountFacetRow[]): string`

- [ ] **Step 1: Write the failing self-check**

Append inside the `--self-check` block:

```typescript
// ─── account facet and honesty markers ───
{
    const { accountFacetFor } = require('../../shared/usage-components');

    const entry = (rid: string, ts: string, accountKey?: string) => ({
        responseId: rid, source: 'metadata', inp: 0, out: 100, cache: 0,
        cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8',
        provider: 'anthropic', ts, accountKey,
    });

    const perConvo: any = {
        // Stamped at read time.
        'claude:sess-1': { entries: [
            entry('r1', '2026-08-01T10:00:00.000Z', '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7')] },
        // Unstamped archive — must resolve through pins, not show as unknown.
        'claude-code-imported': { entries: [entry('cc-1', '2026-06-01T12:00:00.000Z')] },
    };

    const rows = accountFacetFor(perConvo);

    const vara = rows.find((r: any) => r.accountUuid === '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7');
    assert.ok(vara, 'the stamped account appears');
    assert.strictEqual(vara.tokens, 100);
    assert.strictEqual(vara.calls, 1, 'a real call count for read-time rows');

    const well = rows.find((r: any) => r.accountUuid === '348cc96d-a86f-4963-9db5-bf1da5ba879a');
    assert.ok(well, 'the archive resolves to well.j via pins, not to unknown');

    assert.strictEqual(well.calls, null,
        'the archive is a day rollup — its call count is an artifact and must never render as a number');
    assert.ok(/thinking/i.test(well.note || ''),
        'the archive must be marked as not breaking out thinking');

    console.log('account facet: all checks passed');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: FAIL — `accountFacetFor is not a function`.

- [ ] **Step 3: Implement the facet builder**

Append to `src/shared/usage-components.ts`:

```typescript
export interface AccountFacetRow {
    label: string;
    accountUuid: string | null;
    tokens: number;
    /** null when the underlying rows are day rollups, where a count is meaningless. */
    calls: number | null;
    from: string;
    to: string;
    note?: string;
}

/**
 * Group Claude usage by account.
 *
 * Rows read after this feature shipped carry `accountKey`. Older rows do not,
 * and resolve through claudePins. The archive is a day rollup: one entry per
 * model per day, so counting its entries yields 175 for six months of work.
 * That renders as null, never as a number.
 */
const ROLLUP_NOTE = 'day rollup — thinking not broken out';

export function accountFacetFor(
    perConvo: Record<string, ConvoTokenData>,
): AccountFacetRow[] {
    // Stamped rows carry a uuid; look up the email so the panel never shows a raw uuid.
    const emailByUuid = new Map<string, string>();
    for (const a of discoverClaudeAccounts()) emailByUuid.set(a.accountUuid, a.email);

    const acc = new Map<string, AccountFacetRow>();
    // An account whose usage includes any rollup conversation cannot report a
    // real call count for that portion, so the whole row surrenders the number.
    const rollupAccounts = new Set<string>();

    for (const [cid, data] of Object.entries(perConvo)) {
        if (!isClaudeConvo(cid)) continue;
        const isRollup = cid === LEGACY_CLAUDE_ARCHIVE_ID;

        for (const e of data.entries) {
            const pinned = resolveBacklogAccount(cid, e.ts);
            const uuid = e.accountKey ?? pinned?.accountUuid ?? null;
            const key = uuid ?? 'unknown';
            if (isRollup) rollupAccounts.add(key);

            let row = acc.get(key);
            if (!row) {
                row = {
                    // A pinned email may only label the uuid it actually resolved to.
                    // Falling back to it for a stamped row would attach a date-derived
                    // name to an account that disagrees with it.
                    label: (uuid ? emailByUuid.get(uuid) : undefined)
                        ?? (pinned && pinned.accountUuid === uuid ? pinned.email : undefined)
                        ?? uuid ?? 'unknown account',
                    accountUuid: uuid,
                    tokens: 0,
                    calls: 0,
                    from: e.ts, to: e.ts,
                };
                acc.set(key, row);
            }

            row.tokens += e.inp + e.out + e.cache + e.cacheWrite + e.reasoning;
            if (row.calls !== null) row.calls++;
            if (e.ts && e.ts < row.from) row.from = e.ts;
            if (e.ts && e.ts > row.to) row.to = e.ts;
        }
    }

    for (const key of rollupAccounts) {
        const row = acc.get(key);
        if (row) { row.calls = null; row.note = ROLLUP_NOTE; }
    }

    return [...acc.values()].sort((a, b) => b.tokens - a.tokens);
}
```

Add imports at the top of the file: `isClaudeConvo`, `LEGACY_CLAUDE_ARCHIVE_ID`, `ConvoTokenData` from `../services/usage/types`; `resolveBacklogAccount` from `../services/usage/claude/claudePins`; `discoverClaudeAccounts` from `../services/usage/claude/claudeAccounts`.

Note `resolveBacklogAccount` is called even for stamped rows — only its `email` is used there, never its uuid, so a stamped row's attribution still wins. That is what lets a stamped row show an email when `discoverClaudeAccounts()` cannot see that account any more, which is exactly the case for a signed-out account.

- [ ] **Step 4: Run the self-check and verify it passes**

```bash
npm run compile:extension && node out/services/usage/types.js --self-check
```

Expected: PASS with `account facet: all checks passed`.

- [ ] **Step 5: Render the provider sections**

Add to `src/shared/usage-components.ts`, following the file's existing `up-`-prefixed class convention:

```typescript
/**
 * One provider block: its own totals, its accounts beneath.
 *
 * There is deliberately no cross-provider total anywhere in this component.
 * On measured data a summed headline is ~97% Claude and describes neither tool.
 */
export function renderProviderSection(
    title: string,
    stats: DeepUsageStats,
    facet: AccountFacetRow[],
): string {
    if (stats.totalCalls === 0 && stats.totalTokens === 0) return '';

    const day = (ts: string) => (ts ? ts.slice(0, 10) : '—');

    let html = `<div class="up-provider">`;
    html += `<div class="up-provider-head">`;
    html += `<span class="up-provider-name">${escapeHtml(title)}</span>`;
    html += `<span class="up-provider-tokens">${fmtBig(stats.totalTokens)}</span>`;
    html += `<span class="up-provider-calls">${stats.totalCalls.toLocaleString()} calls</span>`;
    html += `</div>`;

    for (const row of facet) {
        // A rollup row has no honest call count. Render an em dash, never a number.
        const calls = row.calls === null
            ? `<span class="up-acct-calls up-muted" title="${escapeHtml(row.note ?? '')}">—</span>`
            : `<span class="up-acct-calls">${row.calls.toLocaleString()} calls</span>`;
        const warn = row.note
            ? ` <span class="up-warn" title="${escapeHtml(row.note)}">⚠</span>`
            : '';
        html += `<div class="up-acct">`;
        html += `<span class="up-acct-label">${escapeHtml(row.label)}</span>`;
        html += `<span class="up-acct-tokens">${fmtBig(row.tokens)}</span>`;
        html += calls;
        html += `<span class="up-acct-range">${day(row.from)} – ${day(row.to)}</span>${warn}`;
        html += `</div>`;
    }

    return html + `</div>`;
}
```

Reuse the file's existing `fmtBig` and its HTML-escaping helper; if the escaper is named differently, use that name rather than adding a second one.

Then in `src/providers/usageStatsPanel.ts`, replace the single hero at `:252` with:

```typescript
        const split = aggregateByProvider(perConvo, titleMap, dateFilter);
        const claudeFacet = accountFacetFor(perConvo);

        html += renderProviderSection('Claude Code', split.claude, claudeFacet);
        html += renderProviderSection('Antigravity', split.antigravity, []);
```

Take `perConvo`, `titleMap` and `dateFilter` from whatever the panel already has in scope at that point; do not re-read the cache here.

Target rendered shape:

```
Claude Code                     15.04B                       2 accounts
  varakorn.j@topgunthailand.com  2.09B    5,255 calls   2026-07-30 – 2026-09-06
  well.j@honestdocs.co          12.94B    —             2026-01-22 – 2026-07-21  ⚠
Antigravity                      0.53B    5,151 calls
```

Two remaining requirements, both load-bearing:

- A model with no resolved pricing renders tokens and calls with the **cost cell blank**. Never `$0.00`. Find the cost cell near `:312` (`costPerToken`) and guard it on a resolved price.
- Set `countingChangedAt` when Claude ingestion first contributes, since Claude totals appear where there previously were none. Write it in `src/services/usage/index.ts` at the point Claude entries first land, not in the panel.

- [ ] **Step 6: Verify visually in the extension host**

Launch (F5), open the usage panel. Confirm against the numbers measured 2026-09-06: Claude ≈15.04B across two accounts, Antigravity ≈0.53B / 5,151 calls, archive marked as a rollup with no call number.

- [ ] **Step 7: Commit**

```bash
git add src/providers/usageStatsPanel.ts src/shared/usage-components.ts src/services/usage/types.ts
git commit -m "feat(usage): per-provider sections with an account facet and rollup markers"
```

---

## Merge order

```bash
git checkout main && git merge --ff-only feat/claude-foundation
git merge --ff-only feat/claude-ingest
git merge --ff-only feat/claude-panel
```

Do not push or publish a VSIX as part of this plan. Keep `/tmp/cache-backup-pre-v3.json` until Branch 3 is merged and verified.

## Rollback

Each branch reverts independently. Reverting `feat/claude-foundation` reverts the schema, which discards Claude rows; the archive survives because `mergeIntoLedger` preserves fileless conversations. If the cache is ever lost, restore `/tmp/cache-backup-pre-v3.json` — it is the only other copy of the archive.
