/**
 * The provider region's HTML-level honesty markers.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * string rendering over fixture ledgers, no I/O. Runs in CI.
 *
 * Every assertion here guards against the panel stating something it cannot
 * honestly know: a call count summed over a day-rollup, a cost for a model we
 * cannot identify, a combined figure that describes neither tool, or a blank
 * headline standing in for 15.6B tokens. Several are written to fail for the
 * RIGHT reason — an absence assertion ("no 175", "no $0.00") passes trivially
 * when nothing rendered at all, so each is paired with a positive check that
 * the row it is about actually appeared.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    accountFacetFor, renderProviderSection, renderProviderRegion, renderCostEstimate,
} = require('../../out/shared/usage-components');
const { aggregateByProvider, aggregateFromPerConvo } = require('../../out/services/usage/aggregator');
const { modelNameFromEnum } = require('../../out/services/usage/store/enumMap');
const { fmtBig } = require('../../out/shared/helpers');

const claudeEntry = (rid, ts, accountKey) => ({
    responseId: rid, source: 'metadata', inp: 1000, out: 200, cache: 0,
    cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8', provider: 'anthropic', ts, accountKey,
});
const antigravityEntry = (rid, ts) => ({
    responseId: rid, source: 'metadata', inp: 500, out: 50, cache: 0,
    cacheWrite: 0, reasoning: 0, model: 'MODEL_PLACEHOLDER_M20',
    provider: 'API_PROVIDER_GOOGLE_GEMINI', ts,
});

// The real archive's actual shape: one entry per model per day, 175 entries for
// six months of work. Built out in FULL rather than with a handful of stand-ins,
// so a regression that prints the raw entry count shows up as the literal digits
// "175" — not as an arbitrarily small number that passes by coincidence.
const rollupEntries = [];
for (let i = 0; i < 175; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const month = String(1 + Math.floor(i / 28)).padStart(2, '0');
    rollupEntries.push(claudeEntry(`cc-${i}`, `2026-${month}-${day}T12:00:00.000Z`));
}

const perConvo = {
    'claude:sess-1': { entries: [claudeEntry('r1', '2026-08-01T10:00:00.000Z', '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7')] },
    'claude-code-imported': { entries: rollupEntries },
    '00b78c15-c64b-490f-8dec-7187d9e8c06a': {
        entries: [
            antigravityEntry('g1', '2026-08-01T11:00:00.000Z'),
            antigravityEntry('g2', '2026-08-01T12:00:00.000Z'),
        ],
    },
};

const facet = accountFacetFor(perConvo);
const split = aggregateByProvider(perConvo, new Map(), '');
const claudeHtml = renderProviderSection('Claude Code', split.claude, facet);
const antigravityHtml = renderProviderSection('Antigravity', split.antigravity, []);
const combinedHtml = claudeHtml + antigravityHtml;

describe('the rollup row cannot state a call count', () => {
    test('both sections render — the fixture has real data on each side', () => {
        assert.ok(claudeHtml.includes('Claude Code'));
        assert.ok(antigravityHtml.includes('Antigravity'));
    });

    test('the rollup account row is present, not silently dropped', () => {
        // Without this, the "no 175" assertion below passes for the wrong reason.
        assert.ok(claudeHtml.includes('well.j@honestdocs.co'));
    });

    test('the raw entry count never renders as a number anywhere', () => {
        assert.ok(!combinedHtml.includes('175'));
    });

    test("the rollup row's CALLS CELL is itself an em dash", () => {
        // An earlier revision asserted only `claudeHtml.includes('—')`, which
        // could not fail: ROLLUP_NOTE ('day rollup — thinking not broken out')
        // contains U+2014 and is emitted into two title="…" attributes, so the
        // check passed whatever the cell rendered — "175 calls", or nothing.
        assert.match(claudeHtml, /<span class="up-acct-calls up-muted"[^>]*>—<\/span>/);
    });

    test('exactly two provider token totals render, never a combined third', () => {
        assert.strictEqual((combinedHtml.match(/up-provider-tokens/g) || []).length, 2);
    });
});

describe("the provider header's own count", () => {
    // stats.totalCalls counts raw entries with no rollup awareness, so a provider
    // whose data includes the archive would print "176 calls" in its header — the
    // same lie the account row suppresses, one level up.
    const providerCallsCells = (html) =>
        [...html.matchAll(/<span class="up-provider-calls">([^<]*)<\/span>/g)].map((m) => m[1]);

    test('the Claude header reports its ACCOUNT count', () => {
        assert.deepStrictEqual(providerCallsCells(claudeHtml), ['2 accounts'],
            '2 here: the stamped account and the archive');
    });

    test('the Claude header shows no call-count figure at all', () => {
        // The previous `!includes('175')` check did not constrain the header, so
        // reverting this behaviour left every assertion green.
        assert.ok(!/\d[\d,]*\s*calls/.test(providerCallsCells(claudeHtml).join(' ')));
    });

    test('Antigravity keeps its real count — the suppression is rollup-specific', () => {
        assert.deepStrictEqual(providerCallsCells(antigravityHtml), ['2 calls']);
    });
});

describe('the provider region can never render blank', () => {
    // The regression this pins: the ledger used to be smuggled to the panel on
    // DeepUsageStats.perConvo/.titleMap, which StatsCache.write stripped before
    // persisting — so every stats object that came back from the disk cache
    // reached the panel without it. The split came back all-zero, both sections
    // returned '', and the panel's entire headline rendered as 0 bytes while the
    // same stats object carried 15.6B tokens. No error, no fallback.
    const stats = aggregateFromPerConvo(perConvo, new Map(), '');
    const emptySplit = aggregateByProvider({}, new Map(), '');

    test('the ledger is not attached to the stats object', () => {
        assert.strictEqual(stats.perConvo, undefined,
            'the panel is given the ledger explicitly (getCurrentLedger) — a cache.read()-shaped object carries none');
        assert.strictEqual(stats.titleMap, undefined);
    });

    test('with the ledger supplied, both sections render', () => {
        const region = renderProviderRegion(stats, split.claude, split.antigravity, facet);
        assert.ok(region.length > 0);
        assert.ok(region.includes('Claude Code') && region.includes('Antigravity'));
    });

    describe('with an EMPTY ledger against real totals — the defect exactly', () => {
        const fallback = renderProviderRegion(stats, emptySplit.claude, emptySplit.antigravity, []);

        test('it renders a fallback, not 0 bytes', () => {
            assert.ok(fallback.length > 0);
            assert.match(fallback, /unavailable/i, 'it names what is missing');
        });

        test('it substitutes no combined total', () => {
            // A summed headline describes neither tool — the whole reason the
            // region exists instead of one hero number.
            assert.ok(!fallback.includes(fmtBig(stats.totalTokens)));
            assert.ok(!/\d/.test(fallback.replace(/<[^>]*>/g, '')), 'no figure at all in text position');
        });
    });

    test('genuinely no data anywhere renders nothing', () => {
        // The dashboard's own empty states take over; the fallback is not a
        // permanent banner.
        const zeroStats = aggregateFromPerConvo({}, new Map(), '');
        assert.strictEqual(renderProviderRegion(zeroStats, emptySplit.claude, emptySplit.antigravity, []), '');
    });
});

describe('cost cell — CHARACTERISATION of pre-existing behaviour', () => {
    // These do NOT test work done by the Claude-provider task. renderCostEstimate
    // already suppressed unresolved models and sub-$0.01 rows beforehand and was
    // not modified — so they could never have gone red there. Kept as regression
    // guards on the "never $0.00" requirement, labelled so nobody reads them as
    // evidence the suppression was implemented then.
    //
    // Accepted divergence: the brief asked for the unresolved model to render
    // "tokens and calls with the cost cell blank". The code drops the whole ROW.
    // Left as is (out of scope) and asserted as row-suppression so the divergence
    // is explicit rather than unexamined.
    const unknownName = modelNameFromEnum(87231);
    const costHtml = renderCostEstimate([
        {
            displayName: 'Claude Opus 5', rawModel: 'claude-opus-5',
            input: 10_000_000, output: 2_000_000, cache: 0, cacheWrite: 0, reasoning: 0, calls: 5,
        },
        {
            displayName: unknownName, rawModel: unknownName,
            input: 5_000_000, output: 500_000, cache: 0, cacheWrite: 0, reasoning: 0, calls: 3,
        },
    ]);

    test('the priced model still renders a real dollar figure', () => {
        assert.match(costHtml, /\$\d/);
    });

    test('the unresolved model is suppressed entirely, not priced by guess', () => {
        assert.ok(!costHtml.includes(unknownName));
    });

    test('the string $0.00 never appears', () => {
        // A cheap-but-resolved or unresolved model renders blank, never "free".
        assert.ok(!costHtml.includes('$0.00'));
    });
});
