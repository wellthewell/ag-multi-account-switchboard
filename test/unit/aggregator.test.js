/**
 * aggregateFromPerConvo — day bucketing, global dedupe, and the year grid.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * aggregation over fixture entries, no I/O. Runs in CI.
 *
 * The self-check version of these assertions SKIPPED unless the runner's clock
 * sat at a positive UTC offset, because a bucket keyed by the UTC date and one
 * keyed by the local date agree everywhere else — and CI runs UTC, so they
 * would have skipped there permanently. Node honours a mutated process.env.TZ,
 * so this file pins the offset instead of testing for one.
 */

process.env.TZ = 'Asia/Bangkok';   // MUST precede every Date below

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { aggregateFromPerConvo } = require('../../out/services/usage/aggregator');
const { isoDay } = require('../../out/shared/helpers');
const { renderDailyGrid } = require('../../out/shared/usage-components');

const mk = (rid, ts) => ({
    responseId: rid, source: 'metadata', inp: 100, out: 10, cache: 0, cacheWrite: 0, reasoning: 0,
    model: 'MODEL_PLACEHOLDER_M73', provider: 'API_PROVIDER_GOOGLE_GEMINI', ts,
});

// 01:30 local on the 5th. A positive offset makes EARLY-morning local hours the
// ones that cross the UTC boundary — 01:30 local on the 5th is 18:30 UTC on the
// 4th, so a UTC-keyed bucket lands on the wrong day. Late-evening hours would
// pass under both implementations and prove nothing. This mirrors the real
// 01:17 / 01:39 sessions that fell onto the previous day under UTC slicing.
const local = new Date(2026, 7, 5, 1, 30, 0);

describe('day buckets are keyed by the local date', () => {
    test('the fixture actually straddles the UTC boundary', () => {
        // Without this the next assertion could pass on a runtime where local
        // and UTC agree, which is what made the original version skippable.
        assert.strictEqual(-new Date().getTimezoneOffset(), 420, 'TZ pin took effect');
        assert.notStrictEqual(local.toISOString().slice(0, 10), isoDay(local));
    });

    test('a 01:30-local entry buckets to the local day, not the UTC one', () => {
        const stats = aggregateFromPerConvo({ c1: { entries: [mk('R1', local.toISOString())] } }, new Map());
        assert.strictEqual(stats.daily[0].date, isoDay(local));
    });
});

describe('the year grid keys cells by local date', () => {
    test('a Monday bucket lands in the Monday row', () => {
        // 2026-08-10 is a Monday; in a Monday-first grid its cell belongs to row 0.
        const html = renderDailyGrid(
            [{ date: '2026-08-10', input: 1000, output: 100, cache: 0, cacheWrite: 0, reasoning: 0, calls: 5 }],
            false, 2026, 0,
        );
        const cells = [...html.matchAll(/<div class="gh-cell gh-lvl-(\d)" data-tip="([^"]*)"><\/div>/g)];
        const litIndex = cells.findIndex(c => c[1] !== '0');
        assert.ok(litIndex >= 0, 'the bucket lights a cell at all');
        assert.strictEqual(litIndex % 7, 0);
    });
});

describe('dedupe is global, not per-conversation', () => {
    const stats = aggregateFromPerConvo({
        parent: { entries: [mk('SHARED', local.toISOString())] },
        child: { entries: [mk('SHARED', local.toISOString())] },
    }, new Map());

    test('one call recorded under two conversations counts once', () => {
        assert.strictEqual(stats.totalCalls, 1, '7 real response ids already span two conversations');
        assert.strictEqual(stats.totalInput, 100);
    });

    test('the monthly buckets are deduplicated too', () => {
        // Monthly buckets are built from allEntries, populated BEFORE the date
        // filter — so dedupe has to cover that path, not just the filtered one.
        assert.strictEqual(stats.monthly.reduce((n, m) => n + m.calls, 0), 1);
    });
});

describe('lastActivityAt is unfiltered', () => {
    // dateRange is built from filteredEntries and goes blank the moment the
    // selected window has zero calls — exactly the case where the empty state
    // needs a real "last activity" date to show.
    const stats = aggregateFromPerConvo(
        { c1: { entries: [mk('R9', '2026-07-01T00:00:00.000Z')] } },
        new Map(),
        '2026-08-01T00:00:00.000Z',   // filter excludes the only entry
    );

    test('the filtered range is empty', () => {
        assert.strictEqual(stats.totalCalls, 0);
        assert.strictEqual(stats.dateRange.to, '');
    });

    test('but it still reports when activity last happened', () => {
        assert.strictEqual(stats.lastActivityAt, '2026-07-01T00:00:00.000Z');
    });
});
