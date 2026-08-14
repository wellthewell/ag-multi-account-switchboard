/**
 * Shared types and constants for the usage stats pipeline.
 */

import { DeepUsageStats } from '../../types';

// ─── Constants ───

export const BATCH_CONCURRENCY = 50;      // max parallel API calls per chunk
export const HOT_THRESHOLD_MS = 48 * 3600 * 1000;  // "hot" if modified within 48h
export const FETCH_TIMEOUT_MS = 6000;     // per-call timeout for metadata/steps fetch
export const CACHE_SCHEMA_VERSION = 2;

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
}

/** Per-conversation cached data */
export interface ConvoTokenData {
    entries: TokenEntry[];
}

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
}

// ─── Shared Fingerprint ───

/** Canonical dedup fingerprint.
 *  Prefer responseId: metadata and steps often describe the same model call with
 *  slightly different timestamps. The token/timestamp fallback is only for API drift.
 */
export function entryFingerprint(e: TokenEntry): string {
    if (e.responseId) return `rid:${e.responseId}`;
    return `${e.inp}:${e.out}:${e.cache}:${e.cacheWrite}:${e.reasoning}:${e.ts?.substring(0, 23) || ''}`;
}

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
    models: Record<string, { tokens: number; inp: number; out: number; cache: number; cacheWrite: number; reas: number }>;
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
        const base = { stepCount: 0, cachedStepCount: 0, mtime: 1000, cachedMtime: 1000, hasEntries: true };

        // Unchanged conversation stays clean.
        assert.strictEqual(isConvoDirty(base), false, 'unchanged should be clean');

        // IDE session: LS reports more steps than we cached.
        assert.strictEqual(isConvoDirty({ ...base, stepCount: 5, cachedStepCount: 3 }), true, 'stepCount delta should be dirty');

        // CLI session: LS never lists it (stepCount stays 0) but the .db kept growing.
        assert.strictEqual(isConvoDirty({ ...base, mtime: 2000 }), true, 'mtime delta should be dirty');

        // The regression this gate exists for: fetched once mid-session, came back empty,
        // stepCount pinned at 0 forever. Pre-mtime cache → must be retried.
        assert.strictEqual(isConvoDirty({ ...base, cachedMtime: undefined, hasEntries: false }), true, 'blank pre-mtime convo should be retried');

        // ...but a pre-mtime convo that already has data must NOT re-fetch on upgrade,
        // otherwise the first refresh after install re-reads every conversation.
        assert.strictEqual(isConvoDirty({ ...base, cachedMtime: undefined, hasEntries: true }), false, 'populated pre-mtime convo should be left alone');

        // Blank convo already carrying an mtime: only dirty once the file actually moves.
        assert.strictEqual(isConvoDirty({ ...base, hasEntries: false }), false, 'blank convo with current mtime should be clean');

        console.log('isConvoDirty: all checks passed');

        // ─── gridMode: the window each range filter draws and counts ───
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { gridMode } = require('../../shared/helpers');
        const thu = new Date(2026, 7, 6);  // Thu 2026-08-06, local

        assert.deepStrictEqual(gridMode('all', thu), { kind: 'year' }, 'all time keeps the year grid');
        assert.deepStrictEqual(gridMode('24h', thu), { kind: 'hourly' }, '24h has no meaningful day grid');
        assert.deepStrictEqual(gridMode('today', thu), { kind: 'hourly' }, 'today has no meaningful day grid');

        // The whole point: N days means exactly N squares, ending today.
        const d7 = gridMode('7d', thu);
        assert.deepStrictEqual(d7, { kind: 'strip', from: '2026-07-31', to: '2026-08-06' }, '7d spans 7 days');
        assert.strictEqual(dayCount(d7), 7, '7d draws 7 squares');
        assert.strictEqual(dayCount(gridMode('30d', thu)), 30, '30d draws 30 squares');

        // Thu → back to Mon; this-month → back to the 1st.
        assert.deepStrictEqual(gridMode('this-week', thu), { kind: 'strip', from: '2026-08-03', to: '2026-08-06' }, 'this-week starts Monday');
        assert.deepStrictEqual(gridMode('this-month', thu), { kind: 'strip', from: '2026-08-01', to: '2026-08-06' }, 'this-month starts the 1st');
        assert.deepStrictEqual(gridMode('last-month', thu), { kind: 'strip', from: '2026-07-01', to: '2026-07-31' }, 'last-month is the whole prior month');

        // Sunday must count as the 7th day of a Mon-start week, not the 0th.
        assert.deepStrictEqual(gridMode('this-week', new Date(2026, 7, 9)), { kind: 'strip', from: '2026-08-03', to: '2026-08-09' }, 'Sunday closes the week');

        // The year grid silently drops days outside the selected year — a strip must not.
        assert.deepStrictEqual(gridMode('30d', new Date(2026, 0, 5)), { kind: 'strip', from: '2025-12-07', to: '2026-01-05' }, '30d crosses the year boundary');

        // Local dates, not UTC — a late-evening ICT timestamp must not roll to tomorrow.
        assert.strictEqual(gridMode('7d', new Date(2026, 7, 6, 23, 30)).to, '2026-08-06', 'late evening stays on today');

        console.log('gridMode: all checks passed');

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

        // ─── enum map ───
        const { modelNameFromEnum, providerNameFromEnum, isUnknownEnumName } =
            require('./store/enumMap');
        assert.strictEqual(modelNameFromEnum(1073), 'MODEL_PLACEHOLDER_M73', '1000 + N rule');
        assert.strictEqual(modelNameFromEnum(1026), 'MODEL_PLACEHOLDER_M26', '1000 + N rule, second sample');
        assert.strictEqual(modelNameFromEnum(4242), 'MODEL_UNKNOWN_4242', 'unknown enum is named, not guessed');
        assert.strictEqual(modelNameFromEnum(1000), 'MODEL_UNKNOWN_1000', 'range boundary 1000 is unknown');
        assert.strictEqual(modelNameFromEnum(2000), 'MODEL_UNKNOWN_2000', 'range boundary 2000 is unknown');
        assert.strictEqual(modelNameFromEnum(1266), 'MODEL_PLACEHOLDER_M266', 'M266 exists in production (verified real data)');
        const unknownModelName = modelNameFromEnum(4242);
        assert.ok(isUnknownEnumName(unknownModelName), 'unknown names are detectable');
        assert.ok(!isUnknownEnumName('MODEL_PLACEHOLDER_M73'), 'known names are not flagged');
        assert.strictEqual(modelNameFromEnum(4242, { 4242: 'MODEL_CLAUDE_9_OPUS' }), 'MODEL_CLAUDE_9_OPUS',
            'a learned pair beats the unknown fallback');
        assert.strictEqual(providerNameFromEnum(24), 'API_PROVIDER_GOOGLE_GEMINI', 'seeded provider');
        assert.strictEqual(providerNameFromEnum(26), 'API_PROVIDER_ANTHROPIC_VERTEX', 'seeded provider');
        assert.strictEqual(providerNameFromEnum(99), 'API_PROVIDER_UNKNOWN_99', 'unknown provider is named');
        const unknownProviderName = providerNameFromEnum(99);
        assert.ok(isUnknownEnumName(unknownProviderName), 'unknown provider names are detectable');

        // unknown models must not be priced
        const { calculateTotalCost } = require('../../shared/usage-components');
        const priced = calculateTotalCost([{ displayName: 'Claude Opus 4.8', input: 1e6, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 }]);
        assert.ok(priced > 0, 'a known model is priced');
        const unpriced = calculateTotalCost([{ displayName: unknownModelName, input: 1e6, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 }]);
        assert.strictEqual(unpriced, 0, 'an unknown model contributes no cost');
        console.log('enumMap: all checks passed');

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
    })();
}

/** Inclusive day count of a strip window — test helper. */
function dayCount(mode: { kind: string; from?: string; to?: string }): number {
    if (mode.kind !== 'strip') return 0;
    const from = new Date(mode.from + 'T00:00:00');
    const to = new Date(mode.to + 'T00:00:00');
    return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}
