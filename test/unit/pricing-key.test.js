/**
 * matchPricing is keyed by model id, not display label.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure, no
 * I/O, but it installs a global pricing resolver — every test here restores it,
 * or later assertions inherit the stub.
 *
 * Two separate hazards live in this file. First, the resolver must be handed
 * the model *id*: display labels are ours and change freely, ids are the
 * vendor's. Second, matchPricing's hardcoded fallback ends in a bare
 * `return pricing['sonnet']`, so an unrecognised model falls all the way
 * through and gets billed at Sonnet rates unless the caller skips it. There
 * were four such call sites, not the three the original sweep guarded — the
 * monthly path's pricingKey parameter is optional, so the un-migrated call
 * compiled clean under --strict.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const { aggregateFromPerConvo, getModelPricingKey } = require('../../out/services/usage/aggregator');
const uc = require('../../out/shared/usage-components');

afterEach(() => uc.setExternalPricingResolver(null));

const entry = (over) => ({
    responseId: 'R1', source: 'metadata', inp: 1000, out: 100, cache: 0, cacheWrite: 0, reasoning: 0,
    model: 'MODEL_PLACEHOLDER_M47', provider: 'API_PROVIDER_GOOGLE_GEMINI',
    ts: '2026-03-15T00:00:00.000Z', ...over,
});

describe('getModelPricingKey', () => {
    test('a mapped placeholder resolves to its id', () => {
        assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M47'), 'gemini-3-flash-c');
    });

    test('M26 is date-aware across the model cutover', () => {
        assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M26', '2026-01-01T00:00:00.000Z'), 'claude-opus-4-5-thinking');
        assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M26', '2026-08-01T00:00:00.000Z'), 'claude-opus-4-6-thinking');
    });

    test('an unmapped placeholder has no better key than itself', () => {
        assert.strictEqual(getModelPricingKey('MODEL_PLACEHOLDER_M266'), 'MODEL_PLACEHOLDER_M266');
    });
});

describe('the resolver is asked for the id first', () => {
    test('live pricing wins, and the id is tried before the label', () => {
        const seen = [];
        uc.setExternalPricingResolver((key) => {
            seen.push(key);
            return key === 'claude-fable-5' ? { input: 10, output: 50, cache: 1, reasoning: 50 } : null;
        });
        const p = uc.matchPricing('Fable 5', 'claude-fable-5');
        assert.strictEqual(p.input, 10);
        assert.strictEqual(p.output, 50);
        assert.strictEqual(seen[0], 'claude-fable-5', 'the id is tried FIRST, before the display label');
    });
});

describe('the monthly path is a fourth call site', () => {
    test('MonthlyBucket.cost comes from the resolver, not the keyword table', () => {
        // buildMonthlyBuckets computes the dollar figure printed above every bar
        // in the monthly chart. The stub rates are deliberately absurd (999 vs
        // the real 0.5/3 keyword-table rate for gemini-3-flash) so a reverted
        // fix shows up as a wildly different cost, not a coincidentally equal one.
        const seen = [];
        uc.setExternalPricingResolver((key) => {
            seen.push(key);
            return key === 'gemini-3-flash-c' ? { input: 999, output: 999, cache: 999, reasoning: 999 } : null;
        });
        const stats = aggregateFromPerConvo({ mconvo: { entries: [entry({ responseId: 'MONTHLY1' })] } }, new Map());

        assert.strictEqual(seen.length, 1, 'exactly one lookup for the single fixture model');
        assert.strictEqual(seen[0], 'gemini-3-flash-c', 'the monthly path asks for the id, not the label');

        const march = stats.monthly.find((mo) => mo.key === '2026-03');
        assert.ok(march, 'the fixture produced a March bucket');
        assert.ok(Math.abs(march.cost - 1.0989) < 1e-6, `resolver rate expected, got ${march.cost}`);
    });

    test('an unknown model contributes zero, not a Sonnet-rate guess', () => {
        // The reviewer's own repro: 1,000,000 in + 1,000,000 out on a model we
        // cannot identify. Unguarded this yields cost === 18 (Sonnet's $3/$15
        // per million) — a number that looks entirely plausible in the chart.
        const stats = aggregateFromPerConvo({
            uconvo: {
                entries: [entry({
                    responseId: 'UNKNOWN1', inp: 1_000_000, out: 1_000_000,
                    model: 'MODEL_UNKNOWN_9999', provider: 'API_PROVIDER_UNKNOWN_1',
                    ts: '2026-04-15T00:00:00.000Z',
                })],
            },
        }, new Map());
        const april = stats.monthly.find((mo) => mo.key === '2026-04');
        assert.ok(april, 'the fixture produced an April bucket');
        assert.strictEqual(april.cost, 0);
    });
});

describe('the empty state names the last activity instead of showing zeros', () => {
    test('it names the range and when activity last happened', () => {
        const empty = uc.renderEmptyRange('2026-08-06T09:20:30.000Z', 'Last 24 Hours');
        assert.ok(empty.includes('Last 24 Hours'));
        assert.match(empty, /Aug\s*6/);
    });

    test('no recorded activity at all still renders cleanly', () => {
        const never = uc.renderEmptyRange(null, 'All Time');
        assert.ok(never.length > 0);
        assert.ok(!never.includes('undefined'));
    });
});
