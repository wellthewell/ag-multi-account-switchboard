/**
 * mergeIntoLedger — the cache is a ledger, not a mirror of disk.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * function over plain objects, no I/O. Runs in CI.
 *
 * The first assertion is the one that matters: a conversation with no backing
 * file is preserved verbatim. That is what keeps `claude-code-imported` alive
 * — 175 entries and 12,942,976,240 tokens hand-imported with no source files
 * anywhere. Every other rule here follows from the same principle: the ledger
 * accumulates, it does not reconcile against what happens to be on disk now.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { mergeIntoLedger } = require('../../out/services/usage/cache');
const { LEGACY_CLAUDE_ARCHIVE_ID } = require('../../out/services/usage/types');

/** One token entry; the values are irrelevant, only how many survive. */
const entry = {
    responseId: 'X', source: 'metadata',
    inp: 1, out: 1, cache: 0, cacheWrite: 0, reasoning: 0,
    model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z',
};

function scenario() {
    const existing = {
        [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [entry, entry] }, // synthetic, no file on disk
        'deleted-by-user':          { entries: [entry] },        // file removed since
        'still-present':            { entries: [entry] },
        'present-not-reread':       { entries: [entry, entry] }, // on disk, not re-read this pass
    };
    const fresh = { 'still-present': { entries: [entry, entry, entry] } };
    const present = new Set(['still-present', 'present-not-reread']);
    return { existing, merged: mergeIntoLedger(existing, fresh, present) };
}

function totalEntries(ledger) {
    return Object.values(ledger).reduce((n, v) => n + v.entries.length, 0);
}

describe('mergeIntoLedger', () => {
    test('a conversation with no backing file is preserved', () => {
        const { merged } = scenario();
        assert.strictEqual(merged[LEGACY_CLAUDE_ARCHIVE_ID].entries.length, 2,
            'the hand-imported archive has no source files — this is the only thing keeping it');
    });

    test('history survives the user deleting a conversation', () => {
        const { merged } = scenario();
        assert.strictEqual(merged['deleted-by-user'].entries.length, 1);
    });

    test('a conversation present on disk is replaced by the fresh read', () => {
        const { merged } = scenario();
        assert.strictEqual(merged['still-present'].entries.length, 3,
            'the file is the truth for a conversation the caller actually re-read');
    });

    test('a conversation on disk but not re-read this pass keeps what it had', () => {
        const { merged } = scenario();
        assert.strictEqual(merged['present-not-reread'].entries.length, 2);
    });

    test('the ledger never shrinks', () => {
        const { existing, merged } = scenario();
        assert.ok(totalEntries(merged) >= totalEntries(existing));
    });
});
