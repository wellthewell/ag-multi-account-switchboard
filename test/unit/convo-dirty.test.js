/**
 * isConvoDirty — decides whether a conversation gets re-read on a refresh.
 *
 * Ported from the --self-check block in src/services/usage/types.ts.
 * Pure predicate, no I/O. Runs in CI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isConvoDirty } = require('../../out/services/usage/types');

/** An unchanged, populated conversation. Each test perturbs one field. */
const base = { stepCount: 0, cachedStepCount: 0, mtime: 1000, cachedMtime: 1000, hasEntries: true };

describe('isConvoDirty', () => {
    test('an unchanged conversation is clean', () => {
        assert.strictEqual(isConvoDirty(base), false);
    });

    test('an IDE session is dirty when the language server reports more steps than cached', () => {
        assert.strictEqual(isConvoDirty({ ...base, stepCount: 5, cachedStepCount: 3 }), true);
    });

    test('a command-line session is dirty on mtime alone', () => {
        // The language server never lists these, so stepCount stays 0 while the
        // database on disk keeps growing. mtime is the only signal.
        assert.strictEqual(isConvoDirty({ ...base, mtime: 2000 }), true);
    });

    test('a blank pre-mtime conversation is retried', () => {
        // The regression this gate exists for: fetched once mid-session, came
        // back empty, and stepCount stayed pinned at 0 forever.
        assert.strictEqual(isConvoDirty({ ...base, cachedMtime: undefined, hasEntries: false }), true);
    });

    test('a populated pre-mtime conversation is left alone', () => {
        // Otherwise the first refresh after an upgrade re-reads every conversation.
        assert.strictEqual(isConvoDirty({ ...base, cachedMtime: undefined, hasEntries: true }), false);
    });

    test('a blank conversation already carrying an mtime stays clean until the file moves', () => {
        assert.strictEqual(isConvoDirty({ ...base, hasEntries: false }), false);
    });
});
