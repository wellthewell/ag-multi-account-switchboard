/**
 * Shared types and constants for the usage stats pipeline.
 */

import { DeepUsageStats } from '../../types';

// ─── Constants ───

export const BATCH_CONCURRENCY = 50;      // max parallel API calls per chunk
export const HOT_THRESHOLD_MS = 48 * 3600 * 1000;  // "hot" if modified within 48h
export const FETCH_TIMEOUT_MS = 6000;     // per-call timeout for metadata/steps fetch
export const CACHE_SCHEMA_VERSION = 3;

export const EP = {
    TRAJECTORIES: 'GetAllCascadeTrajectories',
    METADATA: 'GetCascadeTrajectoryGeneratorMetadata',
    STEPS: 'GetCascadeTrajectorySteps',
} as const;

// ─── API Response Interfaces ───

/** Token usage fields returned by the Metadata API (camelCase or snake_case from protobuf) */
export interface MetadataUsage {
    inputTokens?: string;
    input_tokens?: string;
    outputTokens?: string;
    output_tokens?: string;
    responseOutputTokens?: string;
    response_output_tokens?: string;
    cacheReadTokens?: string;
    cache_read_tokens?: string;
    cacheCreationInputTokens?: string;
    cache_creation_input_tokens?: string;
    cacheWriteTokens?: string;
    cache_write_tokens?: string;
    thinkingOutputTokens?: string;
    thinking_output_tokens?: string;
    reasoningTokens?: string;
    reasoning_tokens?: string;
    apiProvider?: string;
    api_provider?: string;
    model?: string;
    contextTokens?: string;
    context_tokens?: string;
    responseId?: string;
    response_id?: string;
}


// ─── Internal Cache Types ───

export type TokenEntrySource = 'metadata' | 'steps';

/** Single API call's token data (stored in disk cache) */
export interface TokenEntry {
    responseId?: string; // stable model-call id from metadata/steps APIs
    source?: TokenEntrySource;
    inp: number;
    out: number;
    cache: number;       // cacheRead
    cacheWrite: number;  // cache creation tokens
    reasoning: number;   // thinking/reasoning tokens
    model: string;
    provider: string;
    ts: string;  // ISO timestamp
    /** Provider-scoped account id. Absent means resolve via claudePins, or unknown. */
    accountKey?: string;
}

/** Per-conversation cached data */
export interface ConvoTokenData {
    entries: TokenEntry[];
}

/**
 * The raw ledger plus its title map — the two inputs every aggregation takes.
 *
 * Exists so a consumer that needs to aggregate for itself (the detail panel's
 * per-provider sections) can be handed the ledger explicitly, as one value
 * resolved from one source, instead of finding it hanging off a DeepUsageStats.
 * See UsageStatsService.getCurrentLedger.
 */
export interface UsageLedger {
    perConvo: Record<string, ConvoTokenData>;
    titleMap: Map<string, string>;
}

// Imported (not defined here) and re-exported: this file ends in a
// --self-check block that require()s extension-host-only modules (fs,
// sqlite, the language server client, ...), which makes it unsafe for a
// bundler to resolve on behalf of browser-bundled code. usage-components.ts
// (bundled into the webview) needs isClaudeConvo/LEGACY_CLAUDE_ARCHIVE_ID, so
// their canonical definition lives in the dependency-free ./convoId.ts
// instead — see that file's doc comment. The self-check block below still
// uses both names directly (unchanged), and every existing `from './types'`
// import of them elsewhere in the codebase keeps working unchanged too.
import { isClaudeConvo, LEGACY_CLAUDE_ARCHIVE_ID } from './convoId';
export { isClaudeConvo, LEGACY_CLAUDE_ARCHIVE_ID };

/** Disk cache structure */
export interface DiskCacheData {
    schemaVersion?: number;
    perConvo: Record<string, ConvoTokenData>;
    fetchedIds: string[];
    stats: DeepUsageStats;
    updatedAt: string;
    titleMap?: Record<string, string>;
    stepCounts?: Record<string, number>;  // cascade → last known step count (delta detection)
    entryCounts?: Record<string, { meta: number; steps: number }>;  // offset-based delta fetch
    mtimes?: Record<string, number>;  // cascade → newest on-disk mtime at last fetch (delta detection)
    /** ISO date on which store-sourced counting began. Totals before and after are not comparable. */
    countingChangedAt?: string;
}

// ─── Shared Fingerprint ───
// Canonical definition moved to ./convoId.ts (dependency-free) so the
// webview-bundled account facet can apply the IDENTICAL dedup rule as the
// aggregator — see entryFingerprint's own doc comment there. Re-exported so
// every existing `from './types'` import keeps working unchanged.
import { entryFingerprint } from './convoId';
export { entryFingerprint };

export function mergePreferredEntry(existing: TokenEntry, next: TokenEntry): TokenEntry {
    if (existing.source === 'metadata') return existing;
    if (next.source === 'metadata') {
        return {
            ...next,
            model: next.model || existing.model,
            provider: next.provider || existing.provider,
            ts: next.ts || existing.ts,
        };
    }
    return existing;
}

// ─── Re-fetch Gate ───

/**
 * Should an already-fetched conversation be re-fetched?
 *
 * stepCount is precise but only covers conversations the LS has loaded — it never
 * lists agy CLI sessions, so their stepCount reads 0 forever. Disk mtime is the
 * fallback that catches them. See UsageStatsService.convoMtimes().
 *
 * Self-check: `node out/services/usage/types.js --self-check`
 */
export function isConvoDirty(args: {
    stepCount: number;
    cachedStepCount: number;
    mtime: number;
    /** undefined for caches written before mtimes were tracked */
    cachedMtime: number | undefined;
    hasEntries: boolean;
}): boolean {
    if (args.stepCount > args.cachedStepCount) return true;
    // No cached mtime → pre-mtime cache entry. Only re-fetch if it has no entries, so
    // upgrading re-reads the conversations that were silently missed, not all of them.
    const cachedMtime = args.cachedMtime ?? (args.hasEntries ? args.mtime : 0);
    return args.mtime > cachedMtime;
}

/** Monthly aggregation accumulator */
export interface MonthlyAccumulator {
    input: number;
    output: number;
    cache: number;
    cacheWrite: number;
    reasoning: number;
    calls: number;
    models: Record<string, { rawModel: string; tokens: number; inp: number; out: number; cache: number; cacheWrite: number; reas: number }>;
}

// ─── Model Placeholder Maps ───

// Placeholder → raw model string mappings
// NOTE: MODEL_PLACEHOLDER_M* are runtime-routed by the server (no static mapping in binary).
// Sources: (1) API responseModel field, (2) ddarkr/antigravity-token-monitor community map
export const PLACEHOLDER_MAP: Record<string, string> = {
    // === Verified via our API responseModel field ===
    'MODEL_PLACEHOLDER_M26': 'claude-opus-4-6-thinking',
    'MODEL_PLACEHOLDER_M35': 'claude-sonnet-4-6',
    'MODEL_PLACEHOLDER_M37': 'gemini-3.1-pro-high',
    'MODEL_PLACEHOLDER_M47': 'gemini-3-flash-c',
    'MODEL_PLACEHOLDER_M50': 'gemini-checkpoint',

    // === Community-verified (ddarkr/antigravity-token-monitor) ===
    'MODEL_PLACEHOLDER_M18': 'gemini-3-flash',
    'MODEL_PLACEHOLDER_M36': 'gemini-3.1-pro-low',
    'MODEL_PLACEHOLDER_M7':  'gemini-3-pro-low',
    'MODEL_PLACEHOLDER_M8':  'gemini-3-pro-high',
    'MODEL_PLACEHOLDER_M9':  'gemini-3-pro-image',
    'MODEL_PLACEHOLDER_M12': 'claude-opus-4-5-thinking',

    // === Explicit model identifiers (returned directly by API, not placeholders) ===
    'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE': 'gemini-2.5-flash-lite',
    'MODEL_GOOGLE_GEMINI_2_5_FLASH': 'gemini-2.5-flash',
    'MODEL_GOOGLE_GEMINI_2_5_PRO': 'gemini-2.5-pro',
    'MODEL_CLAUDE_4_SONNET': 'claude-sonnet-4',
    'MODEL_CLAUDE_4_SONNET_THINKING': 'claude-sonnet-4-thinking',
    'MODEL_CLAUDE_4_OPUS': 'claude-opus-4',
    'MODEL_CLAUDE_4_OPUS_THINKING': 'claude-opus-4-thinking',
    'MODEL_CLAUDE_4_5_SONNET': 'claude-sonnet-4.5',
    'MODEL_CLAUDE_4_5_SONNET_THINKING': 'claude-sonnet-4.5-thinking',
    'MODEL_CLAUDE_4_5_HAIKU': 'claude-haiku-4.5',
    'MODEL_CLAUDE_4_5_HAIKU_THINKING': 'claude-haiku-4.5-thinking',
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'gpt-oss-120b',
};

/**
 * Placeholder enum → the label the vendor itself shows for it.
 *
 * The .proto ships blank `MODEL_PLACEHOLDER_M<n>` slots so unreleased model
 * names never appear in the client binary — which is why these cannot be
 * derived, only observed. GetUserStatus returns the real label for every model
 * the signed-in account may use, so the extension harvests them from a response
 * it already fetches for quota (see learnModelLabels) and merges the result
 * over this seed.
 *
 * Seeded from a live GetUserStatus on 2026-08-16. Kept separate from
 * PLACEHOLDER_MAP because that map feeds pricing: inventing a plausible model
 * id for an unreleased model risks fuzzy-matching it to another model's rate
 * and inventing a cost. A label is safe to display; a made-up id is not.
 */
export const MODEL_LABEL_SEED: Record<string, string> = {
    'MODEL_PLACEHOLDER_M16': 'Gemini 3.1 Pro (High)',
    'MODEL_PLACEHOLDER_M20': 'Gemini 3.5 Flash (Medium)',
    'MODEL_PLACEHOLDER_M71': 'Gemini 3.6 Flash (High)',
    'MODEL_PLACEHOLDER_M72': 'Gemini 3.6 Flash (Medium)',
    'MODEL_PLACEHOLDER_M73': 'Gemini 3.6 Flash (Low)',
    'MODEL_PLACEHOLDER_M84': 'Gemini 3.5 Flash (High)',
    'MODEL_PLACEHOLDER_M187': 'Gemini 3.5 Flash (Low)',
    'MODEL_PLACEHOLDER_M298': 'Gemini 3.7 Flash (High)',
    'MODEL_PLACEHOLDER_M299': 'Gemini 3.7 Flash (Medium)',
    'MODEL_PLACEHOLDER_M300': 'Gemini 3.7 Flash (Low)',
};

/**
 * Labels observed at runtime, merged over MODEL_LABEL_SEED. Populated from
 * persisted state at activation and topped up whenever a GetUserStatus response
 * is parsed, so a model's label survives the model being withdrawn later.
 */
let learnedLabels: Record<string, string> = {};

/** Replace the learned set — called once at activation with the persisted map. */
export function setLearnedModelLabels(labels: Record<string, string>): void {
    learnedLabels = { ...labels };
}

/**
 * Harvest labels out of a GetUserStatus payload. Returns the newly learned
 * pairs only, so the caller can skip persisting when nothing changed.
 */
export function learnModelLabels(
    configs: Array<{ label?: string; modelOrAlias?: { model?: string } }> | undefined,
): Record<string, string> {
    const fresh: Record<string, string> = {};
    for (const c of configs || []) {
        const key = c?.modelOrAlias?.model;
        const label = c?.label;
        if (!key || !label) continue;
        if (learnedLabels[key] === label) continue;
        fresh[key] = label;
        learnedLabels[key] = label;
    }
    return fresh;
}

/** The vendor's own label for a model enum, if one has ever been seen. */
export function modelLabel(raw: string): string | undefined {
    return learnedLabels[raw] || MODEL_LABEL_SEED[raw];
}

/** Everything known right now — for persisting back to extension state. */
export function allLearnedModelLabels(): Record<string, string> {
    return { ...learnedLabels };
}

// Date-aware placeholder overrides: M26 was Opus 4.5 before Opus 4.6 shipped
// Opus 4.6 released Feb 5, 2026 — arrived in Antigravity same day
export const OPUS_46_CUTOFF = '2026-02-05';

export const PROVIDER_DISPLAY: Record<string, string> = {
    'API_PROVIDER_ANTHROPIC_VERTEX': 'Claude (Vertex)',
    'API_PROVIDER_GOOGLE_GEMINI': 'Gemini',
    'API_PROVIDER_OPENAI': 'OpenAI',
};

