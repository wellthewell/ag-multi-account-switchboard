/**
 * Backlog account attribution.
 *
 * Transcripts carry no account stamp, and `~/.claude.json` holds only the
 * CURRENT account — it is overwritten on switch. Rows ingested from now on are
 * stamped exactly, at read time. Everything older is attributed here, from two
 * pinned eras recovered from dated .claude.json backups.
 *
 * This is inference. The accountCreatedAt guard is what keeps it honest: a row
 * dated before an account existed is never attributed to it.
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

export function resolveBacklogAccount(convoId: string, ts: string): PinnedAccount | null {
    for (const rule of PINNED_ERAS) {
        if ('convoId' in rule) {
            if (convoId === rule.convoId) return guard(rule.account, ts, convoId);
            continue;
        }
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
