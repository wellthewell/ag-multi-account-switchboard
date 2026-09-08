/**
 * resolveBacklogAccount — attributing historical Claude rows to an account.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * logic over dates and identifiers, no I/O. Runs in CI.
 *
 * Why this exists at all: Claude Code transcripts carry no account stamp, and
 * ~/.claude.json holds only the *currently* logged-in account — it is
 * overwritten on switch. Rows read from now on are stamped exactly at read
 * time; everything already on disk has to be attributed by date, from two eras
 * recovered out of dated .claude.json backups. That makes this module
 * inference, and the accountCreatedAt guard is what keeps it honest: a row
 * dated before an account existed is never attributed to it, and a row
 * matching nothing resolves to null rather than being folded into whoever is
 * logged in now.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { resolveBacklogAccount: resolveRaw } = require('../../out/services/usage/claude/claudePins');
const { LEGACY_CLAUDE_ARCHIVE_ID } = require('../../out/services/usage/types');

const WELL = 'well.j@honestdocs.co';
const VARAKORN = 'varakorn.j@topgunthailand.com';

/** The machine the date rules actually describe. */
const THIS_MACHINE = [{ accountUuid: '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7', email: VARAKORN }];
/** Somebody else's machine, running the same published extension. */
const STRANGER = [{ accountUuid: '00000000-9999-8888-7777-666666666666', email: 'someone@else.example' }];

const resolve = (convoId, ts) => resolveRaw(convoId, ts, THIS_MACHINE);

describe('rule 1 — the archive resolves by identity, not by row date', () => {
    test('an archive row mid-era resolves to the older account', () => {
        assert.strictEqual(resolve(LEGACY_CLAUDE_ARCHIVE_ID, '2026-06-05T12:00:00.000Z').email, WELL);
    });

    test('an archive row late in its range still resolves to the older account', () => {
        assert.strictEqual(resolve(LEGACY_CLAUDE_ARCHIVE_ID, '2026-07-21T12:00:00.000Z').email, WELL);
    });

    test('identity beats the date rules at a post-switch date', () => {
        // This is the assertion that proves precedence rather than coincidence.
        // The archive's real rows all predate the switch, so a date-only
        // resolution would agree with rule 1 everywhere in the real data. Only
        // a post-switch timestamp makes the two mechanisms disagree: without
        // rule 1 the from-rule matches and returns varakorn instead.
        assert.strictEqual(resolve(LEGACY_CLAUDE_ARCHIVE_ID, '2026-09-01T12:00:00.000Z').email, WELL);
    });
});

describe('rules 2 and 3 — the date eras', () => {
    test('a transcript-era row resolves to the newer account', () => {
        assert.strictEqual(resolve('claude:abc', '2026-07-30T10:00:00.000Z').email, VARAKORN);
    });

    test('a pre-switch transcript is not attributed to the newer account', () => {
        assert.strictEqual(resolve('claude:xyz', '2026-05-01T10:00:00.000Z').email, WELL);
    });
});

describe('the accountCreatedAt guard', () => {
    test('a row older than every known account is unknown, never guessed', () => {
        assert.strictEqual(resolve('claude:xyz', '2024-01-01T00:00:00.000Z'), null);
    });

    test('a row with no timestamp is unknown', () => {
        assert.strictEqual(resolve('claude:xyz', ''), null);
    });
});

describe('the era boundary is inclusive going forward', () => {
    test('the createdAt date itself belongs to the new account', () => {
        assert.strictEqual(resolve('claude:xyz', '2026-07-26T00:00:00.000Z').email, VARAKORN);
    });

    test('the day before belongs to the old account', () => {
        assert.strictEqual(resolve('claude:xyz', '2026-07-25T23:59:59.000Z').email, WELL);
    });
});

describe('the date rules only describe this machine', () => {
    // claudePins compiles into a published extension (publisher `wellthewell`,
    // public repo) and usage-components.ts imports it statically, so these two
    // real work emails and account uuids reach every installer in both bundles.
    // The privacy leak is the lesser half: a config root with no oauthAccount
    // is a normal state and stamps no accountKey, which would leave these pins
    // as the ONLY resolver — so a stranger's own post-switch usage would render
    // under someone else's address. The rules therefore require one of the
    // pinned accounts to actually be present.

    test('on a stranger machine a transcript-era row is unknown', () => {
        assert.strictEqual(resolveRaw('claude:xyz', '2026-08-10T10:00:00.000Z', STRANGER), null);
    });

    test('the pre-switch rule is gated too, not just the recent one', () => {
        assert.strictEqual(resolveRaw('claude:xyz', '2026-05-01T10:00:00.000Z', STRANGER), null);
    });

    test('with no discovered accounts at all the date rules stand down', () => {
        // How the webview bundle starts up, before any resolver is registered.
        assert.strictEqual(resolveRaw('claude:xyz', '2026-08-10T10:00:00.000Z'), null);
    });

    test('either pinned account being present is enough', () => {
        // The gate asks "is this one of the machines these rules describe",
        // not "is this the account the row resolves to".
        const olderPinnedLoggedIn = [{ accountUuid: '348cc96d-a86f-4963-9db5-bf1da5ba879a', email: WELL }];
        assert.strictEqual(
            resolveRaw('claude:xyz', '2026-08-10T10:00:00.000Z', olderPinnedLoggedIn).email,
            VARAKORN,
        );
    });
});

describe('the archive rule is exempt from the machine gate', () => {
    // `claude-code-imported` is a synthetic ledger key for a hand-import that
    // cannot exist on anyone else's disk, so it needs no machine check.

    test('it resolves on a stranger machine', () => {
        assert.strictEqual(
            resolveRaw(LEGACY_CLAUDE_ARCHIVE_ID, '2026-06-05T12:00:00.000Z', STRANGER).email,
            WELL,
        );
    });

    test('it resolves with no discovered accounts at all', () => {
        assert.strictEqual(
            resolveRaw(LEGACY_CLAUDE_ARCHIVE_ID, '2026-06-05T12:00:00.000Z').email,
            WELL,
        );
    });
});