// ─── Self-check ───
// Run: node out/services/usage/types.js --self-check
if (require.main === module && process.argv.includes('--self-check')) {
    void (async () => {
        const assert = require('assert');

        // ─── dbAllAt: multi-row reads from an arbitrary database ───
        // Probe for sqlite3 upfront: the fixture requires it, so if it is missing the entire
        // section skips (both native backend assertions and CLI assertions).
        const cp = require('child_process');
        let hasSqlite3 = true;
        try {
            cp.execSync('sqlite3 --version', { stdio: 'pipe', timeout: 5000 });
        } catch { hasSqlite3 = false; }

        if (!hasSqlite3) {
            console.log('dbAllAt: SKIPPED — sqlite3 not on PATH; it builds the fixture both backends read');
        } else {
            const { dbAllAt, cliAll } = require('../../shared/db');
            const os = require('os'); const fsm = require('fs'); const pathm = require('path');

            const tmpDb = pathm.join(os.tmpdir(), 'ag-switchboard-selfcheck.db');
            try { fsm.unlinkSync(tmpDb); } catch { /* absent is fine */ }

            // Create fixture with multi-character values including spaces, and a blob column
            cp.execSync(
                `sqlite3 "${tmpDb}" "create table t(id,name,blob_col); ` +
                `insert into t values(1,'Alice Smith',X'DEADBEEF'),(2,'Bob Johnson',X'CAFEBABE'),(3,'Charlie 123',X'0123456789ABCDEF');"`,
            );

            // Test dbAllAt with both backends returning identical results
            const rows = await dbAllAt(tmpDb, 'select id, name, quote(blob_col) as blob_col from t order by id');
            assert.strictEqual(rows.length, 3, 'dbAllAt returns all 3 rows');
            assert.strictEqual(rows[0].length, 3, 'each row has 3 columns');

            // Verify multi-character text columns round-trip
            assert.strictEqual(rows[0][1], 'Alice Smith', 'multi-char text with space preserved');
            assert.strictEqual(rows[1][1], 'Bob Johnson', 'second row multi-char text preserved');

            // Verify blob columns come back as X'..' hex
            assert.match(rows[0][2], /^X'[0-9A-F]+'$/, 'blob column is X\'...\' hex format');
            assert.strictEqual(rows[0][2].toUpperCase(), "X'DEADBEEF'", 'blob column value correct');
            assert.strictEqual(rows[2][2].toUpperCase(), "X'0123456789ABCDEF'", 'longer blob preserves all hex digits');

            // Test missing database
            assert.strictEqual(await dbAllAt(pathm.join(os.tmpdir(), 'does-not-exist.db'), 'select 1'), null,
                'missing database resolves null rather than throwing');

            // Force test of CLI backend directly (dbAllAt prefers native; without this test, CLI could be broken and undetected)
            const cliRows = await cliAll(tmpDb, 'select id, name, quote(blob_col) as blob_col from t order by id');
            assert.strictEqual(cliRows.length, 3, 'cliAll returns all 3 rows');
            assert.strictEqual(cliRows[0][1], 'Alice Smith', 'cliAll: multi-char text preserved');
            assert.match(cliRows[0][2], /^X'[0-9A-F]+'$/, 'cliAll: blob column is X\'...\' hex format');
            assert.strictEqual(cliRows[0][2].toUpperCase(), "X'DEADBEEF'", 'cliAll: blob value matches native');

            fsm.unlinkSync(tmpDb);
            console.log('dbAllAt: all checks passed (both backends tested)');
        }


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
            encodeVarintField(10, 44),       // responseOutputTokens — divergent on purpose
            encodeString(11, 'eXZkatT5D8ONjuMPy9KhkA0'),  // responseId
        ]);
        const stamp = encodeMessage(9, encodeMessage(4, encodeVarintField(1, 1784968824)));
        const blob = encodeMessage(1, Buffer.concat([encodeMessage(4, usage), stamp]));

        const entry = decodeGenMetadataBlob(blob);
        assert.strictEqual(entry.inp, 15027, 'input tokens');
        assert.strictEqual(entry.out, 126, 'output comes from field 3, never field 10 — field 10 is unverified and has been seen disagreeing');
        assert.strictEqual(entry.cache, 12232, 'cache read tokens');
        assert.strictEqual(entry.reasoning, 401, 'reasoning tokens — priced, on 72% of entries');
        assert.strictEqual(entry.model, 'MODEL_PLACEHOLDER_M73', 'model resolved from enum');
        assert.strictEqual(entry.provider, 'API_PROVIDER_GOOGLE_GEMINI', 'provider resolved from enum');
        assert.strictEqual(entry.responseId, 'eXZkatT5D8ONjuMPy9KhkA0', 'response id');
        assert.strictEqual(entry.source, 'metadata', 'source tag');
        assert.strictEqual(entry.ts, new Date(1784968824000).toISOString(), 'timestamp from unix seconds');
        assert.strictEqual(decodeGenMetadataBlob(Buffer.from([0x00])), null, 'a malformed blob yields null, never a zero entry');
        console.log('usageReader: all checks passed');

        // ─── steps merge: metadata wins, steps fills gaps ───
        const { mergeSources } = require('./store/usageReader');
        const fromMeta = { responseId: 'A', source: 'metadata', inp: 10, out: 1, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
        const fromStepsSame = { responseId: 'A', source: 'steps', inp: 99, out: 9, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
        const fromStepsOnly = { responseId: 'B', source: 'steps', inp: 5, out: 1, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
        // Annotated explicitly: mergeSources comes through require(), which types as
        // any regardless of the target module's real signature, so .find()'s callback
        // below would get no contextual parameter type without this.
        const merged: TokenEntry[] = mergeSources([fromMeta], [fromStepsSame, fromStepsOnly]);
        assert.strictEqual(merged.length, 2, 'the duplicate collapses, the steps-only entry survives');
        assert.strictEqual(merged.find(e => e.responseId === 'A')!.inp, 10, 'metadata wins for a shared response id');
        assert.ok(merged.find(e => e.responseId === 'B'), 'steps-only entries are kept — 3.3% of history depends on this');
        console.log('usageReader steps merge: all checks passed');

        // ─── readStepsUsage: end-to-end against a fixture database ───
        // The merge assertions above use hand-built arrays and never call readStepsUsage
        // itself — an implementation that always returns [] passes every one of them,
        // which is exactly the failure this task shipped on its first attempt with a
        // fully green self-check. This drives the real function against a fixture whose
        // usage submessage sits at field 9 and whose timestamp sits at field 1 -> field 1
        // (the paths measured against real data — see readStepsUsage's own comment),
        // reusing the same fixture-building encoders as the gen_metadata section above.
        if (!hasSqlite3) {
            console.log('readStepsUsage fixture: SKIPPED — sqlite3 not on PATH; it builds the steps fixture this test reads');
        } else {
            const { readStepsUsage } = require('./store/usageReader');
            const osm = require('os'); const fsm2 = require('fs'); const pathm2 = require('path');

            // Same field numbering as the gen_metadata fixture above (model/input/output/
            // provider/responseId) — only the wrapping differs: field 9 directly, not
            // nested under field 1 -> field 4. Values match a real recovered entry
            // (conversation 7423b555, responseId j3JYatroJvinjuMP1KbZ4Qc) for realism.
            const stepsUsage = Buffer.concat([
                encodeVarintField(1, 1050),      // model enum -> MODEL_PLACEHOLDER_M50
                encodeVarintField(2, 73),        // input
                encodeVarintField(3, 5),         // output
                encodeVarintField(6, 24),        // provider -> Gemini
                encodeString(11, 'fixtureStepsResponseId'),
            ]);
            // timestamp: field 1 -> field 1 (unix seconds) — NOT the gen_metadata
            // path's field 1 -> field 9 -> field 4 -> field 1.
            const stepsStamp = encodeMessage(1, encodeVarintField(1, 1752600000));
            const stepsBlob = Buffer.concat([encodeMessage(9, stepsUsage), stepsStamp]);

            const tmpStepsDb = pathm2.join(osm.tmpdir(), 'ag-switchboard-selfcheck-steps.db');
            try { fsm2.unlinkSync(tmpStepsDb); } catch { /* absent is fine */ }
            cp.execSync(
                `sqlite3 "${tmpStepsDb}" "create table steps(idx integer, metadata blob, primary key(idx)); ` +
                `insert into steps values(1, X'${stepsBlob.toString('hex').toUpperCase()}');"`,
            );

            const stepsEntries = await readStepsUsage(tmpStepsDb);
            assert.strictEqual(stepsEntries.length, 1, 'readStepsUsage decodes exactly one entry from the fixture row');
            assert.strictEqual(stepsEntries[0].inp, 73, 'input tokens decoded from the field-9 usage submessage');
            assert.strictEqual(stepsEntries[0].out, 5, 'output tokens decoded from the field-9 usage submessage');
            assert.strictEqual(stepsEntries[0].model, 'MODEL_PLACEHOLDER_M50', 'model resolved from the field-9 submessage');
            assert.strictEqual(stepsEntries[0].source, 'steps', 'source tagged steps, not metadata');

            fsm2.unlinkSync(tmpStepsDb);
            console.log('readStepsUsage fixture: all checks passed');
        }

        // ─── readGenMetadata: rows read but producing no entry are counted ───
        // Nothing distinguishes "this conversation legitimately contained
        // cancelled requests that consumed no tokens" from "a decode regression
        // is silently dropping rows" — both are simply absent entries from
        // outside. This drives the real function against a fixture with one
        // good row (reusing `blob` from the gen_metadata section above), one
        // row whose usage submessage is present but empty (a cancelled
        // streaming request — decodeUsageSubmessage's input/output check
        // returns null for it), and one malformed row (the same single byte
        // already proven to yield null above), and asserts the skip is counted
        // rather than vanishing into entries.length. A stub that always reports
        // skipped:0 fails this; so does one that miscounts entries.length.
        if (!hasSqlite3) {
            console.log('readGenMetadata fixture: SKIPPED — sqlite3 not on PATH; it builds the gen_metadata fixture this test reads');
        } else {
            const { readGenMetadata } = require('./store/usageReader');
            const osm3 = require('os'); const fsm3 = require('fs'); const pathm3 = require('path');

            const emptyUsageBlob = encodeMessage(1, encodeMessage(4, Buffer.alloc(0)));
            const malformedBlob = Buffer.from([0x00]);

            const tmpGenDb = pathm3.join(osm3.tmpdir(), 'ag-switchboard-selfcheck-genmeta.db');
            try { fsm3.unlinkSync(tmpGenDb); } catch { /* absent is fine */ }
            cp.execSync(
                `sqlite3 "${tmpGenDb}" "create table gen_metadata(idx integer, data blob, primary key(idx)); ` +
                `insert into gen_metadata values` +
                `(1, X'${blob.toString('hex').toUpperCase()}'), ` +
                `(2, X'${emptyUsageBlob.toString('hex').toUpperCase()}'), ` +
                `(3, X'${malformedBlob.toString('hex').toUpperCase()}');"`,
            );

            const genResult = await readGenMetadata(tmpGenDb);
            assert.ok(genResult !== null, 'a readable database is not reported as a read failure');
            assert.strictEqual(genResult.entries.length, 1, 'only the genuinely usable row decodes to an entry');
            assert.strictEqual(genResult.skipped, 2, 'the cancelled-request row and the malformed row both count as skipped');

            fsm3.unlinkSync(tmpGenDb);
            console.log('readGenMetadata fixture: all checks passed');
        }

        // ─── conversation store ───
        const os = require('os'); const fsm = require('fs'); const pathm = require('path');
        const { conversationFreshness, listConversations } = require('./store/conversationStore');
        const tmpDir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'ag-store-'));
        const dbFile = pathm.join(tmpDir, 'x.db');
        const brainDir = pathm.join(tmpDir, 'brain-x');
        fsm.writeFileSync(dbFile, 'x'); fsm.mkdirSync(brainDir);
        fsm.utimesSync(dbFile, new Date(1000 * 1000), new Date(1000 * 1000));
        fsm.utimesSync(brainDir, new Date(1000 * 1000), new Date(1000 * 1000));
        fsm.writeFileSync(dbFile + '-wal', 'w');
        fsm.utimesSync(dbFile + '-wal', new Date(9000 * 1000), new Date(9000 * 1000));
        assert.strictEqual(conversationFreshness(dbFile, brainDir), 9000 * 1000,
            'the write-ahead log is the freshest signal — the .db timestamp lags up to a checkpoint');

        // A -shm newer than everything else must NOT count: readers create it, so
        // counting it would make every conversation look dirty after its first read
        // and turn incremental refresh into a permanent full rescan.
        fsm.writeFileSync(dbFile + '-shm', 's');
        fsm.utimesSync(dbFile + '-shm', new Date(99000000), new Date(99000000));
        assert.strictEqual(conversationFreshness(dbFile, brainDir), 9000 * 1000,
            'a -shm newer than the -wal is ignored — readers create it, so it is not a write signal');

        assert.ok(Array.isArray(listConversations()), 'listing never throws, even with roots missing');
        fsm.rmSync(tmpDir, { recursive: true, force: true });
        console.log('conversationStore: all checks passed');

        // ─── local-day bucketing and global dedupe ───
        const { aggregateFromPerConvo } = require('./aggregator');
        const mk = (rid: string, ts: string) => ({ responseId: rid, source: 'metadata', inp: 100, out: 10, cache: 0, cacheWrite: 0, reasoning: 0, model: 'MODEL_PLACEHOLDER_M73', provider: 'API_PROVIDER_GOOGLE_GEMINI', ts });

        // 01:30 local on the 5th. This runtime is UTC+7 (Indochina Time) — a positive
        // offset makes EARLY-morning local hours the ones that cross the UTC boundary
        // (01:30 local on the 5th is 18:30 UTC on the 4th), not late-evening ones
        // (23:30 local on the 5th is still 16:30 UTC the same day, so it would pass
        // under both the old and new bucketing and prove nothing). This mirrors the
        // real 01:17/01:39 sessions that land on the previous day under UTC slicing.
        const local = new Date(2026, 7, 5, 1, 30, 0);
        const { isoDay } = require('../../shared/helpers');

        // ─── timezone-sensitive assertions need a precondition guard ───
        // These two assertions only tell a correct implementation from a UTC one when
        // local midnight and UTC midnight fall on different dates. State that as a
        // requirement rather than letting the check quietly pass under a UTC runner.
        const offsetMinutes = -new Date().getTimezoneOffset();
        if (offsetMinutes > 0) {
            // Day-bucketing assertion: local dates, not UTC
            const statsDay = aggregateFromPerConvo({ c1: { entries: [mk('R1', local.toISOString())] } }, new Map());
            assert.strictEqual(statsDay.daily[0].date, isoDay(local), 'a day bucket uses the local date, not the UTC one');

            // ─── the year grid must key cells by local date ───
            const { renderDailyGrid: rdg } = require('../../shared/usage-components');
            // 2026-08-10 is a Monday; in a Monday-first grid its cell belongs in row 0.
            const gridHtml = rdg([{ date: '2026-08-10', input: 1000, output: 100, cache: 0, cacheWrite: 0, reasoning: 0, calls: 5 }], false, 2026, 0);
            const gridCells = [...gridHtml.matchAll(/<div class="gh-cell gh-lvl-(\d)" data-tip="([^"]*)"><\/div>/g)];
            const litIndex = gridCells.findIndex(c => c[1] !== '0');
            assert.ok(litIndex >= 0, 'the bucket lights a cell at all');
            assert.strictEqual(litIndex % 7, 0, 'a Monday bucket lands in the Monday row — cells are keyed by local date, not UTC');
            console.log('daily grid keys: all checks passed');
        } else {
            console.log(`timezone-sensitive assertions: SKIPPED — this runtime is UTC${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes / 60}. Re-run with TZ=Asia/Bangkok.`);
        }

        // the same call recorded under two conversations must count once (timezone-independent)
        const statsDup = aggregateFromPerConvo({
            parent: { entries: [mk('SHARED', local.toISOString())] },
            child:  { entries: [mk('SHARED', local.toISOString())] },
        }, new Map());
        assert.strictEqual(statsDup.totalCalls, 1, 'dedupe is global — 7 response ids already span two conversations');
        assert.strictEqual(statsDup.totalInput, 100, 'a globally deduplicated call is counted once');
        // The monthly buckets are built from allEntries, which is populated before the
        // date filter — dedupe has to cover that path too, not just the filtered one.
        const monthTotal = statsDup.monthly.reduce((n: number, m: { calls: number }) => n + m.calls, 0);
        assert.strictEqual(monthTotal, 1, 'monthly buckets are deduplicated too');
        console.log('aggregator: all checks passed');

        // ─── lastActivityAt: unfiltered, even when the filtered range is empty ───
        // dateRange is built from filteredEntries and goes blank the moment the
        // selected window has zero calls — exactly the case the empty state
        // needs a real "last activity" date for, and exactly the case that
        // caused the honest-empty-state UI wiring to be checked here rather
        // than trusted from the brief's own sketch.
        const statsOutOfWindow = aggregateFromPerConvo(
            { c1: { entries: [mk('R9', '2026-07-01T00:00:00.000Z')] } },
            new Map(),
            '2026-08-01T00:00:00.000Z',   // filter excludes the only entry
        );
        assert.strictEqual(statsOutOfWindow.totalCalls, 0, 'the fixture entry falls outside the filter');
        assert.strictEqual(statsOutOfWindow.dateRange.to, '', 'the filtered date range is blank when nothing falls inside it');
        assert.strictEqual(statsOutOfWindow.lastActivityAt, '2026-07-01T00:00:00.000Z', 'lastActivityAt is unfiltered — it still reports when activity last happened');
        console.log('lastActivityAt: all checks passed');

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

        // ─── the monthly aggregation path is a fourth matchPricing call site ───
        // buildMonthlyBuckets (inside aggregateFromPerConvo) computes MonthlyBucket.cost —
        // the dollar figure printed directly above every bar in the monthly chart, and the
        // first line of its hover tooltip. It was missed by the original count of "three
        // call sites" because the pricingKey parameter is optional, so an un-migrated call
        // compiles clean under --strict; only a stub that records what it was handed (or a
        // grep) surfaces it. Deliberately mismatched stub rates (999 vs the real 0.5/3
        // keyword-table rate for gemini-3-flash) so a reverted fix shows up as a wildly
        // different cost, not just a coincidentally-equal one.
        const seenMonthly: string[] = [];
        uc.setExternalPricingResolver((key: string) => {
            seenMonthly.push(key);
            return key === 'gemini-3-flash-c' ? { input: 999, output: 999, cache: 999, reasoning: 999 } : null;
        });
        const monthlyStats = aggregateFromPerConvo({
            mconvo: {
                entries: [{
                    responseId: 'MONTHLY1', source: 'metadata', inp: 1000, out: 100, cache: 0, cacheWrite: 0, reasoning: 0,
                    model: 'MODEL_PLACEHOLDER_M47', provider: 'API_PROVIDER_GOOGLE_GEMINI', ts: '2026-03-15T00:00:00.000Z',
                }],
            },
        }, new Map());
        assert.strictEqual(seenMonthly.length, 1, 'exactly one pricing lookup for the single fixture model');
        assert.strictEqual(seenMonthly[0], 'gemini-3-flash-c', 'the monthly path asks the resolver for the model id first, not the display label');
        const marchBucket = monthlyStats.monthly.find((mo: { key: string }) => mo.key === '2026-03');
        assert.ok(marchBucket, 'the fixture entry produced a March monthly bucket');
        assert.ok(Math.abs(marchBucket.cost - 1.0989) < 1e-6, 'the monthly bucket cost reflects the resolver rate, not the keyword-table fallback');
        uc.setExternalPricingResolver(null);   // restore, or later assertions inherit the stub

        // ─── MUST FIX 1 regression: an unknown model is excluded from monthly cost, not billed at Sonnet ───
        // matchPricing's hardcoded fallback ends in a bare `return pricing['sonnet']` — an
        // unrecognised model matches none of the keyword checks and falls all the way through
        // to that default. The three matchPricing call sites in usage-components.ts guard
        // against this by skipping MODEL_UNKNOWN_* before ever calling matchPricing; the
        // monthly path is a fourth call site (see above) that was missed by the original
        // guard sweep. Reproduces the reviewer's own repro exactly: one unknown-model call of
        // 1,000,000 input + 1,000,000 output tokens. Without the guard this yields
        // MonthlyBucket.cost === 18 (1e6 * $3/M sonnet input + 1e6 * $15/M sonnet output,
        // i.e. silently billed at Sonnet rates); with it, the model contributes nothing.
        const unknownMonthly = aggregateFromPerConvo({
            uconvo: {
                entries: [{
                    responseId: 'UNKNOWN1', source: 'metadata', inp: 1_000_000, out: 1_000_000, cache: 0, cacheWrite: 0, reasoning: 0,
                    model: 'MODEL_UNKNOWN_9999', provider: 'API_PROVIDER_UNKNOWN_1', ts: '2026-04-15T00:00:00.000Z',
                }],
            },
        }, new Map());
        const aprilBucket = unknownMonthly.monthly.find((mo: { key: string }) => mo.key === '2026-04');
        assert.ok(aprilBucket, 'the unknown-model fixture entry produced an April monthly bucket');
        assert.strictEqual(aprilBucket.cost, 0, 'an unknown model contributes zero to MonthlyBucket.cost — excluded, never priced at the Sonnet fallback rate');
        console.log('monthly pricing key: all checks passed');


        // ─── empty state names the last activity instead of showing zeros ───
        const { renderEmptyRange } = require('../../shared/usage-components');
        const empty = renderEmptyRange('2026-08-06T09:20:30.000Z', 'Last 24 Hours');
        assert.ok(empty.includes('Last 24 Hours'), 'the empty state names the range');
        assert.ok(/Aug\s*6/.test(empty), 'the empty state names when activity last happened');
        const never = renderEmptyRange(null, 'All Time');
        assert.ok(never.length > 0 && !never.includes('undefined'), 'no recorded activity still renders cleanly');
        console.log('empty state: all checks passed');

        // ─── health card: three verification states, not two ───
        // Task 9's review: rendering "compared:0" as clean manufactures exactly
        // the false confidence the verifier exists to prevent. A stub that
        // always prints "clean" regardless of what was actually compared must
        // fail this, and so must one that never mentions the source/skip counts.
        const { renderHealthCard } = require('../../shared/usage-components');
        const baseHealth = { source: 'store', conversations: 100, unreadable: 0, unknownModels: [], skippedRows: 0, verification: null, countingChangedAt: null };

        assert.ok(renderHealthCard(baseHealth).includes('conversation store'), 'the card names the data source');
        assert.ok(renderHealthCard(baseHealth).includes('100'), 'the card shows how many conversations were read');

        // State 1: the verifier has not run at all this session.
        const cardNeverRun = renderHealthCard(baseHealth);
        // Row label is "Token counts", not "Cross-check" (see item C, final review):
        // the verifier checks token counts against the language server, not dollar
        // rates, and the old label sat directly under an estimated-cost figure
        // where it could be misread as vouching for the money.
        assert.ok(!/Token counts/i.test(cardNeverRun), 'verification:null renders no cross-check row at all');
        assert.ok(!/clean/i.test(cardNeverRun), 'verification:null must never be rendered as clean');

        // State 2: it ran, but every sampled conversation was one the language
        // server could no longer serve — compared nothing. This is the NORMAL
        // condition this whole plan exists to work around, not a clean result.
        const cardCompared0 = renderHealthCard({ ...baseHealth, verification: { compared: 0, diverged: 0, at: '2026-08-14T00:00:00.000Z' } });
        assert.ok(/not verified this run/i.test(cardCompared0), 'compared:0 says it was not verified this run');
        assert.ok(!/clean/i.test(cardCompared0), 'compared:0 must never be rendered as clean — that is the exact false confidence this exists to prevent');

        // State 3: a real, agreeing comparison — the only state allowed to say clean.
        const cardClean = renderHealthCard({ ...baseHealth, verification: { compared: 42, diverged: 0, at: '2026-08-14T00:00:00.000Z' } });
        assert.ok(/clean/i.test(cardClean), 'a real, agreeing comparison is reported as clean');
        assert.ok(cardClean.includes('42'), 'the clean state names how many calls were actually compared');

        // A real comparison that disagreed must still warn, never read as clean.
        const cardDiverged = renderHealthCard({ ...baseHealth, verification: { compared: 42, diverged: 3, at: '2026-08-14T00:00:00.000Z' } });
        assert.ok(!/clean/i.test(cardDiverged), 'a divergent comparison must not say clean');
        assert.ok(cardDiverged.includes('3'), 'the divergence count is shown');

        // Skipped-rows counter: a decode regression has somewhere to become visible.
        // Review Important 3: the count only covers gen_metadata, not steps — the
        // card's own text must say so, not just the source comment, or a reader
        // relying on it as a trust signal has no way to know its scope.
        const cardSkipped = renderHealthCard({ ...baseHealth, skippedRows: 7 });
        assert.ok(cardSkipped.includes('7'), 'skipped rows are surfaced as a plain count');
        assert.ok(/metadata/i.test(cardSkipped), 'the label names its scope (metadata rows) — a reader must not mistake this for a total across all read paths');
        const cardNoSkips = renderHealthCard({ ...baseHealth, skippedRows: 0 });
        assert.ok(!/skipped/i.test(cardNoSkips), 'a healthy zero skip count adds no noise to the card');

        // Changeover marker: named once it exists, silent when it does not.
        const cardWithChangeover = renderHealthCard({ ...baseHealth, countingChangedAt: '2026-08-10T00:00:00.000Z' });
        assert.ok(/Aug\s*10/.test(cardWithChangeover), 'the changeover note names the date counting changed');
        assert.ok(!/Aug\s*10/.test(cardNeverRun), 'no changeover note when countingChangedAt is null');

        console.log('health card: all checks passed');

        // ─── health persists through an actual disk write + read round-trip ───
        // Review Important 1: cache.write() was being called BEFORE stats.health
        // was assigned in refreshFromStore, so JSON.stringify captured the object
        // without it — .health was never persisted on any path. This proves the
        // write/read layer itself preserves the field end to end (not just as an
        // in-memory reference) when the caller assigns it in the now-corrected
        // order — against a temp-redirected file, never the user's real cache.
        {
            const { StatsCache: StatsCacheRT } = require('./cache');
            const osH2 = require('os'); const fsH2 = require('fs'); const pathH2 = require('path');
            const tmpCacheRT = pathH2.join(osH2.tmpdir(), 'ag-switchboard-selfcheck-health-roundtrip.json');
            try { fsH2.unlinkSync(tmpCacheRT); } catch { /* absent is fine */ }
            class TestStatsCacheRT extends StatsCacheRT {
                get filePath() { return tmpCacheRT; }
            }
            const testCacheRT = new TestStatsCacheRT();

            const rtEntries = [mk('RT1', '2026-08-01T00:00:00.000Z')];
            const roundTripStats = aggregateFromPerConvo({ rt: { entries: rtEntries } }, new Map());
            // The now-fixed order: attach .health to the SAME object BEFORE
            // calling write — exactly what refreshFromStore does after the fix.
            roundTripStats.health = {
                source: 'store', conversations: 1, unreadable: 0, unknownModels: [],
                skippedRows: 0, verification: null, countingChangedAt: '2026-08-01T00:00:00.000Z',
            };
            testCacheRT.write({ rt: { entries: rtEntries } }, ['rt'], roundTripStats, new Map(), undefined, undefined, { rt: 1000 }, '2026-08-01T00:00:00.000Z');

            const reloadedRT = testCacheRT.read();
            assert.ok(reloadedRT, 'the temp-redirected cache reads back');
            assert.ok(reloadedRT.stats.health, '.health survived an actual disk write + read round-trip, not just an in-memory reference');
            assert.strictEqual(reloadedRT.stats.health.source, 'store', 'the persisted health snapshot is intact, not just present');
            assert.strictEqual(reloadedRT.stats.health.conversations, 1, 'nested numeric fields inside .health survive JSON round-tripping too');

            fsH2.unlinkSync(tmpCacheRT);
            console.log('health disk round-trip: all checks passed');
        }

        // ─── health survives the dirty:0 refresh path — the common case ───
        // Review Important 1's sharpest point: "a test that only exercises a
        // full refresh will pass while the bug remains." Before this fix,
        // refreshFromStore's dirty.length===0 early return skipped the
        // health-snapshot code entirely — the exact path a quick reload or a
        // second window takes on every ordinary poll where nothing changed.
        // This drives the REAL UsageStatsService class end to end (not a
        // stand-in: require('./index') and call its actual private method —
        // TypeScript's `private` has no runtime effect), against a
        // temp-redirected cache so the user's real ~/.gemini disk cache is
        // never touched, and against this machine's real, on-disk conversation
        // ledger read read-only so that dirty.length===0 is a genuine outcome
        // of the dirty-check logic, not a simulated one.
        {
            const { UsageStatsService } = require('./index');
            const { StatsCache: StatsCacheD0 } = require('./cache');
            const osD0 = require('os'); const fsD0 = require('fs'); const pathD0 = require('path');

            const conversationsD0 = listConversations();
            if (conversationsD0.length === 0) {
                console.log('health survives reload: SKIPPED — no conversations on this machine to build a realistic dirty:0 fixture from');
            } else {
                const tmpCacheD0 = pathD0.join(osD0.tmpdir(), 'ag-switchboard-selfcheck-health-dirty0.json');
                try { fsD0.unlinkSync(tmpCacheD0); } catch { /* absent is fine */ }
                class TestStatsCacheD0 extends StatsCacheD0 {
                    get filePath() { return tmpCacheD0; }
                }
                const testCacheD0 = new TestStatsCacheD0();

                // Seed a disk cache where every REAL conversation already has
                // entries and a cachedMtime strictly newer than its actual
                // on-disk mtime — guaranteeing isConvoDirty is false for all of
                // them, i.e. dirty.length===0 on the very next refreshFromStore
                // call. Read-only against the real conversation databases;
                // every write in this test goes to tmpCacheD0.
                const perConvoD0: Record<string, unknown> = {};
                const mtimesD0: Record<string, number> = {};
                for (const c of conversationsD0) {
                    perConvoD0[c.id] = { entries: [mk(`seed-${c.id}`, '2020-01-01T00:00:00.000Z')] };
                    mtimesD0[c.id] = c.mtimeMs + 1;
                }
                const seededStatsD0 = aggregateFromPerConvo(perConvoD0 as any, new Map());
                testCacheD0.write(perConvoD0, Object.keys(perConvoD0), seededStatsD0, new Map(), undefined, undefined, mtimesD0, '2026-08-01T00:00:00.000Z');

                const seededDiskCacheD0 = testCacheD0.read();
                assert.ok(seededDiskCacheD0, 'the seeded temp cache reads back');
                assert.strictEqual(seededDiskCacheD0.stats.health, undefined, 'sanity: the seed itself carries no health, so the health-present check below is not vacuous');

                const svc = new UsageStatsService();
                svc.cache = testCacheD0;
                // Mimics fetchDeepStats' own sequencing: deepStatsCache is set
                // from the disk read BEFORE refreshFromStore is ever called.
                svc.deepStatsCache = seededDiskCacheD0.stats;

                const fakeServerInfo = { port: 59999, csrfToken: 'fake', protocol: 'http' };
                const result = await svc.refreshFromStore(fakeServerInfo, seededDiskCacheD0);
                assert.strictEqual(result, null, 'every real conversation was seeded as already-fetched with a newer mtime — this must hit dirty.length===0, not a full refresh');
                assert.ok(svc.lastHealth, 'the dirty:0 early-return path still populates lastHealth — this is the exact path the bug lived on');
                assert.strictEqual(svc.lastHealth.source, 'store', 'source is store on this path');
                assert.strictEqual(svc.lastHealth.verification, null, 'a fresh service instance has not verified anything yet, and the early-return path must not fabricate a result');
                assert.strictEqual(svc.deepStatsCache.health, svc.lastHealth, 'the in-memory cached stats object — what fetchDeepStats actually returns to the panel — carries the same snapshot');

                // Now force a REAL dirty pass (bump one real conversation's
                // cached mtime back below its actual on-disk mtime) and drive
                // the same real refreshFromStore through its full body,
                // including its own cache.write call — not a stand-in. This is
                // the ordering bug's actual site: cache.write serializes
                // synchronously, so .health must already be on the object
                // passed to it. serverInfo points at a closed local port —
                // fetchTrajectorySummaries and the verifier both already
                // tolerate an unreachable server by design (see their own
                // try/catch), so this fails fast (~30ms observed) rather than
                // hanging, and never reaches a real network.
                const dirtyTarget = conversationsD0[0];
                const dirtyDiskCacheD0 = testCacheD0.read();
                dirtyDiskCacheD0.mtimes[dirtyTarget.id] = dirtyTarget.mtimeMs - 1;
                // fetchTrajectorySummaries's own catch logs a WARN for this expected
                // connection failure (serverInfo deliberately points at a closed port,
                // per the comment above). A self-check that routinely prints a WARN
                // trains a reader to skip WARNs, which is how a real one gets missed —
                // so console.warn is muted for exactly this call and restored
                // immediately after, even if the call itself throws. Kept as a helper
                // (rather than a `let` reassigned inside try/finally) so dirtyResult
                // stays a single `const` initializer — assert.ok's narrowing of it
                // below does not reliably survive a variable reassigned across a
                // try/finally boundary.
                // svc comes from require('./index') (untyped, like the rest of this
                // fixture), so refreshFromStore's return stays `any` here exactly as
                // it did before this helper existed — deliberately not typed as
                // Promise<T>, which would reintroduce a null-narrowing question this
                // fixture never had to answer.
                const withWarnMuted = async (fn: () => Promise<any>): Promise<any> => {
                    const original = console.warn;
                    console.warn = () => { /* expected: ECONNREFUSED from the deliberately closed fakeServerInfo port */ };
                    try { return await fn(); } finally { console.warn = original; }
                };
                const dirtyResult = await withWarnMuted(() => svc.refreshFromStore(fakeServerInfo, dirtyDiskCacheD0));
                assert.ok(dirtyResult, 'the bumped conversation makes this a real, non-empty refresh, not another early return');
                assert.ok(dirtyResult.health, 'a full pass carries health in memory');

                const persistedD0 = testCacheD0.read();
                assert.ok(persistedD0.stats.health, '.health survived an ACTUAL disk write triggered by the real orchestration — the exact ordering bug (cache.write called before .health was assigned) is fixed');
                assert.strictEqual(persistedD0.stats.health.source, 'store', 'the persisted snapshot names its source');

                fsD0.unlinkSync(tmpCacheD0);
                console.log('health survives reload: all checks passed (dirty:0 path and a real persisted dirty pass)');
            }
        }

        // ─── model labels: the vendor's name beats our placeholder ───
        {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getModelDisplayName } = require('./aggregator');

            // Seeded enums render the vendor's label, not "Placeholder M187".
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M187'), 'Gemini 3.5 Flash (Low)',
                'a seeded placeholder shows the real model name');
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M298'), 'Gemini 3.7 Flash (High)',
                'seed covers the 3.7 family');

            // An enum nobody has ever seen must stay visibly unknown, never guessed.
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Placeholder M9999',
                'an unseen placeholder admits it is unknown');

            // Learning at runtime names a model the seed never knew.
            const learnedNow = learnModelLabels([
                { label: 'Gemini 4.0 Pro (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M9999' } },
                { label: 'no key', modelOrAlias: {} },
                { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M8888' } },
            ]);
            assert.deepStrictEqual(learnedNow, { 'MODEL_PLACEHOLDER_M9999': 'Gemini 4.0 Pro (High)' },
                'only complete pairs are learned, and only the new ones are returned for persisting');
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Gemini 4.0 Pro (High)',
                'a learned label takes effect immediately');

            // Re-learning the same label reports nothing fresh, so we do not write state every poll.
            assert.deepStrictEqual(
                learnModelLabels([{ label: 'Gemini 4.0 Pro (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M9999' } }]),
                {}, 'an unchanged label is not re-persisted');

            // A learned label must not override a mapping that drives pricing: M26 is
            // date-aware (Opus 4.5 before the 4.6 cutoff) and must stay that way.
            learnModelLabels([{ label: 'WRONG', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M26' } }]);
            assert.strictEqual(
                getModelDisplayName('MODEL_PLACEHOLDER_M26', undefined, '2026-01-01T00:00:00.000Z'),
                'Claude Opus 4.5 (Thinking)',
                'labels never override a priced placeholder, so date-aware resolution survives');

            // Persistence round-trip: what we hand the store restores what we knew.
            const snapshot = allLearnedModelLabels();
            assert.strictEqual(snapshot['MODEL_PLACEHOLDER_M9999'], 'Gemini 4.0 Pro (High)', 'snapshot carries learned labels');
            setLearnedModelLabels({});
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Placeholder M9999', 'cleared state forgets');
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M187'), 'Gemini 3.5 Flash (Low)', 'but the seed survives a clear');
            setLearnedModelLabels(snapshot);
            assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Gemini 4.0 Pro (High)', 'restore brings them back');
            setLearnedModelLabels({});

            console.log('model labels: all checks passed');
        }

        // ─── conversation guard: only warn when the comparison is meaningful ───
        {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fsCG = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const osCG = require('os');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pathCG = require('path');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { isSharedConversationStore } = require('../../shared/agPaths');

            // A directory belonging to no install root is nobody's shared store.
            const solo = fsCG.mkdtempSync(pathCG.join(osCG.tmpdir(), 'cg-solo-'));
            assert.strictEqual(isSharedConversationStore(solo), false,
                'an unrelated directory is not shared');

            // A path that does not exist cannot be resolved, and must not warn.
            assert.strictEqual(isSharedConversationStore(pathCG.join(solo, 'nope')), false,
                'an unresolvable path is not shared');

            // The real check: this machine symlinks all three install roots at one
            // directory, which is exactly the arrangement that produced a permanent
            // false alarm and would have let a rebuild rewrite the sidebar.
            const roots = ['antigravity', 'antigravity-ide', 'antigravity-cli']
                .map((n: string) => pathCG.join(osCG.homedir(), '.gemini', n, 'conversations'));
            const resolved = roots
                .map((r: string) => { try { return fsCG.realpathSync(r); } catch { return null; } })
                .filter(Boolean);
            const sharedHere = resolved.length > 1 && new Set(resolved).size < resolved.length;
            if (sharedHere) {
                assert.strictEqual(isSharedConversationStore(roots[0]), true,
                    'install roots resolving to one directory must read as shared');
            }

            fsCG.rmSync(solo, { recursive: true, force: true });
            console.log(`conversation guard: all checks passed${sharedHere ? ' (shared-store case exercised on this machine)' : ' (no shared store here — that branch not exercised)'}`);
        }

        // ─── poll rates: the footer cannot offer what the host would reject ───
        {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { POLL_INTERVALS_MS, DEFAULT_POLL_INTERVAL_MS, pollIntervalLabel } = require('../../shared/uiConstants');

            assert.ok(POLL_INTERVALS_MS.includes(DEFAULT_POLL_INTERVAL_MS),
                'the default rate must be one the picker offers, or the footer highlights nothing on first open');

            assert.deepStrictEqual(POLL_INTERVALS_MS.map(pollIntervalLabel), ['30s', '1m', '2m', '5m'],
                'labels read as the user expects');

            // The drift this guards: the buttons are generated from POLL_INTERVALS_MS
            // and the host validates against the same array, so a rate added to the UI
            // is automatically accepted. Assert they are literally the same source —
            // reintroducing a second hardcoded list is the regression.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const tpl = require('fs').readFileSync(
                require('path').join(__dirname, '../../../src/templates/webviewTemplate.ts'), 'utf8');
            assert.ok(tpl.includes('POLL_INTERVALS_MS.map'),
                'the footer buttons must be generated from POLL_INTERVALS_MS, not hardcoded');
            assert.ok(!/data-ms="\d/.test(tpl),
                'no literal data-ms value may remain in the template');

            console.log('poll rates: all checks passed');
        }

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

        // ─── read() version gate: v2→v3 upgrade on disk, v3 pass-through, v1/absent rejection ───
        {
            const { StatsCache } = require('./cache');
            const os = require('os'); const fs = require('fs'); const path = require('path');
            const ARCHIVE_TOTAL = 12942976240;

            // Fixture: same archive and convo shape as the unit test, but this time
            // written to disk so read() exercises the full gate logic
            const fixtureBase = {
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

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-read-gate-'));
            try {
                // Case 1: v2 fixture on disk — the gate must route it through migration
                {
                    const v2Path = path.join(tmpDir, 'v2.json');
                    fs.writeFileSync(v2Path, JSON.stringify({ ...fixtureBase, schemaVersion: 2 }), 'utf-8');
                    class TestCacheV2 extends StatsCache {
                        get filePath() { return v2Path; }
                    }
                    const resultV2 = new TestCacheV2().read();
                    assert.ok(resultV2, 'v2 fixture read() must return non-null after migration');
                    assert.strictEqual(resultV2.schemaVersion, 3, 'v2 on disk migrates to schemaVersion 3 in-memory');
                    assert.ok(resultV2.perConvo['claude-code-imported'], 'archive convo survived the gate');
                    const archiveV2 = resultV2.perConvo['claude-code-imported'].entries;
                    assert.strictEqual(archiveV2.length, 1, 'archive entry count preserved through gate');
                    const totalV2 = archiveV2.reduce((s: number, e: any) =>
                        s + e.inp + e.out + e.cache + e.cacheWrite + e.reasoning, 0);
                    assert.strictEqual(totalV2, ARCHIVE_TOTAL, 'archive token total preserved exactly through gate (not dropped by mismatch rejection)');
                }

                // Case 2: v3 fixture on disk — passes through unchanged
                {
                    const v3Path = path.join(tmpDir, 'v3.json');
                    fs.writeFileSync(v3Path, JSON.stringify({ ...fixtureBase, schemaVersion: 3 }), 'utf-8');
                    class TestCacheV3 extends StatsCache {
                        get filePath() { return v3Path; }
                    }
                    const resultV3 = new TestCacheV3().read();
                    assert.ok(resultV3, 'v3 fixture read() must return non-null');
                    assert.strictEqual(resultV3.schemaVersion, 3, 'v3 passes through unchanged');
                }

                // Case 3: v1 fixture on disk — rejected (rebuild needed)
                {
                    const v1Path = path.join(tmpDir, 'v1.json');
                    fs.writeFileSync(v1Path, JSON.stringify({ ...fixtureBase, schemaVersion: 1 }), 'utf-8');
                    class TestCacheV1 extends StatsCache {
                        get filePath() { return v1Path; }
                    }
                    const resultV1 = new TestCacheV1().read();
                    assert.strictEqual(resultV1, null, 'v1 fixture is rejected (rebuild is required for v1)');
                }

                // Case 4: schemaVersion absent entirely — rejected (rebuild needed)
                {
                    const noVersionPath = path.join(tmpDir, 'no-version.json');
                    fs.writeFileSync(noVersionPath, JSON.stringify(fixtureBase), 'utf-8');
                    class TestCacheNoVersion extends StatsCache {
                        get filePath() { return noVersionPath; }
                    }
                    const resultNoVersion = new TestCacheNoVersion().read();
                    assert.strictEqual(resultNoVersion, null, 'missing schemaVersion is treated as v1 equivalent and rejected (rebuild needed)');
                }
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }

            console.log('read() version gate: all checks passed');
        }


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

            // ─── Regression: cross-root identity misattribution ───
            // When a CLAUDE_CONFIG_DIR root (e.g. ~/.claude-alt) has its own
            // .claude.json but no oauthAccount, the presence check must stop
            // at that file. It must NOT fall through to the adjacent file
            // (which would be ~/.claude.json — the default root's identity),
            // even if the default root has logged in. File presence is the
            // discriminator: if the root's own file exists, the layout is
            // confirmed; absence means try the other location.
            const homeReg = pathA.join(tmp, 'homeReg');
            const rootNoAcct = pathA.join(homeReg, '.claude-alt');
            fsA.mkdirSync(pathA.join(rootNoAcct, 'projects'), { recursive: true });
            // Root's own file: valid JSON, but no oauthAccount
            fsA.writeFileSync(pathA.join(rootNoAcct, '.claude.json'), JSON.stringify({
                userID: 'alt-config-id', machineID: 'per-machine-id', firstStartTime: 1,
            }));
            // Adjacent file (what would leak if the bug is present):
            fsA.writeFileSync(pathA.join(homeReg, '.claude.json'), JSON.stringify({
                oauthAccount: {
                    emailAddress: 'leaked-default@example.com', accountUuid: 'leaked-uuid-default',
                },
            }));

            const regResult = readAccountForRoot(rootNoAcct);
            assert.strictEqual(regResult, null,
                'a root whose own .claude.json has no oauthAccount must return null, never the adjacent account — leaked-default@example.com would indicate cross-root misattribution');

            // ─── Damaged file: unparseable JSON in the root ───
            // If the root's own file exists but is malformed, presence still
            // confirms the layout. A parse error is not the same as absence.
            const homeDamaged = pathA.join(tmp, 'homeDamaged');
            const rootDamaged = pathA.join(homeDamaged, '.claude-damaged');
            fsA.mkdirSync(pathA.join(rootDamaged, 'projects'), { recursive: true });
            // Root's own file: malformed JSON
            fsA.writeFileSync(pathA.join(rootDamaged, '.claude.json'), '{invalid json}');
            // Adjacent file (what would leak):
            fsA.writeFileSync(pathA.join(homeDamaged, '.claude.json'), JSON.stringify({
                oauthAccount: {
                    emailAddress: 'leaked-from-damaged@example.com', accountUuid: 'leaked-uuid-damaged',
                },
            }));

            const damagedResult = readAccountForRoot(rootDamaged);
            assert.strictEqual(damagedResult, null,
                'a root whose own .claude.json is unparseable must return null, never the adjacent account — leaked-from-damaged@example.com would indicate the fallback is still being tried');

            // ─── Default layout must still work ───
            // Root's own file is genuinely absent (no .claude.json inside root).
            // Fallback to adjacent file must still work.
            assert.ok(adjacent, 'default layout (absent inside, valid adjacent) must still resolve');
            assert.strictEqual(adjacent.email, 'adjacent@example.com',
                'verify Layout B fixture still works — this is the regression check for default layout');

            console.log('claude account discovery: all checks passed');
        }


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
                // Rows with no usage block at all are filtered by the cheap "usage"
                // pre-filter before parsing ever happens — these two prove that
                // pre-filter, not the type check below (that guard is proven
                // separately by req-user-usage, which is built to survive this
                // pre-filter and reach the type check).
                row({ type: 'user', timestamp: '2026-08-01T10:00:30.000Z',
                      message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
                row({ type: 'last-prompt', leafUuid: 'x', sessionId: 'session-1' }),
                // A non-assistant row that DOES carry a usage block and a valid,
                // non-synthetic model — survives the "usage" pre-filter and the
                // model check, so only the `type !== 'assistant'` check excludes
                // it. Distinct requestId: if that check is ever removed, this row
                // is counted as its own entry (entries.length goes to 4) rather
                // than silently colliding with an existing key.
                row({ type: 'user', requestId: 'req-user-usage', timestamp: '2026-08-01T10:00:31.000Z',
                      message: { model: 'claude-opus-4-8', usage: usage(), content: [] } }),
                // Synthetic model rows are not billable calls.
                row({ type: 'assistant', requestId: 'req-3', timestamp: '2026-08-01T10:02:00.000Z',
                      message: { model: '<synthetic>', usage: usage(), content: [] } }),
                // Invariant violation: thinking > output. Must be skipped, not stored.
                row({ type: 'assistant', requestId: 'req-4', timestamp: '2026-08-01T10:03:00.000Z',
                      message: { model: 'claude-opus-4-8',
                                 usage: usage({ output_tokens: 10, output_tokens_details: { thinking_tokens: 999 } }),
                                 content: [] } }),
                // A truncated line mid-write must not abort the file. It carries the
                // literal `"usage"` substring before the cut, so it survives the
                // pre-filter and actually reaches JSON.parse (which throws, and must
                // be caught) — a truncated line without that substring would be
                // filtered before ever exercising the try/catch, proving nothing
                // about it.
                '{"type":"assistant","requestId":"req-5","message":{"usage":{"in',
                // A valid row occurring AFTER the truncated line, to prove reading
                // continues past it rather than merely not crashing.
                row({ type: 'assistant', requestId: 'req-6', timestamp: '2026-08-01T10:04:00.000Z',
                      message: { model: 'claude-opus-4-8', usage: usage(),
                                 content: [{ type: 'text', text: 'after truncation' }] } }),
                '',
            ].join('\n'));

            const entries = await readClaudeTranscript(file);

            assert.strictEqual(entries.length, 3,
                'one entry per requestId: req-1 collapses 3 rows into one, req-2 and req-6 are separate ' +
                'real calls; req-3 (synthetic model), req-4 (thinking > output violation), req-user-usage ' +
                '(wrong row type, despite carrying a usage block), and the truncated req-5 line are all ' +
                'excluded for their own stated reason — a wrong count here means one of those four ' +
                'exclusions stopped working');

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

            const e6 = entries.find((e: any) => e.responseId === 'req-6');
            assert.ok(e6, 'a valid row occurring after a truncated line must still be read — the ' +
                'truncated line must not abort the rest of the file');

            assert.ok(!entries.some((e: any) => e.responseId === 'req-4'),
                'an entry violating thinking <= output must be skipped');
            assert.ok(!entries.some((e: any) => e.model === '<synthetic>'),
                'synthetic rows are not billable calls');
            assert.ok(!entries.some((e: any) => e.responseId === 'req-user-usage'),
                'a non-assistant row carrying a usage block must be excluded by the type check itself, ' +
                'not merely by lacking a usage block — this fixture row is built to survive the pre-filter');

            console.log('claude transcript reader: all checks passed');
        }

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
            const mkRow = (rid: string, ts: string) => JSON.stringify({
                type: 'assistant', requestId: rid, timestamp: ts,
                message: { model: 'claude-opus-4-8', usage, content: [{ type: 'text', text: 'x' }] },
            });

            const sessA = pathI.join(proj, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
            const sessB = pathI.join(proj, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
            fsI.writeFileSync(sessA, [mkRow('shared-req', '2026-08-01T10:00:00.000Z'),
                                      mkRow('only-a',     '2026-08-01T10:01:00.000Z')].join('\n'));
            // `shared-req` appears in BOTH files — a resumed session replays it.
            fsI.writeFileSync(sessB, [mkRow('shared-req', '2026-08-01T10:00:00.000Z'),
                                      mkRow('only-b',     '2026-08-02T10:00:00.000Z')].join('\n'));

            // ─── nested subagent transcripts: same-named directory beside the
            // top-level file (e.g. `<sess>/` next to `<sess>.jsonl` — different
            // names, legal to coexist), three levels deep under `subagents/`.
            // Real corpus measurement: 127 of 211 real transcripts (34.5% of
            // calls, 15.0% of tokens) live exactly here and were silently
            // dropped by a one-level-deep walk.
            const agentAaa = pathI.join(proj, 'aaaaaaaa-1111-2222-3333-444444444444', 'subagents', 'agent-aaa.jsonl');
            // `agent-same.jsonl` deliberately reused under BOTH sessions' subagents/
            // dirs — the regression this pins is a basename-only id colliding the two.
            const agentSameA = pathI.join(proj, 'aaaaaaaa-1111-2222-3333-444444444444', 'subagents', 'agent-same.jsonl');
            const agentSameB = pathI.join(proj, 'bbbbbbbb-1111-2222-3333-444444444444', 'subagents', 'agent-same.jsonl');
            fsI.mkdirSync(pathI.dirname(agentAaa), { recursive: true });
            fsI.mkdirSync(pathI.dirname(agentSameB), { recursive: true });
            fsI.writeFileSync(agentAaa, mkRow('agent-aaa-req', '2026-08-01T12:00:00.000Z'));
            fsI.writeFileSync(agentSameA, mkRow('agent-same-a-req', '2026-08-01T12:01:00.000Z'));
            fsI.writeFileSync(agentSameB, mkRow('agent-same-b-req', '2026-08-01T12:01:00.000Z'));

            const found = discoverClaudeTranscripts([root]);
            assert.strictEqual(found.length, 5,
                'all 5 transcripts discovered — 2 top-level sessions plus 3 nested subagents/*.jsonl files 3 ' +
                'levels deep; a shortfall here means nested transcripts under subagents/ are being missed');

            const first = await ingestClaudeUsage({ roots: [root] });

            assert.deepStrictEqual(
                Object.keys(first.perConvo).sort(),
                ['claude:aaaaaaaa-1111-2222-3333-444444444444',
                 'claude:aaaaaaaa-1111-2222-3333-444444444444:agent-aaa',
                 'claude:aaaaaaaa-1111-2222-3333-444444444444:agent-same',
                 'claude:bbbbbbbb-1111-2222-3333-444444444444',
                 'claude:bbbbbbbb-1111-2222-3333-444444444444:agent-same'],
                'ledger keys are claude:<sessionId>, or claude:<sessionId>:<agentId> for a nested subagent transcript');

            // ─── pin the exact nested id scheme (requirement 1) ───
            const nestedEntry = first.perConvo['claude:aaaaaaaa-1111-2222-3333-444444444444:agent-aaa'];
            assert.ok(nestedEntry, 'a nested subagents/agent-aaa.jsonl transcript produces its own ledger entry');
            assert.deepStrictEqual(nestedEntry.entries.map((e: any) => e.responseId), ['agent-aaa-req'],
                'the nested transcript is keyed <parent-session>:<agent-id>, exactly, and holds its own entries');

            // ─── no collision across sessions that each spawn an agent with the same id (requirement 2) ───
            const sameA = first.perConvo['claude:aaaaaaaa-1111-2222-3333-444444444444:agent-same'];
            const sameB = first.perConvo['claude:bbbbbbbb-1111-2222-3333-444444444444:agent-same'];
            assert.ok(sameA && sameB,
                'two different sessions each having a subagents/agent-same.jsonl produce two distinct ledger ids');
            assert.strictEqual(sameA.entries[0].responseId, 'agent-same-a-req',
                'session A\'s agent-same transcript keeps its own entry');
            assert.strictEqual(sameB.entries[0].responseId, 'agent-same-b-req',
                'session B\'s agent-same transcript keeps its own entry — under a basename-only id scheme ' +
                'these two files would collapse onto one ledger id and one would silently clobber the other');

            const total = Object.values(first.perConvo)
                .reduce((n: number, c: any) => n + c.entries.length, 0);
            assert.strictEqual(total, 7,
                'each of the 5 discovered files stores what it contains — 2 + 2 top-level, plus 1 entry each ' +
                'for the 3 nested subagent transcripts. `shared-req` legitimately appears in both top-level ' +
                'files, because a resumed session replays it.');

            // Cross-file dedupe is NOT this layer's job: aggregateFromPerConvo already
            // carries a `seenGlobally` set keyed on responseId for exactly this case
            // (sub-agent trajectories recording a parent's call). Duplicating it here
            // would double-suppress and undercount.
            const { aggregateFromPerConvo } = require('./aggregator');
            const agg = aggregateFromPerConvo(first.perConvo, new Map(), '');
            assert.strictEqual(agg.totalCalls, 6,
                'the aggregator collapses the one replayed responseId (shared-req) across the 7 stored entries');

            for (const c of Object.values(first.perConvo) as any[]) {
                for (const e of c.entries) {
                    assert.strictEqual(e.out + e.reasoning, 100, 'normalization survives ingestion');
                    assert.ok(e.accountKey === undefined || typeof e.accountKey === 'string');
                }
            }

            assert.strictEqual(Object.keys(first.mtimes).length, 5,
                'mtimes recorded per file, one per file — nested subagent transcripts each get their own mtime slot, never merged under a parent id');

            // Second pass with the same mtimes must skip everything, and must do so
            // WITHOUT opening either file — not merely "opens it, then discards the
            // result based on mtime." Monkeypatch fs.createReadStream (the one point
            // readClaudeTranscript actually opens a transcript) to record which paths
            // are ever opened, so a gate that reads-then-discards is distinguishable
            // from a gate that skips the parse entirely, per the task's own real
            // performance requirement (403MB / 191 files — a refresh must parse only
            // the files whose mtime moved).
            const realCreateReadStream = fsI.createReadStream;
            const opened: string[] = [];
            fsI.createReadStream = function (p: string, ...args: any[]) {
                opened.push(p);
                return realCreateReadStream.call(fsI, p, ...args);
            };
            let second: any;
            try {
                second = await ingestClaudeUsage({ roots: [root], mtimes: first.mtimes });
            } finally {
                fsI.createReadStream = realCreateReadStream;
            }
            assert.strictEqual(Object.keys(second.perConvo).length, 0,
                'unchanged transcripts are skipped entirely');
            assert.deepStrictEqual(opened, [],
                'neither unchanged file was opened at all — proves the mtime gate skips the parse, not just the store');

            // Touch one file: only that one comes back, and only that one is opened.
            const later = Date.now() / 1000 + 10;
            fsI.utimesSync(sessA, later, later);
            const openedThird: string[] = [];
            fsI.createReadStream = function (p: string, ...args: any[]) {
                openedThird.push(p);
                return realCreateReadStream.call(fsI, p, ...args);
            };
            let third: any;
            try {
                third = await ingestClaudeUsage({ roots: [root], mtimes: first.mtimes });
            } finally {
                fsI.createReadStream = realCreateReadStream;
            }
            assert.deepStrictEqual(Object.keys(third.perConvo),
                ['claude:aaaaaaaa-1111-2222-3333-444444444444'],
                'only the changed transcript is re-read');
            assert.deepStrictEqual(openedThird, [sessA],
                'only the touched file is actually opened — sessB, whose mtime did not move, must never be opened, ' +
                'not merely excluded from the result. Without this, an implementation that parses every file and ' +
                'only conditionally stores the result would pass every assertion above while still reading all ' +
                '403MB on every refresh.');

            // ─── the mtime gate is 1:1 per file for a NESTED transcript too (requirement 3) ───
            // Baseline "known" state reflects the touch already applied to sessA above (its
            // current on-disk mtime), so sessA is not spuriously re-flagged dirty here — only
            // the newly-touched nested file should come back.
            const knownAfterThird: Record<string, number> = { ...first.mtimes };
            knownAfterThird['claude:aaaaaaaa-1111-2222-3333-444444444444'] = fsI.statSync(sessA).mtimeMs;
            const evenLater = Date.now() / 1000 + 20;
            fsI.utimesSync(agentAaa, evenLater, evenLater);

            const openedFourth: string[] = [];
            fsI.createReadStream = function (p: string, ...args: any[]) {
                openedFourth.push(p);
                return realCreateReadStream.call(fsI, p, ...args);
            };
            let fourth: any;
            try {
                fourth = await ingestClaudeUsage({ roots: [root], mtimes: knownAfterThird });
            } finally {
                fsI.createReadStream = realCreateReadStream;
            }
            assert.deepStrictEqual(Object.keys(fourth.perConvo),
                ['claude:aaaaaaaa-1111-2222-3333-444444444444:agent-aaa'],
                'touching only a nested subagent transcript re-reads only its own composite id — not its ' +
                'parent session (sessA, which shares its "aaaaaaaa..." prefix, must stay untouched) and not ' +
                'any sibling nested transcript — proving the mtime gate is genuinely 1:1 per file, never merged');
            assert.deepStrictEqual(openedFourth, [agentAaa],
                'only the touched nested transcript is opened; sessA, sessB, and the two other nested ' +
                'transcripts (whose mtimes did not move) are never opened');

            console.log('claude ingestion: all checks passed');
        }

        // ─── I2: accountKey stamping obeys the accountCreatedAt boundary ───
        //
        // ingestClaudeUsage resolves ONE active account per pass and then
        // walks every transcript on disk. Stamping unconditionally meant a
        // cold ingest labelled the entire historical backlog with whoever is
        // logged in now — and accountFacetFor prefers a stamped accountKey
        // over the pinned result with no date check, so the claim is final.
        // Spec §7.2: "a row dated before an account existed can never be
        // attributed to it, even if a rule says otherwise."
        {
            const { ingestClaudeUsage: ingestI2 } = require('./claude');
            const fsI2 = require('fs'); const pathI2 = require('path'); const osI2 = require('os');

            const rootI2 = fsI2.mkdtempSync(pathI2.join(osI2.tmpdir(), 'ag-claude-i2-'));
            const projI2 = pathI2.join(rootI2, 'projects', '-Users-someone-repo');
            fsI2.mkdirSync(projI2, { recursive: true });

            const usageI2 = { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
            const rowI2 = (rid: string, ts: string) => JSON.stringify({
                type: 'assistant', requestId: rid, timestamp: ts,
                message: { model: 'claude-opus-4-8', usage: usageI2, content: [{ type: 'text', text: 'x' }] },
            });

            // One transcript straddling the account boundary: two rows before
            // the active account existed, one on the creation day, one after.
            fsI2.writeFileSync(pathI2.join(projI2, 'cccccccc-1111-2222-3333-444444444444.jsonl'), [
                rowI2('way-before', '2025-01-05T10:00:00.000Z'),
                rowI2('day-before', '2026-07-25T23:59:00.000Z'),
                rowI2('creation-day', '2026-07-26T00:30:00.000Z'),
                rowI2('after', '2026-08-10T10:00:00.000Z'),
            ].join('\n'));

            const ACTIVE_UUID_I2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            // Identity file INSIDE the root — the CLAUDE_CONFIG_DIR layout
            // readAccountForRoot tries first (see its doc comment).
            const writeIdentityI2 = (createdAt?: string) => fsI2.writeFileSync(
                pathI2.join(rootI2, '.claude.json'),
                JSON.stringify({ oauthAccount: {
                    emailAddress: 'someone@example.com',
                    accountUuid: ACTIVE_UUID_I2,
                    ...(createdAt ? { accountCreatedAt: createdAt } : {}),
                } }),
            );

            const keysFor = (res: any) => Object.values(res.perConvo)
                .flatMap((c: any) => c.entries)
                .reduce((m: Record<string, string | undefined>, e: any) => { m[e.responseId] = e.accountKey; return m; }, {});

            writeIdentityI2('2026-07-26T19:18:37.058600Z');
            const stampedI2 = keysFor(await ingestI2({ roots: [rootI2] }));

            assert.strictEqual(stampedI2['after'], ACTIVE_UUID_I2,
                'sanity: a row dated after the active account was created IS stamped with it — the guard must not ' +
                'disable stamping altogether');
            assert.strictEqual(stampedI2['creation-day'], ACTIVE_UUID_I2,
                'I2: the creation day itself belongs to the account, matching claudePins\' own inclusive day boundary');
            assert.strictEqual(stampedI2['day-before'], undefined,
                'I2: a row dated the day BEFORE the active account existed must not be stamped with it — spec §7.2. ' +
                'It falls through to era inference or unknown, both of which render honestly');
            assert.strictEqual(stampedI2['way-before'], undefined,
                'I2: nor may a year-old backlog row be stamped — this is the real-world case, a cold ingest after an ' +
                'account switch labelling the entire history with the new account');

            // No accountCreatedAt: the boundary is unknown, so nothing is
            // stamped rather than everything (spec §7.3 calls a root with no
            // usable identity normal, not an error).
            writeIdentityI2(undefined);
            const unknownBoundaryI2 = keysFor(await ingestI2({ roots: [rootI2] }));
            assert.ok(Object.values(unknownBoundaryI2).every((v) => v === undefined),
                'I2: with no accountCreatedAt to check against, no row is stamped — an unverifiable stamp is a claim ' +
                'we cannot support, and accountFacetFor would treat it as final');

            fsI2.rmSync(rootI2, { recursive: true, force: true });
            console.log('claude accountKey boundary guard: all checks passed');
        }

        // ─── Task 7 (revised): Claude ingestion hoisted to fetchDeepStats ───
        // The original placement (inside refreshFromStore's own merge site,
        // gated by that function's dirty.length===0 early return) meant Claude
        // data only updated when Antigravity's own store ALSO had something
        // dirty that pass — never on a server-mode ('usageSource: server')
        // pass, and never on a cold boot. This section replaces the old
        // refreshFromStore-based section entirely (that placement no longer
        // touches Claude data at all — see index.ts) with two parts:
        //   A. refreshClaudeUsage() exercised directly — the core merge,
        //      archive-preservation, and mtime-ordering logic, independent of
        //      which (if any) Antigravity path ran.
        //   B. fetchDeepStats's wiring — proving the call fires from BOTH call
        //      sites (disk-cache branch and cold-boot branch), regardless of
        //      useServerSource() or what the Antigravity path returned.
        // Headless replacement for the brief's Step 6 (launch the extension
        // host with F5 and inspect the panel) — no IDE is available here.

        // ─── A: refreshClaudeUsage — cold ingest, archive survival, warm no-op ───
        let claudeKeysHoistA: string[] = [];
        {
            const fsA = require('fs'); const pathA = require('path'); const osA = require('os');
            const { UsageStatsService: UsageStatsServiceA } = require('./index');
            const { StatsCache: StatsCacheA } = require('./cache');

            const tmpCacheA = pathA.join(osA.tmpdir(), 'ag-switchboard-selfcheck-claude-hoist-a.json');
            try { fsA.unlinkSync(tmpCacheA); } catch { /* absent is fine */ }
            class TestCacheA extends StatsCacheA {
                get filePath() { return tmpCacheA; }
            }
            const testCacheA = new TestCacheA();

            // Seed only the legacy archive convo — it has no backing file, so it
            // is the one entry that must NEVER be re-derived from a re-read,
            // only ever carried forward verbatim.
            const archiveEntryA = {
                ts: '2020-01-01T00:00:00.000Z', model: 'archived-model', provider: 'claude',
                input: 999, output: 111, cache: 0, cacheWrite: 0, reasoning: 0,
            };
            const seededPerConvoA = { [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [archiveEntryA] } };
            const seededStatsA = aggregateFromPerConvo(seededPerConvoA as any, new Map());
            testCacheA.write(seededPerConvoA, [LEGACY_CLAUDE_ARCHIVE_ID], seededStatsA, new Map(), undefined, undefined, {}, undefined);

            const svcA = new UsageStatsServiceA();
            svcA.cache = testCacheA;
            assert.strictEqual(Object.keys(svcA.claudeMtimes).length, 0,
                'sanity: a fresh service instance starts with no known Claude mtimes, so the call below is a genuine cold ingest');

            // ─── cold call: real Claude corpus on this machine, nothing known yet ───
            const tColdA = Date.now();
            const coldPersistedA = await svcA.refreshClaudeUsage();
            const coldMsA = Date.now() - tColdA;
            assert.strictEqual(coldPersistedA, true,
                'refreshClaudeUsage: a cold call with real Claude data to ingest reports true (persisted)');

            const afterColdA = testCacheA.read();
            assert.ok(afterColdA, 'the cache persisted after the cold call');

            // 1. Claude entries land under claude:-prefixed keys.
            claudeKeysHoistA = Object.keys(afterColdA.perConvo)
                .filter((k: string) => isClaudeConvo(k) && k !== LEGACY_CLAUDE_ARCHIVE_ID);
            assert.ok(claudeKeysHoistA.length > 0,
                'refreshClaudeUsage: claude:-prefixed entries land in the persisted ledger — guarantee 1 (Claude entries persisted)');

            // 2. Archive convo survives, entries byte-identical.
            assert.ok(afterColdA.perConvo[LEGACY_CLAUDE_ARCHIVE_ID],
                'refreshClaudeUsage: claude-code-imported survives a real refresh — guarantee 2 (archive survival)');
            assert.deepStrictEqual(afterColdA.perConvo[LEGACY_CLAUDE_ARCHIVE_ID].entries, [archiveEntryA],
                'refreshClaudeUsage: the archive entries are byte-identical after the refresh — proof that ' +
                'claude-code-imported was never added to presentIds, so mergeIntoLedger preserved it verbatim — ' +
                'guarantee 2 (archive survival)');
            const archiveTotalA = afterColdA.perConvo[LEGACY_CLAUDE_ARCHIVE_ID].entries
                .reduce((sum: number, e: any) => sum + e.input + e.output, 0);
            assert.strictEqual(archiveTotalA, 999 + 111,
                'refreshClaudeUsage: the archive token total is exactly what was seeded, not recomputed or dropped — guarantee 2');

            // 3. Persisted mtimes contains the Claude ids.
            assert.ok(afterColdA.mtimes, 'mtimes persisted');
            const persistedClaudeMtimeIdsA = Object.keys(afterColdA.mtimes).filter(isClaudeConvo);
            assert.ok(persistedClaudeMtimeIdsA.length > 0,
                'refreshClaudeUsage: persisted mtimes map contains Claude ids — guarantee 3 (mtime persistence)');
            assert.deepStrictEqual(
                new Set(persistedClaudeMtimeIdsA), new Set(Object.keys(svcA.claudeMtimes)),
                'refreshClaudeUsage: every Claude id the in-memory claudeMtimes map knows about made it into the ' +
                'persisted mtimes map — guarantee 3 (mtime persistence), the invariant a second launch\'s seed step depends on',
            );

            // ─── warm call: same instance, this.claudeMtimes already warm ───
            const tWarmA = Date.now();
            const warmPersistedA = await svcA.refreshClaudeUsage();
            const warmMsA = Date.now() - tWarmA;
            assert.strictEqual(warmPersistedA, false,
                'refreshClaudeUsage: a second call with nothing changed reports false (no new persist) — the mtime gate short-circuited');

            const afterWarmA = testCacheA.read();
            const warmClaudeKeysA = Object.keys(afterWarmA.perConvo)
                .filter((k: string) => isClaudeConvo(k) && k !== LEGACY_CLAUDE_ARCHIVE_ID);
            assert.deepStrictEqual(new Set(warmClaudeKeysA), new Set(claudeKeysHoistA),
                'refreshClaudeUsage: the warm call adds or loses no Claude ids');
            assert.deepStrictEqual(afterWarmA.perConvo[LEGACY_CLAUDE_ARCHIVE_ID].entries, [archiveEntryA],
                'refreshClaudeUsage: the archive survives a SECOND call unchanged too — guarantee 2 (archive survival)');

            fsA.unlinkSync(tmpCacheA);
            console.log(`refreshClaudeUsage direct: all checks passed (cold ${coldMsA}ms over ${claudeKeysHoistA.length} claude ids, warm ${warmMsA}ms)`);
        }

        // ─── A3: mtimes must NOT advance when the persist did not happen ───
        // cache.write() swallows its own fs errors internally (logs a WARN and
        // returns normally — it never throws), so a try/catch around the write
        // call alone could never detect this. Points filePath at a directory
        // that is deliberately never created, so the real fs.writeFileSync
        // inside write() throws ENOENT — a genuine, constructed failed-write,
        // not a simulated one.
        {
            const fsA3 = require('fs'); const pathA3 = require('path'); const osA3 = require('os');
            const { UsageStatsService: UsageStatsServiceA3 } = require('./index');
            const { StatsCache: StatsCacheA3 } = require('./cache');

            const brokenDirA3 = pathA3.join(osA3.tmpdir(), `ag-switchboard-selfcheck-claude-brokenpath-${Date.now()}`);
            const brokenPathA3 = pathA3.join(brokenDirA3, 'does-not-exist', 'cache.json');
            class BrokenTestCacheA3 extends StatsCacheA3 {
                get filePath() { return brokenPathA3; }
            }
            const svcA3 = new UsageStatsServiceA3();
            svcA3.cache = new BrokenTestCacheA3();
            assert.strictEqual(Object.keys(svcA3.claudeMtimes).length, 0, 'sanity: fresh instance, no known Claude mtimes yet');

            const withWarnMutedA3 = async (fn: () => Promise<any>): Promise<any> => {
                const original = console.warn;
                console.warn = () => { /* expected: "Failed to write disk cache" from the deliberately unwritable path */ };
                try { return await fn(); } finally { console.warn = original; }
            };

            const persistedA3 = await withWarnMutedA3(() => svcA3.refreshClaudeUsage());
            assert.strictEqual(persistedA3, false,
                'refreshClaudeUsage: reports false when the write could not be confirmed — guarantee 4 (mtime ordering)');
            assert.strictEqual(Object.keys(svcA3.claudeMtimes).length, 0,
                'refreshClaudeUsage: claudeMtimes must NOT advance when the persist did not happen — guarantee 4 (mtime ' +
                'ordering) — otherwise the next pass would skip re-parsing files whose entries were never actually saved');
            assert.ok(!fsA3.existsSync(brokenPathA3), 'sanity: the broken path genuinely never got written to');

            console.log('refreshClaudeUsage failed-write: all checks passed (mtimes did not advance)');
        }

        // ─── B: fetchDeepStats calls Claude ingestion unconditionally, from
        // BOTH call sites, regardless of useServerSource() or what the
        // Antigravity path returned. processLock is faked (an in-memory
        // stand-in matching its {acquire, release} shape) rather than driven
        // for real, since ProcessLock's lock file path
        // (~/.gemini/antigravity/brain/.deep_stats_cache.lock) has no
        // filePath-style override and this section must never touch real
        // shared state outside a temp file. incrementalRefresh/refreshFromStore
        // are stubbed per sub-test (own-property override — TypeScript
        // `private` has no runtime effect) rather than driven for real,
        // because incrementalRefresh needs a reachable language server (not
        // available in this environment) and driving refreshFromStore for
        // real would re-couple this section to this machine's real 136
        // Antigravity conversations — exactly the coupling that made the
        // pre-hoist "health survives reload" section's dirty:0 fixture
        // incompatible with ingestion running unconditionally. What stays
        // real: fetchDeepStats's own branch selection, the process-lock
        // acquire/release call sequence (against the fake), the cache
        // (temp-redirected StatsCache), and refreshClaudeUsage itself. ───
        {
            const fsB = require('fs'); const pathB = require('path'); const osB = require('os');
            const { UsageStatsService: UsageStatsServiceB } = require('./index');
            const { StatsCache: StatsCacheB } = require('./cache');

            const fakeLockB = () => ({
                acquire: () => true,
                release: () => { /* no-op */ },
                heartbeat: () => { /* no-op */ },
            });
            const fakeServerInfoB = { port: 59996, csrfToken: 'fake', protocol: 'http' };

            const makeSeededCacheB = (suffix: string) => {
                const p = pathB.join(osB.tmpdir(), `ag-switchboard-selfcheck-claude-hoist-b-${suffix}.json`);
                try { fsB.unlinkSync(p); } catch { /* absent is fine */ }
                class TestCacheB extends StatsCacheB { get filePath() { return p; } }
                const c = new TestCacheB();
                const seeded = {
                    [LEGACY_CLAUDE_ARCHIVE_ID]: {
                        entries: [{ ts: '2020-01-01T00:00:00.000Z', model: 'm', provider: 'claude', input: 1, output: 1, cache: 0, cacheWrite: 0, reasoning: 0 }],
                    },
                };
                const stats = aggregateFromPerConvo(seeded as any, new Map());
                c.write(seeded, [LEGACY_CLAUDE_ARCHIVE_ID], stats, new Map(), undefined, undefined, {}, undefined);
                return { path: p, cache: c };
            };

            // B1 — store mode, disk cache present, Antigravity finds nothing
            // dirty (stubbed refreshFromStore -> null, the real dirty.length===0
            // outcome). This is precisely the scenario that regressed before the
            // hoist: the ingestion call used to live inside refreshFromStore
            // itself, gated by that same early return, so this case never
            // ingested Claude data. (Verified: with the two refreshClaudeUsage()
            // call sites in fetchDeepStats commented out, this assertion fails
            // — 0 claude keys land — confirming this is a real regression test
            // for today's gap, not a vacuous one.)
            {
                const { cache, path } = makeSeededCacheB('b1');
                const svc = new UsageStatsServiceB();
                svc.cache = cache;
                svc.processLock = fakeLockB();
                svc.useServerSource = () => false;
                svc.refreshFromStore = async () => null;
                let backfillFired = false;
                const result = await svc.fetchDeepStats(fakeServerInfoB, false, () => { backfillFired = true; });
                assert.ok(result, 'fetchDeepStats (store mode, nothing dirty): still returns stats');
                const persisted = cache.read();
                const claudeKeys = Object.keys(persisted.perConvo).filter((k: string) => isClaudeConvo(k) && k !== LEGACY_CLAUDE_ARCHIVE_ID);
                assert.ok(claudeKeys.length > 0,
                    'B1: store mode with refreshFromStore reporting nothing dirty still ingests Claude data — the exact gap the hoist fixes');
                assert.ok(backfillFired,
                    'B1: onBackfillComplete fires when only Claude data changed, even though the Antigravity path itself reported nothing updated');
                fsB.unlinkSync(path);
            }

            // B2 — server mode (incrementalRefresh) — a path that never calls
            // refreshFromStore at all, even before the hoist. incrementalRefresh
            // is stubbed to "nothing to fetch" (false) since the real method
            // needs a reachable language server.
            {
                const { cache, path } = makeSeededCacheB('b2');
                const svc = new UsageStatsServiceB();
                svc.cache = cache;
                svc.processLock = fakeLockB();
                svc.useServerSource = () => true;
                svc.incrementalRefresh = async () => false;
                const result = await svc.fetchDeepStats(fakeServerInfoB, false);
                assert.ok(result, 'fetchDeepStats (server mode): still returns stats');
                const persisted = cache.read();
                const claudeKeys = Object.keys(persisted.perConvo).filter((k: string) => isClaudeConvo(k) && k !== LEGACY_CLAUDE_ARCHIVE_ID);
                assert.ok(claudeKeys.length > 0,
                    'B2: a path that never calls refreshFromStore (server-mode incrementalRefresh) still ingests Claude data');
                fsB.unlinkSync(path);
            }

            // B3 — cold boot: no disk cache exists at all yet, exercising the
            // SECOND, structurally distinct call site in fetchDeepStats (the
            // no-diskCache branch) via its store-mode sub-path
            // (refreshFromStore(serverInfo, null), stubbed). twoPhaseFullFetch's
            // own server-mode sub-path of this same branch was not driven
            // separately — see the report for why and what a human should check.
            {
                const p = pathB.join(osB.tmpdir(), 'ag-switchboard-selfcheck-claude-hoist-b3.json');
                try { fsB.unlinkSync(p); } catch { /* absent is fine */ }
                class TestCacheB3 extends StatsCacheB { get filePath() { return p; } }
                const cache = new TestCacheB3();
                assert.strictEqual(cache.read(), null, 'sanity: nothing has ever been written to this path — a genuine cold boot');

                const svc = new UsageStatsServiceB();
                svc.cache = cache;
                svc.processLock = fakeLockB();
                svc.useServerSource = () => false;
                svc.refreshFromStore = async () => null;
                const result = await svc.fetchDeepStats(fakeServerInfoB, false);
                assert.ok(result, 'fetchDeepStats (cold boot): still returns stats');
                const persisted = cache.read();
                assert.ok(persisted, 'B3: cold boot creates a cache from Claude data alone — no Antigravity data was ever written');
                const claudeKeys = Object.keys(persisted.perConvo).filter(isClaudeConvo);
                assert.ok(claudeKeys.length > 0,
                    'B3: a from-scratch cold boot with zero Antigravity data still ingests Claude data — also closes the ' +
                    '"conversations.length===0" gap noted in the Task 7 report, as a side effect of the hoist');
                fsB.unlinkSync(p);
            }

            console.log('fetchDeepStats -> refreshClaudeUsage wiring: all checks passed (store-mode dirty:0, server-mode, cold-boot)');
        }

        // ─── C1 + C2 + I4: refreshClaudeUsage must not corrupt fields it does
        // not own. this.currentStepCounts, this.currentPerConvo, and
        // this.lastHealth are all still empty/null on exactly the paths the
        // hoist newly reaches (store mode with dirty.length===0; a
        // server-mode pass whose fetchTrajectorySummaries call failed or
        // never ran; a zero-Antigravity install) — a write built only from
        // in-memory state there silently blanks stepCounts, shrinks
        // fetchedIds, and drops health, none of which existingPerConvo's own
        // diskCache fallback protects. One seeded cache, one real
        // refreshClaudeUsage() call, three assertions in a fixed order so a
        // regression in any one of the three fails at that specific
        // assertion, not a later unrelated one. ───
        {
            const fsCI = require('fs'); const pathCI = require('path'); const osCI = require('os');
            const { UsageStatsService: UsageStatsServiceCI } = require('./index');
            const { StatsCache: StatsCacheCI } = require('./cache');

            const tmpCacheCI = pathCI.join(osCI.tmpdir(), 'ag-switchboard-selfcheck-claude-c1c2i4.json');
            try { fsCI.unlinkSync(tmpCacheCI); } catch { /* absent is fine */ }
            class TestCacheCI extends StatsCacheCI {
                get filePath() { return tmpCacheCI; }
            }
            const testCacheCI = new TestCacheCI();

            // Seed: a real archived entry, a non-empty stepCounts (C1), an id
            // present ONLY in fetchedIds and absent from perConvo — the exact
            // "fetched, produced zero entries" shape twoPhaseFullFetch itself
            // writes (C2) — and a stats object carrying .health (I4).
            const seededPerConvoCI = {
                [LEGACY_CLAUDE_ARCHIVE_ID]: {
                    entries: [{ ts: '2020-01-01T00:00:00.000Z', model: 'm', provider: 'claude', input: 5, output: 5, cache: 0, cacheWrite: 0, reasoning: 0 }],
                },
            };
            const zeroEntryIdCI = 'zero-entry-convo-c2';
            const seededFetchedIdsCI = [LEGACY_CLAUDE_ARCHIVE_ID, zeroEntryIdCI];
            const seededStepCountsCI = new Map([['some-antigravity-convo', 7]]);
            const seededHealthCI = { source: 'store', conversations: 42, unreadable: 0, unknownModels: [], skippedRows: 0, verification: null, countingChangedAt: null };
            const seededStatsCI = aggregateFromPerConvo(seededPerConvoCI as any, new Map());
            seededStatsCI.health = seededHealthCI;
            testCacheCI.write(seededPerConvoCI, seededFetchedIdsCI, seededStatsCI, new Map(), seededStepCountsCI, undefined, {}, undefined);

            const seededDiskCI = testCacheCI.read();
            assert.ok(seededDiskCI, 'sanity: the seeded temp cache reads back');
            assert.deepStrictEqual(seededDiskCI.stepCounts, { 'some-antigravity-convo': 7 }, 'sanity: stepCounts seeded correctly');
            assert.ok(seededDiskCI.fetchedIds.includes(zeroEntryIdCI),
                'sanity: the zero-entry id is present in fetchedIds but not in perConvo, mirroring twoPhaseFullFetch\'s own shape');
            assert.ok(!seededDiskCI.perConvo[zeroEntryIdCI], 'sanity: ...and genuinely absent from perConvo');

            const svcCI = new UsageStatsServiceCI();
            svcCI.cache = testCacheCI;
            assert.strictEqual(svcCI.currentStepCounts.size, 0, 'sanity: a fresh service instance has not populated currentStepCounts this cycle');
            assert.strictEqual(Object.keys(svcCI.currentPerConvo).length, 0, 'sanity: ...nor currentPerConvo');
            assert.strictEqual(svcCI.lastHealth, null, 'sanity: ...nor lastHealth');

            const resultCI = await svcCI.refreshClaudeUsage();
            assert.strictEqual(resultCI, true, 'sanity: real Claude corpus produces a genuine write this pass');

            const afterCI = testCacheCI.read();

            // C1 — stepCounts must not be blanked.
            assert.deepStrictEqual(afterCI.stepCounts, { 'some-antigravity-convo': 7 },
                'C1: persisted stepCounts must survive a Claude-only write via the diskCache fallback (mirrors titleMap) — an ' +
                'empty in-memory currentStepCounts must not silently replace it with {}, which would destroy server-mode ' +
                'delta state and force incrementalRefresh to re-fetch the entire corpus on its next pass');

            // C2 — fetchedIds must not shrink.
            assert.ok(afterCI.fetchedIds.includes(zeroEntryIdCI),
                'C2: a fetched-but-zero-entries id must survive in fetchedIds — replacing it with Object.keys(merged) alone ' +
                'drops ids twoPhaseFullFetch legitimately tracks there but never puts in perConvo, causing permanent ' +
                're-fetch oscillation on every subsequent incrementalRefresh pass');

            // I4 — health must not be dropped.
            assert.ok(afterCI.stats.health,
                'I4: health must not be dropped on the Claude-only path when this.lastHealth is unset this cycle');
            assert.deepStrictEqual(afterCI.stats.health, seededHealthCI,
                'I4: the health already on disk must survive a Claude-only write when this.lastHealth is null — otherwise ' +
                'the health card goes dark on exactly the zero-Antigravity install this hoist exists to serve');

            fsCI.unlinkSync(tmpCacheCI);
            console.log('refreshClaudeUsage field preservation (C1 stepCounts, C2 fetchedIds, I4 health): all checks passed');
        }

        // ─── C3: refuse to write when read() returns null but a cache file
        // exists on disk — the archive-preservation guarantee at its last
        // unguarded point. A hand-written file with schemaVersion:99 is the
        // cleanest trigger: read()'s own schema gate rejects it (returns
        // null) while fs.existsSync sees it plainly. Without the guard,
        // refreshClaudeUsage would fall back to this.currentPerConvo (still
        // {} on a fresh instance) and silently overwrite this file with
        // Claude-only content, discarding whatever the real file held —
        // including, on a real machine, LEGACY_CLAUDE_ARCHIVE_ID's entries,
        // which have no source file anywhere and cannot be regenerated. ───
        {
            const fsC3 = require('fs'); const pathC3 = require('path'); const osC3 = require('os');
            const { UsageStatsService: UsageStatsServiceC3 } = require('./index');
            const { StatsCache: StatsCacheC3 } = require('./cache');

            const brokenSchemaPathC3 = pathC3.join(osC3.tmpdir(), 'ag-switchboard-selfcheck-claude-c3-badschema.json');
            const brokenSchemaContentC3 = JSON.stringify({
                schemaVersion: 99,
                perConvo: { [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [{ ts: '2020-01-01T00:00:00.000Z', model: 'm', provider: 'claude', input: 111222, output: 333444, cache: 0, cacheWrite: 0, reasoning: 0 }] } },
                fetchedIds: [LEGACY_CLAUDE_ARCHIVE_ID],
                stats: { totalCalls: 1 },
                updatedAt: new Date().toISOString(),
            });
            fsC3.writeFileSync(brokenSchemaPathC3, brokenSchemaContentC3, 'utf-8');

            class BrokenSchemaCacheC3 extends StatsCacheC3 {
                get filePath() { return brokenSchemaPathC3; }
            }
            const svcC3 = new UsageStatsServiceC3();
            svcC3.cache = new BrokenSchemaCacheC3();

            assert.strictEqual(svcC3.cache.read(), null,
                'sanity: read() rejects the unsupported schemaVersion — exactly the null-but-file-exists trigger');
            assert.ok(fsC3.existsSync(brokenSchemaPathC3), 'sanity: the file genuinely exists on disk');

            // Non-vacuity (deferred item 22): `false` below must mean "the
            // guard fired", not "this pass had nothing to ingest" —
            // refreshClaudeUsage also returns false at its earlier
            // no-new-mtimes exit, which would make every assertion in this
            // section hold on unguarded code too. Section A above already
            // proved, in this same process and against this same machine's
            // corpus, that a cold ingest yields real Claude ids; svcC3 is a
            // fresh instance, so its claudeMtimes are empty and its pass is
            // likewise cold.
            assert.ok(claudeKeysHoistA.length > 0,
                'C3 non-vacuity: this machine has Claude transcripts that a cold pass ingests (proved in section A), so ' +
                'the false below is the archive-destruction guard firing, not an empty ingest short-circuiting first');
            assert.strictEqual(Object.keys(svcC3.claudeMtimes).length, 0,
                'C3 non-vacuity: svcC3 is a fresh instance — its pass is cold, exactly like section A\'s');

            const resultC3 = await svcC3.refreshClaudeUsage();
            assert.strictEqual(resultC3, false,
                'C3: refreshClaudeUsage refuses to write and returns false when read() returns null but a cache file ' +
                'exists on disk — the archive-preservation guarantee at its last unguarded point');

            const afterC3 = fsC3.readFileSync(brokenSchemaPathC3, 'utf-8');
            assert.strictEqual(afterC3, brokenSchemaContentC3,
                'C3: the file on disk is byte-identical after the call — no write occurred, so nothing (real Antigravity ' +
                'data, or the un-regenerable claude-code-imported archive) was silently clobbered');

            fsC3.unlinkSync(brokenSchemaPathC3);
            // StatsCache preserves a copy of any file it rejects (see
            // preserveRejected) — including this fixture's. Tidy it up, or
            // every self-check run leaves one behind in the temp directory.
            {
                const dirC3 = pathC3.dirname(brokenSchemaPathC3);
                const stemC3 = pathC3.basename(brokenSchemaPathC3).replace(/\.json$/, '') + '.rejected-';
                for (const f of fsC3.readdirSync(dirC3)) {
                    if (f.startsWith(stemC3)) fsC3.unlinkSync(pathC3.join(dirC3, f));
                }
            }
            console.log('refreshClaudeUsage refuses to write on null-but-file-exists: all checks passed');
        }

        // ─── C4 (final review, C1): the refusal is a property of the CACHE,
        // and fetchDeepStats as a whole cannot destroy a rejected file ───
        //
        // The section above drives refreshClaudeUsage, which is the LAST of
        // four write callers to run. The two that run before it —
        // twoPhaseFullFetch (two bare cache.write calls) and refreshFromStore
        // on the cold-boot path (merging against an empty cachedPerConvo) —
        // had no guard at all, so by the time the guard above was consulted
        // the file had already been rebuilt and was valid again: the guard
        // passed while the archive was already gone. This section asserts the
        // property that actually protects the file, at both levels:
        //
        //   1. StatsCache.write() itself refuses while the file on disk is
        //      present-but-undecodable. Caller-independent, so it covers
        //      twoPhaseFullFetch and any writer added later.
        //   2. fetchDeepStats end-to-end, with the REAL refreshFromStore
        //      (only cache.write is redirected to a temp path), leaves the
        //      file byte-identical.
        //
        // A schemaVersion:99 file is the trigger, but the same 'unreadable'
        // state is reached by a truncated file, a missing top-level field, or
        // — the case this branch itself introduces — a v3 file read by the
        // pre-upgrade v2 build's successor logic. This is the assertion that
        // should have existed all along.
        {
            const fsC4 = require('fs'); const pathC4 = require('path'); const osC4 = require('os');
            const { UsageStatsService: UsageStatsServiceC4 } = require('./index');
            const { StatsCache: StatsCacheC4 } = require('./cache');

            const pathV99 = pathC4.join(osC4.tmpdir(), `ag-switchboard-selfcheck-c4-v99-${Date.now()}.json`);
            // Distinctive, un-regenerable content: the archive with token
            // counts nothing else on this machine could reproduce.
            const contentV99 = JSON.stringify({
                schemaVersion: 99,
                perConvo: {
                    [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [
                        { ts: '2026-03-03T00:00:00.000Z', model: 'archived', provider: 'claude', responseId: 'cc-archive-1', source: 'metadata', inp: 12345678, out: 87654321, cache: 0, cacheWrite: 0, reasoning: 0 },
                    ] },
                },
                fetchedIds: [LEGACY_CLAUDE_ARCHIVE_ID],
                stats: { totalCalls: 1 },
                updatedAt: '2026-09-06T00:00:00.000Z',
            });

            const backupsOf = (p: string): string[] => {
                const dir = pathC4.dirname(p);
                const stem = pathC4.basename(p).replace(/\.json$/, '') + '.rejected-';
                return fsC4.readdirSync(dir)
                    .filter((f: string) => f.startsWith(stem))
                    .map((f: string) => pathC4.join(dir, f));
            };

            const withWarnCapturedC4 = async (fn: () => Promise<any> | any): Promise<{ result: any; warns: string }> => {
                const original = console.warn;
                let warns = '';
                console.warn = (...args: any[]) => { warns += args.map(String).join(' ') + '\n'; };
                try { return { result: await fn(), warns }; }
                finally { console.warn = original; }
            };

            // ── 1. cache-level: write() refuses, caller-independent ──
            {
                fsC4.writeFileSync(pathV99, contentV99, 'utf-8');
                class V99Cache extends StatsCacheC4 { get filePath() { return pathV99; } }
                const cache = new V99Cache();

                assert.strictEqual(cache.probe(), 'unreadable',
                    'probe() classifies a present-but-undecodable file as unreadable — the state every write must refuse');
                assert.strictEqual(cache.read(), null, 'sanity: read() rejects it, the state the old single-path guard keyed on');
                assert.ok(fsC4.existsSync(pathV99), 'sanity: the file is plainly there');

                // The exact shape twoPhaseFullFetch writes: a bare write with
                // no mergeIntoLedger and no existence check, carrying data
                // that does not contain the archive.
                const rebuilt: any = { 'some-antigravity-convo': { entries: [
                    { ts: '2026-09-01T00:00:00.000Z', model: 'm', provider: 'x', responseId: 'r-rebuild', source: 'metadata', inp: 1, out: 1, cache: 0, cacheWrite: 0, reasoning: 0 },
                ] } };
                const { warns } = await withWarnCapturedC4(() =>
                    cache.write(rebuilt, ['some-antigravity-convo'], aggregateFromPerConvo(rebuilt, new Map()), new Map()));

                assert.strictEqual(fsC4.readFileSync(pathV99, 'utf-8'), contentV99,
                    'C1/1: StatsCache.write() leaves a rejected file BYTE-IDENTICAL. This is what covers twoPhaseFullFetch\'s ' +
                    'two bare writes and refreshFromStore\'s cold-boot merge-against-{} — the two callers that ran BEFORE the ' +
                    'only guard that existed, so that guard was a no-op by the time it was consulted');

                // 3. Surfaced, not silent.
                assert.ok(/rejected|Refusing to write/i.test(warns),
                    'C1/3: a rejected cache logs a warning the user can find, rather than silently rebuilding');

                // 2. Preserved before anything could overwrite it.
                const copies = backupsOf(pathV99);
                assert.strictEqual(copies.length, 1,
                    'C1/2: exactly one .rejected-<ISO>.json copy is taken (once per session, not once per refresh pass)');
                assert.strictEqual(fsC4.readFileSync(copies[0], 'utf-8'), contentV99,
                    'C1/2: the preserved copy is byte-identical to the rejected file — the spec\'s §15 "take a copy" ' +
                    'instruction, mechanically enforced instead of addressed to a human');

                for (const c of copies) fsC4.unlinkSync(c);
                fsC4.unlinkSync(pathV99);
            }

            // ── 2. fetchDeepStats end-to-end, real refreshFromStore ──
            //
            // Deliberately NOT stubbed, unlike section B: refreshFromStore's
            // cold-boot path (diskCache === null, merging against an empty
            // cachedPerConvo) is one of the two unguarded writers, so stubbing
            // it out would remove the very thing under test. Everything it
            // touches beyond the redirected cache is read-only (the real
            // conversation store) and its title fetch fails harmlessly against
            // the fake port.
            {
                fsC4.writeFileSync(pathV99, contentV99, 'utf-8');
                class V99Cache2 extends StatsCacheC4 { get filePath() { return pathV99; } }
                const svc = new UsageStatsServiceC4();
                svc.cache = new V99Cache2();
                svc.processLock = { acquire: () => true, release: () => { /* no-op */ }, heartbeat: () => { /* no-op */ } };
                svc.useServerSource = () => false;

                const { warns } = await withWarnCapturedC4(() =>
                    svc.fetchDeepStats({ port: 59996, csrfToken: 'fake', protocol: 'http' } as any, false));

                assert.strictEqual(fsC4.readFileSync(pathV99, 'utf-8'), contentV99,
                    'C1/4: a whole fetchDeepStats pass over a rejected cache leaves it BYTE-IDENTICAL. Without the ' +
                    'cache-level refusal the real refreshFromStore rebuilds this machine\'s Antigravity ledger straight ' +
                    'over it and claude-code-imported — 175 entries, 12,942,976,240 tokens, no source files anywhere — ' +
                    'is gone, with the next pass migrating the archive-free file to v3');
                assert.ok(/rejected|Refusing to write/i.test(warns),
                    'C1/4: the refusal is surfaced on the real refresh path too, not only on a direct write');

                const copies = backupsOf(pathV99);
                assert.ok(copies.length >= 1, 'C1/4: the rejected file was preserved before the pass could touch it');
                for (const c of copies) fsC4.unlinkSync(c);
                fsC4.unlinkSync(pathV99);
            }

            console.log('C1 cache-level write refusal + rejected-file preservation: all checks passed');
        }

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

            // Documented assumption: responseId spaces are disjoint across providers
            // (cc-<model>-<date> / req_* for Claude vs opaque base64 like
            // -0BearmYFcPGjuMPq9bZsQk for Antigravity). aggregateFromPerConvo dedupes
            // responseId GLOBALLY within one call via its internal seenGlobally set,
            // so a combined aggregation would count a cross-provider duplicate once —
            // but aggregateByProvider aggregates each side with its own separate call,
            // so the same responseId appearing on both sides is counted on BOTH sides.
            // This is the documented, accepted behaviour (see aggregateByProvider's
            // doc comment), not a bug: a duplicate responseId across providers would
            // itself be a data bug (the id spaces are structurally disjoint), and
            // counting it twice surfaces that bug instead of silently hiding it via a
            // cross-call global dedupe. This assertion PINS that behaviour so nobody
            // "fixes" it into a silent cross-provider dedupe later without noticing.
            const dupPerConvo: any = {
                'claude:dup-sess': { entries: [entry('shared-rid', '2026-08-02T10:00:00.000Z', 'anthropic', 'claude-opus-4-8')] },
                '11111111-2222-3333-4444-555555555555': {
                    entries: [entry('shared-rid', '2026-08-02T10:05:00.000Z', 'API_PROVIDER_GOOGLE_GEMINI', 'MODEL_PLACEHOLDER_M20')] },
            };
            const dupSplit = aggregateByProvider(dupPerConvo, new Map(), '');
            assert.strictEqual(dupSplit.claude.totalCalls, 1,
                'PINNED (not a bug): a responseId shared across providers is counted on the Claude side too — ' +
                'aggregateByProvider dedupes per-side, not globally, because provider id spaces are documented ' +
                'as disjoint; do not "fix" this into a cross-provider global dedupe');
            assert.strictEqual(dupSplit.antigravity.totalCalls, 1,
                'PINNED (not a bug): the same shared responseId is ALSO counted on the Antigravity side — a ' +
                'combined aggregateFromPerConvo call would count it once via seenGlobally, but the partitioned ' +
                'wrapper counts it twice by design (see aggregateByProvider doc comment)');

            console.log('provider partition: all checks passed');
        }

        // ─── account facet and honesty markers ───
        {
            const { accountFacetFor, setClaudeAccountResolver } = require('../../shared/usage-components');

            // The date rules are gated on one of the pinned accounts actually
            // being present on this machine (I6), and accountFacetFor takes
            // that list from the registered resolver. Registered here with the
            // OLDER pinned account: it satisfies the gate while supplying no
            // email for the uuid the fixture rows are stamped with, which is
            // what keeps the pinned-email path below observable rather than
            // short-circuited by a discovered email. Restored to empty at the
            // end of this section — the resolver is module-global state, and
            // the HTML sections further down assert against its default.
            setClaudeAccountResolver(() => [
                { accountUuid: '348cc96d-a86f-4963-9db5-bf1da5ba879a', email: 'well.j@honestdocs.co' },
            ]);

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

            // ─── the pins-email guard, both directions ───
            //
            // accountFacetFor calls resolveBacklogAccount even for a row that
            // already carries an accountKey, and uses the pinned EMAIL only
            // when pinned.accountUuid === that key. No resolver is registered
            // in this process (setClaudeAccountResolver is called from
            // usageStatsPanel.ts, which needs vscode), so the pinned email is
            // the ONLY source of a human-readable label here — which is what
            // makes both directions observable.
            //
            // Agreement: 'claude:sess-1' above is stamped with Varakorn's own
            // uuid on a date the pins also resolve to Varakorn, so the label
            // is the email.
            assert.strictEqual(vara.label, 'varakorn.j@topgunthailand.com',
                'a stamped row whose accountKey MATCHES the date-derived pin takes the pinned email');

            // Disagreement: same era (2026-08 → pins resolve to Varakorn),
            // but stamped with a different account. The pinned email must not
            // be borrowed — that would print one person\'s address against
            // another account\'s usage. With nothing else to label it, the row
            // shows its raw uuid.
            const STRANGER = 'ffffffff-1111-2222-3333-444444444444';
            const mismatched = accountFacetFor({
                'claude:sess-mismatch': { entries: [entry('m1', '2026-08-05T10:00:00.000Z', STRANGER)] },
            } as any);
            assert.strictEqual(mismatched.length, 1);
            assert.strictEqual(mismatched[0].accountUuid, STRANGER,
                'the stamped accountKey wins for the uuid itself, never the pinned one');
            assert.strictEqual(mismatched[0].label, STRANGER,
                'a stamped row whose accountKey DISAGREES with the date-derived pin must fall back to the raw ' +
                'uuid — never to the pinned email, which belongs to a different account');
            assert.ok(!mismatched[0].label.includes('@'),
                'no email at all is attached to an account the pins did not resolve to');

            // ─── I1: the facet can never exceed the header above it ───
            //
            // The missing half of the spec's §13 test 2 (requestId dedupe): it
            // landed for the reader and the aggregator, never for the facet.
            // Ingestion deliberately STORES a cross-file replay (a resumed
            // session re-sends a request, so the same requestId appears in two
            // transcripts) and lets whoever aggregates collapse it — Ruling
            // 12. accountFacetFor summed every stored entry instead, so the
            // per-account breakdown rendered LARGER than the provider total
            // directly above it: on the live corpus, header 15,695,716,154
            // tokens / 9,532 calls against facet 15,876,386,492 / 9,920.
            //
            // Both sides dedupe in the same object-insertion order and keep
            // the first copy, so this is an exact equality, not a tolerance.
            {
                const { aggregateByProvider: aggByProv } = require('./aggregator');
                const row = (rid: string, ts: string, out: number, accountKey?: string) => ({
                    responseId: rid, source: 'metadata', inp: 0, out, cache: 0,
                    cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8',
                    provider: 'anthropic', ts, accountKey,
                });
                const KEY = '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7';
                // 'req-replay' appears in BOTH sessions — exactly what a
                // resumed Claude session writes into a second transcript.
                const replayLedger: any = {
                    'claude:sess-a': { entries: [
                        row('req-a1', '2026-08-01T10:00:00.000Z', 10, KEY),
                        row('req-replay', '2026-08-01T10:05:00.000Z', 1000, KEY),
                    ] },
                    'claude:sess-b': { entries: [
                        row('req-replay', '2026-08-02T09:00:00.000Z', 1000, KEY),
                        row('req-b1', '2026-08-02T09:05:00.000Z', 20, KEY),
                    ] },
                };

                const facetRows = accountFacetFor(replayLedger);
                const provSplit = aggByProv(replayLedger, new Map(), '');

                const facetTokens = facetRows.reduce((s: number, r: any) => s + r.tokens, 0);
                const facetCalls = facetRows
                    .filter((r: any) => r.calls !== null)
                    .reduce((s: number, r: any) => s + r.calls, 0);

                assert.strictEqual(provSplit.claude.totalCalls, 3,
                    'sanity: the aggregator collapses the cross-file replay — 4 stored entries, 3 real calls');

                assert.strictEqual(facetTokens, provSplit.claude.totalTokens,
                    'I1: the account facet\'s token sum must EQUAL the provider header it renders under. Counting every ' +
                    'stored entry makes the breakdown exceed its own total (measured live: +180,670,338 tokens), because ' +
                    'ingestion stores cross-file replays on purpose and expects the aggregator\'s responseId collapse');
                assert.strictEqual(facetCalls, provSplit.claude.totalCalls,
                    'I1: the facet\'s non-null call sum must EQUAL the header\'s call count (measured live: +388 calls)');
            }

            // ─── I6 at the facet level: a stranger's machine gets `unknown` ───
            //
            // The end-to-end shape of the leak: a config root with no
            // `oauthAccount` (normal per spec §7.3) stamps no accountKey, so
            // the pins are the only resolver — and before the machine gate,
            // this row rendered as varakorn.j@topgunthailand.com on a
            // stranger's dashboard.
            setClaudeAccountResolver(() => [
                { accountUuid: '00000000-9999-8888-7777-666666666666', email: 'someone@else.example' },
            ]);
            const strangerRows = accountFacetFor({
                'claude:their-session': { entries: [entry('their-1', '2026-08-20T10:00:00.000Z')] },
            } as any);
            assert.strictEqual(strangerRows.length, 1);
            assert.strictEqual(strangerRows[0].accountUuid, null,
                'I6: an unstamped row on a machine the pins do not describe resolves to no account at all');
            assert.strictEqual(strangerRows[0].label, 'unknown account',
                'I6: it renders as "unknown account" — never as one of the two pinned work emails compiled into ' +
                'the published extension');

            // Restore the default: module-global state, and the HTML sections
            // below assert against an unregistered resolver.
            setClaudeAccountResolver(() => []);

            console.log('account facet: all checks passed');
        }

        // ─── provider sections & the cost cell: HTML-level honesty markers ───
        //
        // The three assertions this section exists for are each individually
        // prone to passing for the wrong reason (see the review that flagged
        // this plan's pattern of tests that cannot fail):
        //   - a rollup row's calls being null passes trivially if the row
        //     never rendered at all — so this checks the row's label
        //     actually appears, not just that "175" is absent.
        //   - "no $0.00" passes trivially if nothing priced rendered at
        //     all — so this fixture renders a real priced model alongside
        //     the unresolved one, and checks the priced one's dollar figure
        //     is genuinely present.
        //   - "no summed total" needs a positive assertion (an exact count
        //     of token cells), not just the absence of one string that
        //     happens not to collide with this fixture's numbers.
        {
            const { accountFacetFor, renderProviderSection, renderProviderRegion, renderCostEstimate } =
                require('../../shared/usage-components');
            const { aggregateByProvider, aggregateFromPerConvo } = require('./aggregator');
            const { modelNameFromEnum } = require('./store/enumMap');
            const { fmtBig } = require('../../shared/helpers');

            const claudeEntry = (rid: string, ts: string, accountKey?: string) => ({
                responseId: rid, source: 'metadata', inp: 1000, out: 200, cache: 0,
                cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8',
                provider: 'anthropic', ts, accountKey,
            });
            const antigravityEntry = (rid: string, ts: string) => ({
                responseId: rid, source: 'metadata', inp: 500, out: 50, cache: 0,
                cacheWrite: 0, reasoning: 0, model: 'MODEL_PLACEHOLDER_M20',
                provider: 'API_PROVIDER_GOOGLE_GEMINI', ts,
            });

            // The real archive's actual shape: one entry per model per day,
            // 175 entries for six months of work. Built out in full (not a
            // handful of stand-ins) so a regression that prints the raw
            // entry count instead of an em dash shows up as the literal
            // digits "175" — not an arbitrarily small number that could
            // pass the assertion below by coincidence.
            const rollupEntries: any[] = [];
            for (let i = 0; i < 175; i++) {
                const day = String(1 + (i % 28)).padStart(2, '0');
                const month = String(1 + Math.floor(i / 28)).padStart(2, '0');
                rollupEntries.push(claudeEntry(`cc-${i}`, `2026-${month}-${day}T12:00:00.000Z`));
            }

            const perConvo: any = {
                'claude:sess-1': { entries: [
                    claudeEntry('r1', '2026-08-01T10:00:00.000Z', '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7')] },
                'claude-code-imported': { entries: rollupEntries },
                '00b78c15-c64b-490f-8dec-7187d9e8c06a': { entries: [
                    antigravityEntry('g1', '2026-08-01T11:00:00.000Z'),
                    antigravityEntry('g2', '2026-08-01T12:00:00.000Z'),
                ] },
            };

            const facet = accountFacetFor(perConvo);
            const split = aggregateByProvider(perConvo, new Map(), '');
            const claudeHtml = renderProviderSection('Claude Code', split.claude, facet);
            const antigravityHtml = renderProviderSection('Antigravity', split.antigravity, []);
            const combinedHtml = claudeHtml + antigravityHtml;

            // Both sides have real data in this fixture — both sections must render.
            assert.ok(claudeHtml.includes('Claude Code'), 'the Claude section renders when it has data');
            assert.ok(antigravityHtml.includes('Antigravity'), 'the Antigravity section renders when it has data');

            // The rollup row must actually be present (not silently dropped —
            // which would make the "no 175" check below pass for the wrong
            // reason), and its call count must render as an em dash, never
            // as the real (dishonest) entry count.
            assert.ok(claudeHtml.includes('well.j@honestdocs.co'),
                'the rollup account row renders in the Claude section, not silently dropped');
            assert.ok(!combinedHtml.includes('175'),
                'the rollup call count (175 raw entries) must never render as a number anywhere');

            // Targets the CALLS CELL, not the document.
            //
            // An earlier revision of this assertion was `claudeHtml.includes('—')`,
            // which could not fail: ROLLUP_NOTE itself ('day rollup — thinking not
            // broken out') contains U+2014 and is emitted into two title="…"
            // attributes, so the check passed whatever the cell rendered — "175
            // calls", or nothing at all. This requires the em dash to be the
            // content of the muted calls span itself.
            assert.ok(/<span class="up-acct-calls up-muted"[^>]*>—<\/span>/.test(claudeHtml),
                'the rollup row\'s CALLS CELL is an em dash — not merely an em dash somewhere in a tooltip');

            // Exactly two provider token totals — one per section — never a
            // combined third figure summing both providers.
            const tokenCellCount = (combinedHtml.match(/up-provider-tokens/g) || []).length;
            assert.strictEqual(tokenCellCount, 2,
                'exactly two provider token totals render — one per provider, never a combined third');

            // ─── the provider HEADER's own count ───
            //
            // stats.totalCalls counts raw entries with no rollup awareness, so a
            // provider whose data includes the archive would print "176 calls" in
            // its header — the same lie the account row above suppresses, one level
            // up. renderProviderSection shows an account count instead whenever a
            // facet exists. Asserted POSITIVELY (the account count is present) and
            // NEGATIVELY (the header's calls element carries no "N calls" figure at
            // all): the previous `!includes('175')` check did not constrain the
            // header, so reverting that behaviour left every assertion green.
            const providerCallsCells = (html: string) =>
                [...html.matchAll(/<span class="up-provider-calls">([^<]*)<\/span>/g)].map(m => m[1]);

            const claudeHeaderCells = providerCallsCells(claudeHtml);
            assert.deepStrictEqual(claudeHeaderCells, ['2 accounts'],
                'the Claude header reports its ACCOUNT count (2 here: the stamped account and the archive)');
            assert.ok(!/\d[\d,]*\s*calls/.test(claudeHeaderCells.join(' ')),
                'the Claude header shows no call-count figure at all — it cannot honestly total one over a rollup');

            // Antigravity has no facet and no rollup risk, so its header keeps the
            // real count. Asserted so the fix above cannot be over-applied into
            // suppressing an honest number.
            assert.deepStrictEqual(providerCallsCells(antigravityHtml), ['2 calls'],
                'the Antigravity header keeps its real call count — the suppression is rollup-specific');

            console.log('provider sections: all checks passed');

            // ─── the provider region can never render blank ───
            //
            // The regression this pins: the ledger used to be smuggled to the panel
            // on DeepUsageStats.perConvo/.titleMap, which StatsCache.write stripped
            // before persisting — so every stats object that came back from the disk
            // cache (a memory-cache hit, or a refresh skipped because another window
            // held the process lock) reached the panel without it. The split then came
            // back all-zero, both sections returned '', and the panel's entire
            // headline rendered as 0 bytes while the same stats object carried 15.6B
            // tokens. No error, no fallback.
            {
                const stats = aggregateFromPerConvo(perConvo, new Map(), '');

                // The shape cache.read() returns: a plain stats object with no
                // ledger hanging off it. Pins the smuggling out of existence.
                assert.strictEqual((stats as any).perConvo, undefined,
                    'aggregateFromPerConvo must not attach the raw ledger to its result — the panel is given ' +
                    'it explicitly (UsageStatsService.getCurrentLedger), because a stats object that came back ' +
                    'from the disk cache would not have carried one');
                assert.strictEqual((stats as any).titleMap, undefined,
                    'same for titleMap — see above');

                // With the ledger supplied, the region renders both sections.
                const region = renderProviderRegion(stats, split.claude, split.antigravity, facet);
                assert.ok(region.length > 0, 'the provider region is non-empty for a cache.read()-shaped stats object');
                assert.ok(region.includes('Claude Code') && region.includes('Antigravity'),
                    'both sections render from the explicitly-supplied ledger');

                // With an EMPTY ledger — the defect's exact shape — the region must
                // still say something. A blank headline is not acceptable output.
                const emptySplit = aggregateByProvider({} as any, new Map(), '');
                const fallback = renderProviderRegion(stats, emptySplit.claude, emptySplit.antigravity, []);
                assert.ok(fallback.length > 0,
                    'an empty ledger against a stats object with real totals must render a fallback, not 0 bytes');
                assert.ok(/unavailable/i.test(fallback),
                    'the fallback names what is missing rather than rendering an empty block');
                // ...and still no summed cross-provider figure, which is the whole
                // reason this region exists.
                assert.ok(!fallback.includes(fmtBig(stats.totalTokens)),
                    'the fallback substitutes no combined total — a summed headline describes neither tool');
                assert.ok(!/\d/.test(fallback.replace(/<[^>]*>/g, '')),
                    'the fallback renders no figure at all in text position');

                // Genuinely no data anywhere: rendering nothing is correct, and the
                // dashboard\'s own empty states take over.
                const zeroStats = aggregateFromPerConvo({} as any, new Map(), '');
                assert.strictEqual(
                    renderProviderRegion(zeroStats, emptySplit.claude, emptySplit.antigravity, []), '',
                    'an empty ledger AND empty stats renders nothing — the fallback is not a permanent banner');

                console.log('provider region never blanks: all checks passed');
            }

            // ─── cost cell: CHARACTERISATION of pre-existing behaviour ───
            //
            // These three assertions do NOT test work done by this task.
            // renderCostEstimate already suppressed unresolved models (its
            // MODEL_UNKNOWN_* skip) and sub-$0.01 rows before this task began, and
            // was not modified by it — so these could never have gone RED here.
            // They are regression guards on the "never $0.00" honesty requirement,
            // kept because that requirement is load-bearing for this panel, and
            // recorded as characterisation so nobody reads them as evidence the
            // suppression was implemented here.
            //
            // Accepted divergence from the brief: the brief asked for the unresolved
            // model to render "tokens and calls with the cost cell blank". The
            // existing code drops the whole ROW instead. Left as is (out of scope),
            // and asserted as row-suppression below so the divergence is explicit
            // rather than unexamined.
            const unknownName = modelNameFromEnum(87231);
            const pricedModel = {
                displayName: 'Claude Opus 5', rawModel: 'claude-opus-5',
                input: 10_000_000, output: 2_000_000, cache: 0, cacheWrite: 0, reasoning: 0, calls: 5,
            };
            const unpricedModel = {
                displayName: unknownName, rawModel: unknownName,
                input: 5_000_000, output: 500_000, cache: 0, cacheWrite: 0, reasoning: 0, calls: 3,
            };
            const costHtml = renderCostEstimate([pricedModel, unpricedModel]);

            assert.ok(/\$\d/.test(costHtml), 'the priced model still renders a real dollar figure');
            assert.ok(!costHtml.includes(unknownName),
                'the unresolved model is suppressed from the cost table entirely, not rendered with a guessed price');
            assert.ok(!costHtml.includes('$0.00'),
                'the string $0.00 never appears — a resolved-but-cheap or unresolved model is blank, never "free"');

            console.log('cost cell honesty: all checks passed');
        }

        // ─── I3 + I5 + I7: the panel-level findings ───
        {
            const { renderProviderSection: renderSectionP, renderProviderRegion: renderRegionP } =
                require('../../shared/usage-components');
            const { aggregateFromPerConvo: aggP, allTimeProviderSplit } = require('./aggregator');
            const { claudeCascadeLabel } = require('./convoId');

            const entP = (rid: string, ts: string, out: number) => ({
                responseId: rid, source: 'metadata', inp: 10, out, cache: 0,
                cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8', provider: 'anthropic', ts,
            });
            const ledgerP: any = {
                'claude:aaaaaaaa-1111-2222-3333-444444444444': { entries: [entP('p1', '2026-08-01T10:00:00.000Z', 5000)] },
                'claude:bbbbbbbb-1111-2222-3333-444444444444:agent-a32b63bdc31fc263a': { entries: [entP('p2', '2026-08-01T11:00:00.000Z', 4000)] },
                [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [entP('p3', '2026-02-01T11:00:00.000Z', 3000)] },
                '00b78c15-c64b-490f-8dec-7187d9e8c06a': { entries: [{
                    responseId: 'g1', source: 'metadata', inp: 5, out: 5, cache: 0, cacheWrite: 0,
                    reasoning: 0, model: 'MODEL_PLACEHOLDER_M20', provider: 'API_PROVIDER_GOOGLE_GEMINI',
                    ts: '2026-08-01T12:00:00.000Z',
                }] },
            };

            // ─── I3: the provider region says which window it covers ───
            //
            // The region is deliberately all-time while the range bar renders
            // immediately below it and filters every other card, so selecting
            // "24h" left a lifetime total on top of a one-day dashboard with
            // nothing to distinguish the two scopes. The old hero honoured the
            // range. The fix is the label, not threading the range through.
            const splitP = allTimeProviderSplit(ledgerP, new Map());
            const regionP = renderRegionP(aggP(ledgerP, new Map(), ''), splitP.claude, splitP.antigravity, []);
            const scopeCells = [...regionP.matchAll(/<span class="up-provider-scope">([^<]*)<\/span>/g)].map((m: any) => m[1]);
            assert.deepStrictEqual(scopeCells, ['all time', 'all time'],
                'I3: BOTH provider headers name their window ("all time"), so the region cannot be read as the ' +
                'range the bar below it is set to');
            assert.ok(!renderSectionP('Claude Code', splitP.claude, []).includes('up-provider-scope'),
                'I3: the label is the caller\'s claim about its own scope, not a decoration renderProviderSection ' +
                'invents — a caller that ever does filter by range must not be made to lie');

            // ─── I5: Claude cascades are distinguishable in the list ───
            //
            // Claude conversations have no titleMap entry and no Antigravity
            // brain directory, so all of them rendered as the same
            // "Conversation" placeholder — measured at 18 of the
            // Conversations card's 20 visible rows, which being sorted by
            // token volume displaced every named Antigravity conversation into
            // the collapsed overflow. Excluding Claude ids from the card was
            // rejected: that hides real usage.
            const titlesP = new Map<string, string>(
                aggP(ledgerP, new Map(), '').cascades.map((c: any) => [c.id, c.title]),
            );
            assert.strictEqual(titlesP.get('claude:aaaaaaaa-1111-2222-3333-444444444444'), 'Claude session aaaaaaaa',
                'I5: a Claude session row is labelled from its ledger key — no filesystem, no transcript content ' +
                '(spec §16), and no dependence on a persisted title map');
            assert.strictEqual(
                titlesP.get('claude:bbbbbbbb-1111-2222-3333-444444444444:agent-a32b63bdc31fc263a'),
                'Claude subagent bbbbbbbb/a32b63bd',
                'I5: a subagent row names both its parent session and its own agent id, with the shared "agent-" ' +
                'prefix stripped before truncation — otherwise every subagent row would read identically');
            assert.strictEqual(titlesP.get(LEGACY_CLAUDE_ARCHIVE_ID), 'Claude Code (imported archive)',
                'I5: the archive says what it is');
            const claudeTitlesP = [...titlesP.entries()].filter(([id]: any) => isClaudeConvo(id));
            assert.strictEqual(claudeTitlesP.length, 3, 'sanity: all three Claude rows are in the card');
            assert.ok(new Set(claudeTitlesP.map(([, t]: any) => t)).size === 3,
                'I5: the three Claude rows are DISTINGUISHABLE from each other, not three copies of one placeholder');
            claudeTitlesP.forEach(([, t]: any) => {
                assert.ok(/^Claude/.test(t), `I5: the provider is marked on the row (${t})`);
                assert.notStrictEqual(t, 'Conversation', 'I5: no Claude row falls back to the bare placeholder');
            });
            // The Antigravity resolvers are untouched: an untitled Antigravity
            // conversation still lands on its own placeholder, so this fix is
            // not quietly relabelling the other provider.
            assert.strictEqual(titlesP.get('00b78c15-c64b-490f-8dec-7187d9e8c06a'), 'Conversation',
                'I5: the Antigravity title path is unchanged — the Claude branch is additive, not a replacement');
            assert.strictEqual(claudeCascadeLabel('claude:short'), 'Claude session short',
                'I5: a session id shorter than the truncation length is left intact');

            // ─── I7: the all-time split is memoized on ledger identity ───
            //
            // Measured at 83 ms on the combined ledger, recomputed on every
            // range and year-selector click even though the split is all-time
            // and cannot change. ~800 ms per click at 10x the corpus.
            assert.strictEqual(allTimeProviderSplit(ledgerP, new Map()) === splitP, false,
                'I7: a DIFFERENT titleMap identity misses the memo — a title refresh over an unchanged ledger must ' +
                'not be served a stale split');
            const titleMapP = new Map<string, string>();
            const firstP = allTimeProviderSplit(ledgerP, titleMapP);
            assert.strictEqual(allTimeProviderSplit(ledgerP, titleMapP), firstP,
                'I7: the same ledger and titleMap return the IDENTICAL object — the panel\'s re-renders (range and ' +
                'year clicks) no longer re-aggregate the whole ledger');
            assert.notStrictEqual(allTimeProviderSplit({ ...ledgerP }, titleMapP), firstP,
                'I7: a new ledger object misses the memo, so fresh data is never served stale — every refresh path ' +
                'builds a new merged object before writing it');
            assert.strictEqual(firstP.claude.totalCalls, 3, 'I7: the memoized value is the real split, not a stub');

            console.log('provider region scope, claude cascade labels, split memo: all checks passed');
        }

        // ─── I4: "Conversations read" counts the Antigravity store only ───
        {
            const { UsageStatsService: UsageStatsServiceI4, antigravityCount } = require('./index');
            const { StatsCache: StatsCacheI4 } = require('./cache');
            const osI4 = require('os'); const fsI4 = require('fs'); const pathI4 = require('path');

            // The shared definition both refresh paths use. Asserted directly
            // because the server-mode site lives inside incrementalRefresh,
            // which cannot be driven without a reachable language server.
            assert.strictEqual(
                antigravityCount(['a-convo', 'claude:sess-1', LEGACY_CLAUDE_ARCHIVE_ID, 'b-convo']), 2,
                'I4: only Antigravity ids count — both Claude id shapes (the claude: prefix and the legacy archive ' +
                'key) are excluded');

            const conversationsI4 = listConversations();
            if (conversationsI4.length === 0) {
                console.log('health conversation count: SKIPPED — no Antigravity conversations on this machine');
            } else {
                const tmpI4 = pathI4.join(osI4.tmpdir(), `ag-switchboard-selfcheck-i4-${Date.now()}.json`);
                class TestCacheI4 extends StatsCacheI4 { get filePath() { return tmpI4; } }
                const cacheI4 = new TestCacheI4();

                // Every real conversation seeded as already-read, plus Claude
                // ids in the same ledger — the shape the shared-ledger design
                // now produces on every machine.
                const perConvoI4: Record<string, unknown> = {};
                const mtimesI4: Record<string, number> = {};
                for (const c of conversationsI4) {
                    perConvoI4[c.id] = { entries: [mk(`seed-${c.id}`, '2020-01-01T00:00:00.000Z')] };
                    mtimesI4[c.id] = c.mtimeMs + 1;
                }
                const claudeIdsI4 = ['claude:i4-aaaa', 'claude:i4-bbbb', LEGACY_CLAUDE_ARCHIVE_ID];
                for (const id of claudeIdsI4) {
                    perConvoI4[id] = { entries: [mk(`seed-${id}`, '2020-01-02T00:00:00.000Z')] };
                }
                cacheI4.write(perConvoI4, Object.keys(perConvoI4),
                    aggregateFromPerConvo(perConvoI4 as any, new Map()), new Map(),
                    undefined, undefined, mtimesI4, '2026-08-01T00:00:00.000Z');

                // One real conversation forced dirty so this is the FULL
                // refreshFromStore body (the site of the count), not the
                // dirty:0 early return, which counts listConversations()
                // directly and was never wrong.
                const diskI4 = cacheI4.read();
                diskI4.mtimes[conversationsI4[0].id] = conversationsI4[0].mtimeMs - 1;

                const svcI4 = new UsageStatsServiceI4();
                svcI4.cache = cacheI4;
                const original = console.warn;
                console.warn = () => { /* expected: ECONNREFUSED from the deliberately closed port */ };
                try {
                    await svcI4.refreshFromStore({ port: 59998, csrfToken: 'fake', protocol: 'http' }, diskI4);
                } finally { console.warn = original; }

                const persistedI4 = cacheI4.read();
                assert.strictEqual(
                    Object.keys(persistedI4.perConvo).filter(isClaudeConvo).length, claudeIdsI4.length,
                    'sanity: the Claude ids really are in the merged ledger this pass counted from — otherwise the ' +
                    'assertion below would pass for the wrong reason');
                assert.ok(svcI4.lastHealth, 'sanity: a full pass populates health');
                assert.strictEqual(svcI4.lastHealth.conversations, conversationsI4.length,
                    'I4: "Conversations read" reports the ANTIGRAVITY conversation count, not the ledger size. This ' +
                    'is the card that tells the user how far to trust every other number on the dashboard; with ' +
                    `${claudeIdsI4.length} Claude ids folded into the same ledger it over-reported by that much ` +
                    '(measured 351 against a store holding 138)');

                fsI4.unlinkSync(tmpI4);
                console.log(`health conversation count: all checks passed (${conversationsI4.length} antigravity, ${claudeIdsI4.length} claude ids ignored)`);
            }
        }

        // ═══ V1–V5: the three on-disk cases are THREE, not two ═══
        //
        // The refusal introduced in ba2ea92 made write-refusal a property of
        // StatsCache — correct, and not weakened here. But it classified a v1
        // (or version-absent) file as 'unreadable' along with genuinely
        // undecodable ones, so for a user holding a v1 file every write was
        // refused FOREVER: read() returned null every pass, loadSync never
        // returned stats, and the whole Claude-tracking feature was silently
        // off, recoverable only by finding an output-channel warning and
        // hand-deleting a dotfile.
        //
        // The three states are structurally distinct:
        //
        //   truncated / invalid JSON / missing top-level field
        //     → contents UNKNOWN, could hold the archive        → refuse all writes
        //   schemaVersion ABOVE CACHE_SCHEMA_VERSION
        //     → written by a NEWER build, clobbering loses data → refuse all writes
        //   schemaVersion BELOW it with no migration (v1/absent)
        //     → known, superseded, provably archive-free        → preserve, then rebuild
        //
        // "Provably" is a historical fact, not a judgement: schemaVersion did
        // not exist before 9da46be (2026-05-04), which introduced it as `2`
        // together with the reasoning/cacheWrite metrics, and the archive was
        // hand-imported in August 2026 into a file that was already v2. A
        // v1-format file holding claude-code-imported is impossible.
        //
        // Every fixture below is a temp file behind a filePath-overriding
        // subclass. Nothing in this block ever touches the real
        // ~/.gemini/antigravity/brain/.deep_stats_cache.json.
        {
            const fsV = require('fs'); const pathV = require('path'); const osV = require('os');
            const { StatsCache: StatsCacheV } = require('./cache');

            const dirV = fsV.mkdtempSync(pathV.join(osV.tmpdir(), `ag-switchboard-selfcheck-schema-${Date.now()}-`));

            // Un-regenerable-looking archive content, so "byte-identical" below
            // is a statement about the archive and not about an empty file.
            const archiveEntryV = {
                ts: '2026-03-03T00:00:00.000Z', model: 'archived', provider: 'claude',
                responseId: 'cc-archive-v', source: 'metadata',
                inp: 12345678, out: 87654321, cache: 0, cacheWrite: 0, reasoning: 0,
            };
            const fixtureV = (schemaVersion: number | null) => JSON.stringify({
                ...(schemaVersion === null ? {} : { schemaVersion }),
                perConvo: { [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [archiveEntryV] } },
                fetchedIds: [LEGACY_CLAUDE_ARCHIVE_ID],
                stats: { totalCalls: 1 },
                updatedAt: '2026-09-06T00:00:00.000Z',
            });

            const seedV = (name: string, content: string) => {
                const p = pathV.join(dirV, `${name}.json`);
                fsV.writeFileSync(p, content, 'utf-8');
                return p;
            };
            const cacheAtV = (p: string) => {
                class C extends StatsCacheV { get filePath() { return p; } }
                return new C();
            };
            const copiesOfV = (p: string): string[] => {
                const stem = pathV.basename(p).replace(/\.json$/, '') + '.rejected-';
                return fsV.readdirSync(pathV.dirname(p))
                    .filter((f: string) => f.startsWith(stem))
                    .map((f: string) => pathV.join(pathV.dirname(p), f));
            };
            const rebuiltV: any = { 'some-antigravity-convo': { entries: [
                { ts: '2026-09-01T00:00:00.000Z', model: 'm', provider: 'x', responseId: 'r-rebuild-v', source: 'metadata', inp: 1, out: 1, cache: 0, cacheWrite: 0, reasoning: 0 },
            ] } };
            const writeRebuiltV = (c: any): boolean => {
                const original = console.warn;
                console.warn = () => { /* expected: the refusal / preservation WARNs under test */ };
                try { return c.write(rebuiltV, ['some-antigravity-convo'], aggregateFromPerConvo(rebuiltV, new Map()), new Map()); }
                finally { console.warn = original; }
            };

            // ─── V1: a v1 file is 'stale' and REBUILDS. The regression assertion. ───
            // Fails on pre-fix code at the very first assertion: probe() said
            // 'unreadable', write() refused, and the file stayed v1 forever.
            {
                const p = seedV('v1', fixtureV(1));
                const c = cacheAtV(p);

                assert.strictEqual(c.probe(), 'stale',
                    'V1: a v1 file probes STALE — a known, superseded, provably archive-free schema, NOT the ' +
                    '"contents unknown" state that must refuse writes. Pre-fix this was \'unreadable\', which ' +
                    'refused every write forever and switched Claude tracking off with no in-app recovery');

                const original = console.warn;
                console.warn = () => { /* expected: the preservation WARN */ };
                let readBack;
                try { readBack = c.read(); } finally { console.warn = original; }
                assert.strictEqual(readBack, null,
                    'V1: read() still returns null on a stale file, so the cold-boot path rebuilds — unchanged behaviour');

                const afterRead = copiesOfV(p);
                assert.strictEqual(afterRead.length, 1,
                    'V1: read() preserved a copy BEFORE any write could touch the file — the copy is taken first, ' +
                    'not raced by the rebuild');
                assert.strictEqual(fsV.readFileSync(afterRead[0], 'utf-8'), fixtureV(1),
                    'V1: the preserved copy is byte-identical to the v1 file it replaced');

                assert.strictEqual(writeRebuiltV(c), true,
                    'V1: write() SUCCEEDS on a stale file once the copy is safe. This is the regression: without it ' +
                    'the v1 user gets read()===null, write()===refused, loadSync()===null and refreshClaudeUsage ' +
                    'bailing, every pass, permanently');

                const persisted = JSON.parse(fsV.readFileSync(p, 'utf-8'));
                assert.strictEqual(persisted.schemaVersion, CACHE_SCHEMA_VERSION,
                    'V1: the file on disk is now at the current schema version — the rebuild actually landed');
                assert.ok(persisted.perConvo['some-antigravity-convo'],
                    'V1: ...carrying the newly written content, not the superseded v1 payload');

                // Idempotence: the file is 'ok' now, so nothing further can
                // trigger a copy. A stale classification must not mean "copy on
                // every write" — that is how 1.3 MB files accumulate.
                assert.strictEqual(c.probe(), 'ok', 'V1: the rebuilt file probes ok, so the stale branch is not re-entered');
                assert.strictEqual(writeRebuiltV(c), true, 'V1: subsequent writes are ordinary successes');
                assert.strictEqual(copiesOfV(p).length, 1,
                    'V1: still exactly ONE preserved copy after two further writes — the stale path copies once, ' +
                    'not once per write');

                for (const f of copiesOfV(p)) fsV.unlinkSync(f);
                fsV.unlinkSync(p);
            }

            // ─── V2: a version-ABSENT file behaves identically to v1 ───
            // Same known-superseded case (schemaVersion predates the field).
            {
                const p = seedV('vnone', fixtureV(null));
                const c = cacheAtV(p);
                assert.strictEqual(c.probe(), 'stale',
                    'V2: a file with NO schemaVersion at all is the same known-superseded case as v1 — the field ' +
                    'did not exist before 9da46be, so its absence dates the file, it does not make it unknown');
                assert.strictEqual(writeRebuiltV(c), true, 'V2: ...and it rebuilds too');
                for (const f of copiesOfV(p)) fsV.unlinkSync(f);
                fsV.unlinkSync(p);
            }

            // ─── V3: a stale file whose preservation copy FAILS still refuses ───
            //
            // This is the exact condition the earlier implementer declined the
            // fix over ("letting the rebuild proceed once a backup succeeded
            // would restore the exact hole for the case where copyFileSync
            // fails"). Gating on the copy SUCCEEDING is what closes it — so
            // prove it holds.
            //
            // fs.copyFileSync is stubbed to throw rather than using an
            // unwritable directory, deliberately: an unwritable directory
            // would also break write()'s own writeFileSync, so the assertion
            // would pass even with the gate removed. Here the directory is
            // fully writable and the write WOULD have succeeded — the refusal
            // can only come from the gate. Remove `&& !this.preserveRejected()`
            // from write() and this section fails.
            {
                const p = seedV('v1-copyfail', fixtureV(1));
                const c = cacheAtV(p);
                assert.strictEqual(c.probe(), 'stale', 'sanity: the fixture is the stale case');

                const realCopy = fsV.copyFileSync;
                const originalWarn = console.warn;
                let wrote;
                fsV.copyFileSync = () => { const e: any = new Error('stubbed copy failure'); e.code = 'EACCES'; throw e; };
                console.warn = () => { /* expected: the copy-failed + refusal WARNs */ };
                try {
                    wrote = c.write(rebuiltV, ['some-antigravity-convo'], aggregateFromPerConvo(rebuiltV, new Map()), new Map());
                } finally {
                    fsV.copyFileSync = realCopy;
                    console.warn = originalWarn;
                }

                assert.strictEqual(wrote, false,
                    'V3: write() REFUSES a stale rebuild when the preservation copy failed. A failed copy makes the ' +
                    'rebuild unrecoverable, so the permission to rebuild is conditional on the copy, not on the ' +
                    'classification');
                assert.strictEqual(fsV.readFileSync(p, 'utf-8'), fixtureV(1),
                    'V3: the original file is BYTE-IDENTICAL — nothing was overwritten on the way to refusing');
                assert.strictEqual(copiesOfV(p).length, 0, 'V3: sanity — the copy genuinely did not happen');

                // And it keeps refusing on later passes, rather than the
                // per-instance backupTaken flag being mistaken for success.
                let wroteAgain;
                fsV.copyFileSync = () => { const e: any = new Error('stubbed copy failure'); e.code = 'EACCES'; throw e; };
                console.warn = () => { /* expected */ };
                try {
                    wroteAgain = c.write(rebuiltV, ['some-antigravity-convo'], aggregateFromPerConvo(rebuiltV, new Map()), new Map());
                } finally {
                    fsV.copyFileSync = realCopy;
                    console.warn = originalWarn;
                }
                assert.strictEqual(wroteAgain, false,
                    'V3: a SECOND pass on the same instance still refuses — "an attempt was made" must not read as ' +
                    '"a copy exists", or the second write would sail through on a failed backup');
                assert.strictEqual(fsV.readFileSync(p, 'utf-8'), fixtureV(1), 'V3: still byte-identical');

                fsV.unlinkSync(p);
            }

            // ─── V4: the three genuine refusal states are UNCHANGED ───
            // The archive guarantee. Each fixture carries
            // LEGACY_CLAUDE_ARCHIVE_ID, so "byte-identical" is the archive
            // surviving, not an empty file surviving.
            {
                const refusals: Array<[string, string, string]> = [
                    ['trunc', fixtureV(3).slice(0, 40),
                        'a truncated file: contents UNKNOWN — the tail that is missing could have held anything'],
                    ['nofield', JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, fetchedIds: [], stats: {} }),
                        'a missing top-level field: structurally undecodable, contents UNKNOWN'],
                    ['v99', fixtureV(99),
                        'a schemaVersion ABOVE this build\'s: written by a NEWER build, whose data this build cannot ' +
                        'interpret and must not clobber'],
                ];
                for (const [name, content, why] of refusals) {
                    const p = seedV(name, content);
                    const c = cacheAtV(p);
                    assert.strictEqual(c.probe(), 'unreadable',
                        `V4/${name}: still probes UNREADABLE — ${why}. Reclassifying v1 must not drag any of these ` +
                        'across with it');
                    assert.strictEqual(writeRebuiltV(c), false,
                        `V4/${name}: write() still refuses — the archive guarantee`);
                    assert.strictEqual(fsV.readFileSync(p, 'utf-8'), content,
                        `V4/${name}: the file is BYTE-IDENTICAL after a refused write. On a real machine this file ` +
                        'holds claude-code-imported — 175 entries, 12,942,976,240 tokens, hand-imported, with no ' +
                        'source files anywhere');
                    for (const f of copiesOfV(p)) fsV.unlinkSync(f);
                    fsV.unlinkSync(p);
                }
            }

            // ─── V5: write() reports refusal vs success, and copies do not accumulate ───
            {
                // Return value on the two permitting states.
                const pAbsent = pathV.join(dirV, 'absent.json');
                assert.ok(!fsV.existsSync(pAbsent), 'sanity: a genuinely absent file');
                const cAbsent = cacheAtV(pAbsent);
                assert.strictEqual(writeRebuiltV(cAbsent), true,
                    'V5: write() returns TRUE on a completed write (absent file). Pre-fix it returned void, so ' +
                    'refreshFromStore and twoPhaseFullFetch could not tell refusal from success and published a ' +
                    'rebuilt, archive-less ledger into the panel off a write that never landed');
                assert.strictEqual(cAbsent.probe(), 'ok', 'sanity: ...and the file now decodes');
                assert.strictEqual(writeRebuiltV(cAbsent), true, 'V5: TRUE again over an ok file');
                fsV.unlinkSync(pAbsent);

                // Return value on refusal, plus no accumulation across passes.
                // backupTaken is per-instance (per window per session), so
                // without the on-disk check every window launch over a
                // still-refused ~1.3 MB file dropped another copy beside it.
                const p = seedV('accum', fixtureV(99));
                assert.strictEqual(writeRebuiltV(cacheAtV(p)), false,
                    'V5: write() returns FALSE on a refusal');
                assert.strictEqual(copiesOfV(p).length, 1, 'V5: the first rejected pass preserves one copy');

                // The copy filename is a millisecond-resolution ISO stamp, so
                // two passes inside the same millisecond would collide onto one
                // filename and the count below would read 1 even with the
                // on-disk check removed — a silently unfailable assertion.
                // Separate the passes in time so the second pass would
                // genuinely produce a SECOND file if nothing stopped it.
                await new Promise((r) => setTimeout(r, 8));

                assert.strictEqual(writeRebuiltV(cacheAtV(p)), false,
                    'V5: a second, INDEPENDENT StatsCache instance over the same path also refuses');
                assert.strictEqual(copiesOfV(p).length, 1,
                    'V5: two successive rejected passes leave EXACTLY ONE .rejected-* file. Pre-fix the second ' +
                    'instance deposited another full-size copy, and so did every window launch after it');
                assert.strictEqual(fsV.readFileSync(p, 'utf-8'), fixtureV(99), 'V5: and the file is still untouched');
                for (const f of copiesOfV(p)) fsV.unlinkSync(f);
                fsV.unlinkSync(p);
            }

            fsV.rmSync(dirV, { recursive: true, force: true });
            console.log('schema classification (V1 stale rebuild, V3 failed-copy refusal, V4 three refusals, V5 write() return + no accumulation): all checks passed');
        }

        // ─── V6: the callers stop publishing state off a refused write ───
        //
        // The consequence Fix 2 exists for. refreshFromStore sets
        // this.deepStatsCache / this.currentPerConvo from `merged`, which on
        // the cold-boot path is built against an EMPTY base — so on a refusal
        // the panel showed a from-scratch, archive-less ledger while the real
        // file sat intact on disk. It looked like 12.94B tokens had been lost
        // when nothing was.
        //
        // Drives the REAL refreshFromStore (only cache.write is redirected to a
        // temp path); its title fetch fails harmlessly against a closed port.
        {
            const fsV6 = require('fs'); const pathV6 = require('path'); const osV6 = require('os');
            const { UsageStatsService: UsageStatsServiceV6 } = require('./index');
            const { StatsCache: StatsCacheV6 } = require('./cache');

            if (listConversations().length === 0) {
                console.log('refused-write publication guard: SKIPPED — no Antigravity conversations to rebuild from');
            } else {
                const pV6 = pathV6.join(osV6.tmpdir(), `ag-switchboard-selfcheck-v6-${Date.now()}.json`);
                const contentV6 = JSON.stringify({
                    schemaVersion: 99,
                    perConvo: { [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [
                        { ts: '2026-03-03T00:00:00.000Z', model: 'archived', provider: 'claude', responseId: 'cc-archive-v6', source: 'metadata', inp: 12345678, out: 87654321, cache: 0, cacheWrite: 0, reasoning: 0 },
                    ] } },
                    fetchedIds: [LEGACY_CLAUDE_ARCHIVE_ID],
                    stats: { totalCalls: 1 },
                    updatedAt: '2026-09-06T00:00:00.000Z',
                });
                fsV6.writeFileSync(pV6, contentV6, 'utf-8');

                class V99CacheV6 extends StatsCacheV6 { get filePath() { return pV6; } }
                const svcV6 = new UsageStatsServiceV6();
                svcV6.cache = new V99CacheV6();

                const originalWarn = console.warn;
                console.warn = () => { /* expected: ECONNREFUSED from the closed port, plus the refusal WARN */ };
                let returned;
                try {
                    returned = await svcV6.refreshFromStore({ port: 59997, csrfToken: 'fake', protocol: 'http' }, null);
                } finally { console.warn = originalWarn; }

                assert.strictEqual(returned, null,
                    'V6: refreshFromStore returns null when the cache refused the write — it did not "complete"');
                assert.strictEqual(svcV6.deepStatsCache, null,
                    'V6: this.deepStatsCache is NOT published off a refused write. Pre-fix it held the rebuilt, ' +
                    'archive-less ledger, so the panel reported the 12.94B-token archive as gone while the file on ' +
                    'disk was perfectly intact');
                assert.strictEqual(Object.keys(svcV6.currentPerConvo).length, 0,
                    'V6: ...and neither is this.currentPerConvo, which the next Claude pass would otherwise merge ' +
                    'against as if it were a real ledger');
                assert.strictEqual(fsV6.readFileSync(pV6, 'utf-8'), contentV6,
                    'V6: the rejected file is byte-identical — the underlying refusal is intact');

                const stemV6 = pathV6.basename(pV6).replace(/\.json$/, '') + '.rejected-';
                for (const f of fsV6.readdirSync(pathV6.dirname(pV6))) {
                    if (f.startsWith(stemV6)) fsV6.unlinkSync(pathV6.join(pathV6.dirname(pV6), f));
                }
                fsV6.unlinkSync(pV6);
                console.log('refused-write publication guard: all checks passed');
            }
        }

        // ─── V7: a v1 file recovers even with nothing else to write it ───
        //
        // The v1 user's recovery must not depend on the Antigravity path
        // happening to run. On a zero-Antigravity install refreshFromStore
        // returns early without writing and twoPhaseFullFetch never writes
        // either, so refreshClaudeUsage's own early exit is the last gate. It
        // is keyed on probe()==='unreadable' rather than on bare existence
        // precisely so a stale file does not strand that user forever — while
        // an 'unreadable' one still bails (pinned by section C3 above).
        {
            const fsV7 = require('fs'); const pathV7 = require('path'); const osV7 = require('os');
            const { UsageStatsService: UsageStatsServiceV7 } = require('./index');
            const { StatsCache: StatsCacheV7 } = require('./cache');

            const pV7 = pathV7.join(osV7.tmpdir(), `ag-switchboard-selfcheck-v7-${Date.now()}.json`);
            fsV7.writeFileSync(pV7, JSON.stringify({
                schemaVersion: 1,
                perConvo: { 'some-antigravity-convo': { entries: [] } },
                fetchedIds: ['some-antigravity-convo'],
                stats: { totalCalls: 0 },
                updatedAt: '2026-09-06T00:00:00.000Z',
            }), 'utf-8');

            class V1CacheV7 extends StatsCacheV7 { get filePath() { return pV7; } }
            const svcV7 = new UsageStatsServiceV7();
            svcV7.cache = new V1CacheV7();
            assert.strictEqual(svcV7.cache.probe(), 'stale', 'sanity: the fixture is the stale case');
            assert.strictEqual(Object.keys(svcV7.claudeMtimes).length, 0,
                'V7 non-vacuity: a fresh instance, so this pass is a genuine cold ingest (same as section A)');
            assert.ok(claudeKeysHoistA.length > 0,
                'V7 non-vacuity: this machine has Claude transcripts a cold pass ingests (proved in section A), so a ' +
                'true below is the rebuild landing, not an empty ingest');

            const originalWarn = console.warn;
            console.warn = () => { /* expected: the preservation WARN */ };
            let persistedV7;
            try { persistedV7 = await svcV7.refreshClaudeUsage(); } finally { console.warn = originalWarn; }

            assert.strictEqual(persistedV7, true,
                'V7: refreshClaudeUsage rebuilds over a stale file instead of bailing. Otherwise a zero-Antigravity ' +
                'install with a v1 cache stays stuck forever — nothing else on that install ever writes');
            const afterV7 = JSON.parse(fsV7.readFileSync(pV7, 'utf-8'));
            assert.strictEqual(afterV7.schemaVersion, CACHE_SCHEMA_VERSION, 'V7: the file is at the current schema now');
            assert.ok(Object.keys(afterV7.perConvo).filter(isClaudeConvo).length > 0,
                'V7: ...and Claude data actually landed in it');

            const stemV7 = pathV7.basename(pV7).replace(/\.json$/, '') + '.rejected-';
            for (const f of fsV7.readdirSync(pathV7.dirname(pV7))) {
                if (f.startsWith(stemV7)) fsV7.unlinkSync(pathV7.join(pathV7.dirname(pV7), f));
            }
            fsV7.unlinkSync(pV7);
            console.log('stale-cache recovery with no Antigravity writer: all checks passed');
        }
    })();
}

