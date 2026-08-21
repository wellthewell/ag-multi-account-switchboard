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
    /** ISO date on which store-sourced counting began. Totals before and after are not comparable. */
    countingChangedAt?: string;
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

        // The health card's unknownModels list is built by scanning ModelBucket
        // .displayName with isUnknownEnumName. getModelDisplayName must not
        // humanize the unknown marker away, or an unrecognised model would
        // silently disappear from the card instead of being surfaced by it.
        const { getModelDisplayName } = require('./aggregator');
        const unknownDisplay = getModelDisplayName(unknownModelName, 'API_PROVIDER_GOOGLE_GEMINI', '2026-01-01T00:00:00.000Z');
        assert.ok(isUnknownEnumName(unknownDisplay), 'an unknown model display name is still detectable — this is what the health card scans for');
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

        // ─── ledger semantics ───
        const { mergeIntoLedger } = require('./cache');
        const e1 = { responseId: 'X', source: 'metadata', inp: 1, out: 1, cache: 0, cacheWrite: 0, reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z' };
        const existingLedger = {
            'claude-code-imported': { entries: [e1, e1] },     // synthetic, no file on disk
            'deleted-by-user':      { entries: [e1] },          // file removed since
            'still-present':        { entries: [e1] },
            'present-not-reread':   { entries: [e1, e1] },      // on disk, but not re-read this pass
        };
        const freshRead = { 'still-present': { entries: [e1, e1, e1] } };
        const present = new Set(['still-present', 'present-not-reread']);
        const ledger = mergeIntoLedger(existingLedger, freshRead, present);
        assert.strictEqual(ledger['claude-code-imported'].entries.length, 2,
            'a conversation with no backing file is preserved — 12.94B tokens depend on this');
        assert.strictEqual(ledger['deleted-by-user'].entries.length, 1, 'history survives deleting a conversation');
        assert.strictEqual(ledger['still-present'].entries.length, 3, 'a conversation present on disk is replaced by the fresh read');
        assert.strictEqual(ledger['present-not-reread'].entries.length, 2, 'a conversation on disk but not re-read this pass keeps what it had');
        const before = Object.values(existingLedger).reduce((n: number, v: any) => n + v.entries.length, 0);
        const after = Object.values(ledger).reduce((n: number, v: any) => n + v.entries.length, 0);
        assert.ok(after >= before, 'the ledger never shrinks');
        console.log('cache ledger: all checks passed');

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
    })();
}

/** Inclusive day count of a strip window — test helper. */
function dayCount(mode: { kind: string; from?: string; to?: string }): number {
    if (mode.kind !== 'strip') return 0;
    const from = new Date(mode.from + 'T00:00:00');
    const to = new Date(mode.to + 'T00:00:00');
    return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}
