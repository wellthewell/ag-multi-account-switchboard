/**
 * Backlog account attribution.
 *
 * Transcripts carry no account stamp, and `~/.claude.json` holds only the
 * CURRENT account — it is overwritten on switch. Rows ingested from now on are
 * stamped exactly, at read time. Everything older is attributed here, from two
 * pinned eras recovered from dated .claude.json backups.
 *
 * This is inference. Two things keep it honest: the accountCreatedAt guard (a
 * row dated before an account existed is never attributed to it), and the
 * machine gate (the date rules only apply where one of the accounts they
 * describe is actually present — see resolveBacklogAccount's `discovered`
 * parameter). Without the second, this file labels a stranger's own usage with
 * a stranger's email, since it ships compiled into a published extension.
 */

// From ../convoId, not ../types: ../types ends in a --self-check block whose
// require() calls a bundler resolves eagerly, which breaks the webview build
// once anything imports resolveBacklogAccount transitively (see
// usage-components.ts and convoId.ts's own doc comment).
import { LEGACY_CLAUDE_ARCHIVE_ID } from '../convoId';

export interface PinnedAccount {
    email: string;
    accountUuid: string;
    createdAt: string;
}

const WELL: PinnedAccount = {
    email: 'well.j@honestdocs.co',
    accountUuid: '348cc96d-a86f-4963-9db5-bf1da5ba879a',
    createdAt: '2025-08-13',
};

const VARAKORN: PinnedAccount = {
    email: 'varakorn.j@topgunthailand.com',
    accountUuid: '49a38d72-c70f-4169-bcf3-bf7f31a5b8f7',
    createdAt: '2026-07-26',
};

type Rule =
    | { convoId: string; account: PinnedAccount }
    | { before: string; account: PinnedAccount }
    | { from: string; account: PinnedAccount };

/**
 * First match wins, in written order. A convoId rule beats a date rule.
 *
 * The archive rule matches by identity to keep it whole across its Jan-Jul date span,
 * which would otherwise split across two accounts. The archive is exempt from the
 * accountCreatedAt guard (see guard function).
 */
const PINNED_ERAS: Rule[] = [
    { convoId: LEGACY_CLAUDE_ARCHIVE_ID, account: WELL },
    { before: VARAKORN.createdAt, account: WELL },
    { from: VARAKORN.createdAt, account: VARAKORN },
];

/** Every uuid the date rules describe. A machine holding none of them is not this machine. */
const PINNED_UUIDS = new Set([WELL.accountUuid, VARAKORN.accountUuid]);

/**
 * @param discovered  The accounts actually present on THIS machine
 *                    (discoverClaudeAccounts()'s result, passed in by
 *                    accountFacetFor — this module cannot import it, see the
 *                    import comment above). Gates the DATE rules: they are
 *                    two specific people's account history, and applying them
 *                    to a stranger's disk labels that stranger's own usage
 *                    with a name and email that are not theirs.
 *
 *                    Not hypothetical, and not merely a privacy leak: a
 *                    config root with no `oauthAccount` is normal per spec
 *                    §7.3, ingestion stamps no accountKey in that case, so
 *                    these pins become the ONLY resolver — and every
 *                    post-2026-07-26 row of a complete stranger's usage would
 *                    render as `varakorn.j@topgunthailand.com`. With no
 *                    match, the date rules yield null and the row renders as
 *                    `unknown account`, which is honest.
 *
 *                    The archive rule stays unconditional: its conversation
 *                    id is a synthetic ledger key for a hand-import that
 *                    cannot exist on anyone else's disk.
 */
export function resolveBacklogAccount(
    convoId: string,
    ts: string,
    discovered: ReadonlyArray<{ accountUuid: string }> = [],
): PinnedAccount | null {
    const describesThisMachine = discovered.some((a) => PINNED_UUIDS.has(a.accountUuid));
    for (const rule of PINNED_ERAS) {
        if ('convoId' in rule) {
            if (convoId === rule.convoId) return guard(rule.account, ts, convoId);
            continue;
        }
        if (!describesThisMachine) return null;
        if (!ts) return null;
        const day = ts.slice(0, 10);
        if ('before' in rule && day < rule.before) return guard(rule.account, ts, convoId);
        if ('from' in rule && day >= rule.from) return guard(rule.account, ts, convoId);
    }
    return null;
}

/**
 * A row cannot belong to an account that did not exist yet. The archive is
 * exempt: it is attributed by identity, and its own rows postdate WELL anyway.
 */
function guard(account: PinnedAccount, ts: string, convoId: string): PinnedAccount | null {
    if (convoId === LEGACY_CLAUDE_ARCHIVE_ID) return account;
    if (!ts) return null;
    return ts.slice(0, 10) >= account.createdAt ? account : null;
}
