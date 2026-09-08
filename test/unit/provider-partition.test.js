/**
 * aggregateByProvider — splitting one ledger into a Claude side and an
 * Antigravity side.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * aggregation over fixture entries, no I/O. Runs in CI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { aggregateByProvider } = require('../../out/services/usage/aggregator');

const entry = (rid, ts, provider, model) => ({
    responseId: rid, source: 'metadata', inp: 1, out: 10, cache: 100,
    cacheWrite: 5, reasoning: 4, model, provider, ts,
});
const PER_ENTRY = 1 + 10 + 100 + 5 + 4;

describe('the partition', () => {
    const perConvo = {
        'claude:sess-1': { entries: [entry('r1', '2026-08-01T10:00:00.000Z', 'anthropic', 'claude-opus-4-8')] },
        'claude-code-imported': { entries: [entry('cc-1', '2026-06-01T12:00:00.000Z', 'anthropic', 'claude-opus-4-7')] },
        '00b78c15-c64b-490f-8dec-7187d9e8c06a': {
            entries: [entry('g1', '2026-08-01T11:00:00.000Z', 'API_PROVIDER_GOOGLE_GEMINI', 'MODEL_PLACEHOLDER_M20')],
        },
    };
    const split = aggregateByProvider(perConvo, new Map(), '');

    test('a claude: session and the legacy archive both count as Claude', () => {
        assert.strictEqual(split.claude.totalCalls, 2);
        assert.strictEqual(split.claude.totalTokens, PER_ENTRY * 2);
    });

    test('a bare uuid is Antigravity', () => {
        assert.strictEqual(split.antigravity.totalCalls, 1);
        assert.strictEqual(split.antigravity.totalTokens, PER_ENTRY);
    });

    test('it is exhaustive and disjoint — nothing lost, nothing double-counted', () => {
        assert.strictEqual(split.claude.totalCalls + split.antigravity.totalCalls, 3);
    });

    test('an empty side is a zeroed stats object, not null', () => {
        const onlyClaude = aggregateByProvider({ 'claude:x': perConvo['claude:sess-1'] }, new Map(), '');
        assert.strictEqual(onlyClaude.antigravity.totalCalls, 0);
        assert.strictEqual(onlyClaude.antigravity.totalTokens, 0);
        assert.ok(Array.isArray(onlyClaude.antigravity.daily), 'zeroed side still has bucket arrays');
    });
});

describe('a responseId shared across providers counts on BOTH sides', () => {
    // PINNED behaviour, not a bug. responseId spaces are structurally disjoint
    // (cc-<model>-<date> / req_* for Claude, opaque base64 for Antigravity), so
    // a shared id would itself be a data bug. aggregateFromPerConvo dedupes
    // globally within ONE call, but aggregateByProvider makes a separate call
    // per side — so the duplicate surfaces instead of being silently absorbed.
    // This test exists to stop someone "fixing" that into a cross-provider dedupe.
    const dupSplit = aggregateByProvider({
        'claude:dup-sess': { entries: [entry('shared-rid', '2026-08-02T10:00:00.000Z', 'anthropic', 'claude-opus-4-8')] },
        '11111111-2222-3333-4444-555555555555': {
            entries: [entry('shared-rid', '2026-08-02T10:05:00.000Z', 'API_PROVIDER_GOOGLE_GEMINI', 'MODEL_PLACEHOLDER_M20')],
        },
    }, new Map(), '');

    test('the Claude side counts it', () => {
        assert.strictEqual(dupSplit.claude.totalCalls, 1);
    });

    test('the Antigravity side counts it too', () => {
        assert.strictEqual(dupSplit.antigravity.totalCalls, 1);
    });
});
