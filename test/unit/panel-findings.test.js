/**
 * Three panel-level findings: the region's scope label, Claude cascade titles,
 * and the memoized all-time split.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure, no
 * I/O. Runs in CI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { renderProviderSection, renderProviderRegion } = require('../../out/shared/usage-components');
const { aggregateFromPerConvo, allTimeProviderSplit } = require('../../out/services/usage/aggregator');
const { claudeCascadeLabel } = require('../../out/services/usage/convoId');
const { LEGACY_CLAUDE_ARCHIVE_ID, isClaudeConvo } = require('../../out/services/usage/types');

const ent = (rid, ts, out) => ({
    responseId: rid, source: 'metadata', inp: 10, out, cache: 0,
    cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8', provider: 'anthropic', ts,
});

const SESSION = 'claude:aaaaaaaa-1111-2222-3333-444444444444';
const SUBAGENT = 'claude:bbbbbbbb-1111-2222-3333-444444444444:agent-a32b63bdc31fc263a';
const ANTIGRAVITY = '00b78c15-c64b-490f-8dec-7187d9e8c06a';

const ledger = {
    [SESSION]: { entries: [ent('p1', '2026-08-01T10:00:00.000Z', 5000)] },
    [SUBAGENT]: { entries: [ent('p2', '2026-08-01T11:00:00.000Z', 4000)] },
    [LEGACY_CLAUDE_ARCHIVE_ID]: { entries: [ent('p3', '2026-02-01T11:00:00.000Z', 3000)] },
    [ANTIGRAVITY]: {
        entries: [{
            responseId: 'g1', source: 'metadata', inp: 5, out: 5, cache: 0, cacheWrite: 0,
            reasoning: 0, model: 'MODEL_PLACEHOLDER_M20', provider: 'API_PROVIDER_GOOGLE_GEMINI',
            ts: '2026-08-01T12:00:00.000Z',
        }],
    },
};

describe('I3 — the provider region says which window it covers', () => {
    // The region is deliberately all-time while the range bar renders directly
    // below it and filters every other card, so selecting "24h" left a lifetime
    // total on top of a one-day dashboard with nothing to distinguish the two
    // scopes. The fix is the label, not threading the range through.
    const split = allTimeProviderSplit(ledger, new Map());
    const region = renderProviderRegion(aggregateFromPerConvo(ledger, new Map(), ''), split.claude, split.antigravity, []);

    test('BOTH provider headers name their window', () => {
        const scopes = [...region.matchAll(/<span class="up-provider-scope">([^<]*)<\/span>/g)].map((m) => m[1]);
        assert.deepStrictEqual(scopes, ['all time', 'all time']);
    });

    test('the label is the caller\'s claim, not a decoration the section invents', () => {
        // A caller that ever does filter by range must not be made to lie.
        assert.ok(!renderProviderSection('Claude Code', split.claude, []).includes('up-provider-scope'));
    });
});

describe('I5 — Claude cascades are distinguishable in the list', () => {
    // Claude conversations have no titleMap entry and no Antigravity brain
    // directory, so all of them rendered as the same "Conversation" placeholder —
    // measured at 18 of the Conversations card's 20 visible rows, which being
    // sorted by token volume displaced every named Antigravity conversation into
    // the collapsed overflow. Excluding Claude ids from the card was rejected:
    // that hides real usage.
    const titles = new Map(aggregateFromPerConvo(ledger, new Map(), '').cascades.map((c) => [c.id, c.title]));

    test('a session row is labelled from its ledger key alone', () => {
        // No filesystem, no transcript content (spec §16), no persisted title map.
        assert.strictEqual(titles.get(SESSION), 'Claude session aaaaaaaa');
    });

    test('a subagent row names both its parent session and its own agent id', () => {
        // The shared "agent-" prefix is stripped before truncation — otherwise
        // every subagent row would read identically.
        assert.strictEqual(titles.get(SUBAGENT), 'Claude subagent bbbbbbbb/a32b63bd');
    });

    test('the archive says what it is', () => {
        assert.strictEqual(titles.get(LEGACY_CLAUDE_ARCHIVE_ID), 'Claude Code (imported archive)');
    });

    test('the three Claude rows are distinguishable from each other', () => {
        const claudeRows = [...titles.entries()].filter(([id]) => isClaudeConvo(id));
        assert.strictEqual(claudeRows.length, 3, 'sanity: all three are in the card');
        assert.strictEqual(new Set(claudeRows.map(([, t]) => t)).size, 3,
            'not three copies of one placeholder');
        for (const [, t] of claudeRows) {
            assert.match(t, /^Claude/, `the provider is marked on the row (${t})`);
            assert.notStrictEqual(t, 'Conversation');
        }
    });

    test('the Antigravity title path is unchanged — the Claude branch is additive', () => {
        assert.strictEqual(titles.get(ANTIGRAVITY), 'Conversation');
    });

    test('a session id shorter than the truncation length is left intact', () => {
        assert.strictEqual(claudeCascadeLabel('claude:short'), 'Claude session short');
    });
});

describe('I7 — the all-time split is memoized on ledger identity', () => {
    // Measured at 83 ms on the combined ledger, recomputed on every range and
    // year-selector click even though the split is all-time and cannot change.
    // ~800 ms per click at 10x the corpus.
    const titleMap = new Map();
    const first = allTimeProviderSplit(ledger, titleMap);

    test('the same ledger and titleMap return the IDENTICAL object', () => {
        assert.strictEqual(allTimeProviderSplit(ledger, titleMap), first);
    });

    test('a different titleMap identity misses the memo', () => {
        // A title refresh over an unchanged ledger must not be served a stale split.
        assert.notStrictEqual(allTimeProviderSplit(ledger, new Map()), first);
    });

    test('a new ledger object misses the memo', () => {
        // Fresh data is never served stale: every refresh path builds a new
        // merged object before writing it.
        assert.notStrictEqual(allTimeProviderSplit({ ...ledger }, titleMap), first);
    });

    test('the memoized value is the real split, not a stub', () => {
        assert.strictEqual(first.claude.totalCalls, 3);
    });
});
