/**
 * accountFacetFor — the per-account breakdown under the Claude provider header.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure, no
 * I/O — but setClaudeAccountResolver is MODULE-GLOBAL state, so every describe
 * here sets the resolver it needs and the file restores the default at the end.
 *
 * Three separate honesty constraints meet in this one function:
 *   - the imported archive is a day rollup, so it has no honest call count;
 *   - a pinned EMAIL may only label the account it actually belongs to;
 *   - the facet can never sum to more than the header directly above it.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { accountFacetFor, setClaudeAccountResolver } = require('../../out/shared/usage-components');
const { aggregateByProvider } = require('../../out/services/usage/aggregator');

const VARAKORN_UUID = '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7';
const WELL_UUID = '348cc96d-a86f-4963-9db5-bf1da5ba879a';

const entry = (rid, ts, out = 100, accountKey) => ({
    responseId: rid, source: 'metadata', inp: 0, out, cache: 0,
    cacheWrite: 0, reasoning: 0, model: 'claude-opus-4-8', provider: 'anthropic', ts, accountKey,
});

after(() => setClaudeAccountResolver(() => []));

/**
 * The resolver is module-global and every describe BODY runs before any test
 * does, so a resolver set in a describe body is NOT the one in effect when a
 * test that calls accountFacetFor itself runs — the last body to execute wins.
 * That silently made the pin-mismatch test below pass for the wrong reason (the
 * stranger resolver fails the machine gate, so the pins stand down and every
 * label falls back to a raw uuid). Set it per call instead.
 */
function facetWith(accounts, ledger) {
    setClaudeAccountResolver(() => accounts);
    try { return accountFacetFor(ledger); } finally { setClaudeAccountResolver(() => []); }
}

const WELL_PRESENT = [{ accountUuid: WELL_UUID, email: 'well.j@honestdocs.co' }];

describe('the stamped account and the archive', () => {
    // WELL_PRESENT is the OLDER pinned account: it satisfies the machine gate
    // (I6) while supplying no email for the uuid the fixture rows are stamped
    // with, which is what keeps the pinned-email path observable below rather
    // than short-circuited by a discovered email.
    const rows = facetWith(WELL_PRESENT, {
        'claude:sess-1': { entries: [entry('r1', '2026-08-01T10:00:00.000Z', 100, VARAKORN_UUID)] },
        'claude-code-imported': { entries: [entry('cc-1', '2026-06-01T12:00:00.000Z')] },
    });
    const vara = rows.find((r) => r.accountUuid === VARAKORN_UUID);
    const well = rows.find((r) => r.accountUuid === WELL_UUID);

    test('a read-time-stamped row gets a real call count', () => {
        assert.ok(vara, 'the stamped account appears');
        assert.strictEqual(vara.tokens, 100);
        assert.strictEqual(vara.calls, 1);
    });

    test('the unstamped archive resolves through the pins, not to unknown', () => {
        assert.ok(well);
    });

    test("the archive's call count is null — it is a day rollup", () => {
        assert.strictEqual(well.calls, null, 'an artifact of the import must never render as a number');
        assert.match(well.note || '', /thinking/i, 'and it is marked as not breaking out thinking');
    });

    test('a stamped row MATCHING the date-derived pin takes the pinned email', () => {
        // sess-1 is stamped with Varakorn's own uuid on a date the pins also
        // resolve to Varakorn. No resolver supplies that email here (the real
        // one is registered from usageStatsPanel.ts, which needs vscode), so
        // the pin is the only possible source of a human-readable label.
        assert.strictEqual(vara.label, 'varakorn.j@topgunthailand.com');
    });

    test('a stamped row DISAGREEING with the pin falls back to the raw uuid', () => {
        // Same era (2026-08 resolves to Varakorn) but stamped with a different
        // account. Borrowing the pinned email would print one person's address
        // against another account's usage.
        const STRANGER = 'ffffffff-1111-2222-3333-444444444444';
        const rows = facetWith(WELL_PRESENT, {
            'claude:sess-mismatch': { entries: [entry('m1', '2026-08-05T10:00:00.000Z', 100, STRANGER)] },
        });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].accountUuid, STRANGER, 'the stamped key wins for the uuid itself');
        assert.strictEqual(rows[0].label, STRANGER);
        assert.ok(!rows[0].label.includes('@'), 'no email is attached to an account the pins did not resolve to');
    });
});

describe('I1 — the facet can never exceed the header above it', () => {
    // The missing half of the spec's §13 test 2 (requestId dedupe): it landed
    // for the reader and the aggregator, never for the facet. Ingestion
    // deliberately STORES a cross-file replay — a resumed session re-sends a
    // request, so the same requestId appears in two transcripts — and lets
    // whoever aggregates collapse it (Ruling 12). accountFacetFor summed every
    // stored entry instead, so the breakdown rendered LARGER than the provider
    // total directly above it: measured live, header 15,695,716,154 tokens /
    // 9,532 calls against facet 15,876,386,492 / 9,920.
    //
    // Both sides dedupe in object-insertion order and keep the first copy, so
    // this is an exact equality, not a tolerance.
    const KEY = VARAKORN_UUID;
    const replayLedger = {
        'claude:sess-a': {
            entries: [
                entry('req-a1', '2026-08-01T10:00:00.000Z', 10, KEY),
                entry('req-replay', '2026-08-01T10:05:00.000Z', 1000, KEY),
            ],
        },
        'claude:sess-b': {
            entries: [
                entry('req-replay', '2026-08-02T09:00:00.000Z', 1000, KEY),
                entry('req-b1', '2026-08-02T09:05:00.000Z', 20, KEY),
            ],
        },
    };
    const facetRows = facetWith(WELL_PRESENT, replayLedger);
    const split = aggregateByProvider(replayLedger, new Map(), '');

    test('sanity: the aggregator collapses the replay — 4 stored entries, 3 calls', () => {
        assert.strictEqual(split.claude.totalCalls, 3);
    });

    test("the facet's token sum EQUALS the provider header", () => {
        const facetTokens = facetRows.reduce((s, r) => s + r.tokens, 0);
        assert.strictEqual(facetTokens, split.claude.totalTokens);
    });

    test("the facet's non-null call sum EQUALS the header's call count", () => {
        const facetCalls = facetRows.filter((r) => r.calls !== null).reduce((s, r) => s + r.calls, 0);
        assert.strictEqual(facetCalls, split.claude.totalCalls);
    });
});

describe("I6 — a stranger's machine gets `unknown account`", () => {
    // The end-to-end shape of the leak: a config root with no `oauthAccount`
    // (normal, per spec §7.3) stamps no accountKey, so the pins are the only
    // resolver — and before the machine gate, this row rendered as
    // varakorn.j@topgunthailand.com on a stranger's dashboard.
    const rows = facetWith(
        [{ accountUuid: '00000000-9999-8888-7777-666666666666', email: 'someone@else.example' }],
        { 'claude:their-session': { entries: [entry('their-1', '2026-08-20T10:00:00.000Z')] } },
    );

    test('an unstamped row resolves to no account at all', () => {
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].accountUuid, null);
    });

    test('and renders as "unknown account", never a pinned work email', () => {
        assert.strictEqual(rows[0].label, 'unknown account');
    });
});
