/**
 * isClaudeConvo — the single test for "is this ledger key a Claude conversation".
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * predicate, no I/O. Runs in CI.
 *
 * Claude conversations added from now on are keyed `claude:<sessionId>`. One
 * pre-existing conversation is keyed `claude-code-imported` with no prefix and
 * keeps that key forever, because mergeIntoLedger preserves by key and a rename
 * reads as "old key deleted, new key added" — with no backing file to re-read
 * from, that would orphan it. So the legacy id is grandfathered by exact match,
 * and the negative case below is what stops this decaying into a loose prefix
 * check that would sweep in anything starting `claude-code`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isClaudeConvo, LEGACY_CLAUDE_ARCHIVE_ID } = require('../../out/services/usage/types');

describe('isClaudeConvo', () => {
    test('a prefixed session id is Claude', () => {
        assert.strictEqual(isClaudeConvo('claude:456d535f-1489-442b-a5dd-8f69c5acfc8e'), true);
    });

    test('the legacy archive id is Claude', () => {
        assert.strictEqual(isClaudeConvo(LEGACY_CLAUDE_ARCHIVE_ID), true);
        assert.strictEqual(LEGACY_CLAUDE_ARCHIVE_ID, 'claude-code-imported',
            'pinned because the key cannot change without orphaning the archive');
    });

    test('a bare uuid is an Antigravity conversation', () => {
        assert.strictEqual(isClaudeConvo('00b78c15-c64b-490f-8dec-7187d9e8c06a'), false);
    });

    test('only the exact legacy id is grandfathered, not any claude-code prefix', () => {
        assert.strictEqual(isClaudeConvo('claude-code-something-else'), false);
    });
});
