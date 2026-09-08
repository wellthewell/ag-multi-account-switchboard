/**
 * gridMode — the window each range filter draws and counts.
 *
 * Ported from the --self-check block in src/services/usage/types.ts, which
 * also carried the dayCount helper below; it exists only for these tests and
 * moved with them.
 *
 * Pure date arithmetic, no I/O. Dates are constructed with the local-time
 * `new Date(y, m, d)` form deliberately — these assertions are about local
 * days, and using ISO strings would make them pass or fail by timezone.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { gridMode } = require('../../out/shared/helpers');

/** Inclusive day count of a strip window. */
function dayCount(mode) {
    if (mode.kind !== 'strip') return 0;
    const from = new Date(mode.from + 'T00:00:00');
    const to = new Date(mode.to + 'T00:00:00');
    return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

const thu = new Date(2026, 7, 6); // Thu 2026-08-06, local

describe('gridMode — ranges with no day grid', () => {
    test('all time keeps the year grid', () => {
        assert.deepStrictEqual(gridMode('all', thu), { kind: 'year' });
    });

    test('24h and today are hourly', () => {
        assert.deepStrictEqual(gridMode('24h', thu), { kind: 'hourly' });
        assert.deepStrictEqual(gridMode('today', thu), { kind: 'hourly' });
    });
});

describe('gridMode — N days means exactly N squares, ending today', () => {
    test('7d spans seven days and draws seven squares', () => {
        const d7 = gridMode('7d', thu);
        assert.deepStrictEqual(d7, { kind: 'strip', from: '2026-07-31', to: '2026-08-06' });
        assert.strictEqual(dayCount(d7), 7);
    });

    test('30d draws thirty squares', () => {
        assert.strictEqual(dayCount(gridMode('30d', thu)), 30);
    });

    test('30d crosses a year boundary without dropping days', () => {
        // The year grid silently drops days outside the selected year. A strip must not.
        assert.deepStrictEqual(
            gridMode('30d', new Date(2026, 0, 5)),
            { kind: 'strip', from: '2025-12-07', to: '2026-01-05' },
        );
    });
});

describe('gridMode — calendar-anchored ranges', () => {
    test('this-week starts Monday', () => {
        assert.deepStrictEqual(gridMode('this-week', thu), { kind: 'strip', from: '2026-08-03', to: '2026-08-06' });
    });

    test('Sunday closes the week rather than opening it', () => {
        // Sunday must count as the 7th day of a Monday-start week, not the 0th.
        assert.deepStrictEqual(
            gridMode('this-week', new Date(2026, 7, 9)),
            { kind: 'strip', from: '2026-08-03', to: '2026-08-09' },
        );
    });

    test('this-month starts on the 1st', () => {
        assert.deepStrictEqual(gridMode('this-month', thu), { kind: 'strip', from: '2026-08-01', to: '2026-08-06' });
    });

    test('last-month is the whole prior month', () => {
        assert.deepStrictEqual(gridMode('last-month', thu), { kind: 'strip', from: '2026-07-01', to: '2026-07-31' });
    });
});

describe('gridMode — local dates, not UTC', () => {
    test('a late-evening timestamp does not roll to tomorrow', () => {
        assert.strictEqual(gridMode('7d', new Date(2026, 7, 6, 23, 30)).to, '2026-08-06');
    });
});
