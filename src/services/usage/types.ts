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
    })();
}

/** Inclusive day count of a strip window — test helper. */
function dayCount(mode: { kind: string; from?: string; to?: string }): number {
    if (mode.kind !== 'strip') return 0;
    const from = new Date(mode.from + 'T00:00:00');
    const to = new Date(mode.to + 'T00:00:00');
    return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}
