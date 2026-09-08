/**
 * renderHealthCard — the panel's trust signals.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * rendering over a plain health object, no I/O. Runs in CI.
 *
 * The card exists to say how much of the panel's numbers are actually
 * verified, so every state it can be in has to be visibly different. The one
 * that matters most is the middle state: the verifier RAN but compared nothing,
 * because every sampled conversation was one the language server could no
 * longer serve. That is the normal condition, not a clean result — rendering it
 * as clean manufactures exactly the false confidence the verifier exists to
 * prevent.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { renderHealthCard } = require('../../out/shared/usage-components');

const base = {
    source: 'store', conversations: 100, unreadable: 0, unknownModels: [],
    skippedRows: 0, verification: null, countingChangedAt: null,
};
const card = (over) => renderHealthCard({ ...base, ...over });
const AT = '2026-08-14T00:00:00.000Z';

describe('the card names its data source', () => {
    test('source and conversation count', () => {
        assert.ok(card().includes('conversation store'));
        assert.ok(card().includes('100'));
    });
});

describe('three verification states, not two', () => {
    test('state 1 — the verifier has not run: no cross-check row at all', () => {
        // The row label is "Token counts", not "Cross-check": the verifier checks
        // token counts against the language server, not dollar rates, and the old
        // label sat directly under an estimated-cost figure where it could be
        // misread as vouching for the money.
        const html = card();
        assert.ok(!/Token counts/i.test(html));
        assert.ok(!/clean/i.test(html), 'verification:null must never render as clean');
    });

    test('state 2 — it ran but compared nothing: "not verified this run"', () => {
        const html = card({ verification: { compared: 0, diverged: 0, at: AT } });
        assert.match(html, /not verified this run/i);
        assert.ok(!/clean/i.test(html), 'compared:0 is not a clean result');
    });

    test('state 3 — a real, agreeing comparison is the only clean state', () => {
        const html = card({ verification: { compared: 42, diverged: 0, at: AT } });
        assert.match(html, /clean/i);
        assert.ok(html.includes('42'), 'it names how many calls were actually compared');
    });

    test('a real comparison that disagreed warns instead', () => {
        const html = card({ verification: { compared: 42, diverged: 3, at: AT } });
        assert.ok(!/clean/i.test(html));
        assert.ok(html.includes('3'), 'the divergence count is shown');
    });
});

describe('the skipped-rows counter', () => {
    // Somewhere for a decode regression to become visible.
    test('a nonzero count is surfaced, and its scope is named', () => {
        const html = card({ skippedRows: 7 });
        assert.ok(html.includes('7'));
        assert.match(html, /metadata/i,
            'the count covers gen_metadata only, not steps — a reader must not read it as a total across all read paths');
    });

    test('a healthy zero adds no noise', () => {
        assert.ok(!/skipped/i.test(card({ skippedRows: 0 })));
    });
});

describe('the counting-changeover marker', () => {
    test('named once it exists', () => {
        assert.match(card({ countingChangedAt: '2026-08-10T00:00:00.000Z' }), /Aug\s*10/);
    });

    test('silent when it does not', () => {
        assert.ok(!/Aug\s*10/.test(card()));
    });
});
