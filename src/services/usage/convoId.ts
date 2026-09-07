/**
 * Claude conversation id helpers — split out of ./types.ts so they can be
 * imported into browser-bundled code (src/shared/usage-components.ts, which
 * esbuild bundles into the webview) without pulling in ./types.ts itself.
 *
 * ./types.ts ends in a `--self-check` block full of literal `require(...)`
 * calls into extension-host-only modules (fs/path/os, sqlite, the language
 * server client, ...). A bundler resolves every literal require() it can
 * reach in the AST regardless of the runtime `if (require.main === module)`
 * guard around it — confirmed empirically: importing anything real from
 * ./types.ts into usage-components.ts made `npm run compile:webview` fail
 * with "Could not resolve 'fs'" from files several hops away, and the guard
 * itself references `require`/`module`, which do not exist in the webview's
 * browser runtime, so even loading (not calling) that code would throw.
 *
 * This file has zero imports and must stay that way. ./types.ts re-exports
 * both names from here so every existing `from './types'` import keeps
 * working unchanged.
 */

/** The archive predates the `claude:` prefix and keeps its id forever — renaming it orphans 12.94B tokens. */
export const LEGACY_CLAUDE_ARCHIVE_ID = 'claude-code-imported';

/** Single source of truth for "is this ledger key a Claude conversation". */
export function isClaudeConvo(cid: string): boolean {
    return cid.startsWith('claude:') || cid === LEGACY_CLAUDE_ARCHIVE_ID;
}

/**
 * A display label for a Claude cascade, derived from its ledger key alone.
 *
 * Claude conversations have no entry in the Antigravity title map (titles come
 * from the language server's trajectory summaries, which know nothing about
 * them), so every one of them rendered as the placeholder "Conversation" —
 * 18 of the Conversations card's 20 visible rows, which being sorted by token
 * volume also displaced every named Antigravity conversation into the
 * collapsed overflow.
 *
 * Pure string arithmetic on the key: no filesystem, no transcript content
 * (spec §16 — content is never read), and no dependency on the title map
 * being persisted, so it survives a cold cache load exactly the same. The
 * first 8 characters of the session uuid are what `claude --resume` shows and
 * what the transcript filename starts with, which makes the row traceable
 * back to a real session.
 */
export function claudeCascadeLabel(cid: string): string {
    if (cid === LEGACY_CLAUDE_ARCHIVE_ID) return 'Claude Code (imported archive)';
    const rest = cid.startsWith('claude:') ? cid.slice('claude:'.length) : cid;
    const [session, ...nested] = rest.split(':');
    const short = (s: string) => (s.length > 8 ? s.slice(0, 8) : s);
    if (nested.length > 0) {
        // Real subagent ids are `agent-<17 hex>`; the literal prefix is shared
        // by every one of them, so truncating with it left in would render
        // every subagent row identically.
        const agent = short(nested.join(':').replace(/^agent-/, ''));
        return `Claude subagent ${short(session)}/${agent}`;
    }
    return `Claude session ${short(session)}`;
}

/**
 * Canonical dedup fingerprint.
 *
 * Prefer responseId: metadata and steps often describe the same model call with
 * slightly different timestamps, and Claude ingestion deliberately STORES
 * cross-file duplicates (a resumed session replays a request into a second
 * transcript) leaving the collapse to whoever aggregates — see Ruling 12.
 * The token/timestamp fallback is only for API drift.
 *
 * Lives here rather than in ./types.ts because both the aggregator
 * (extension host) and accountFacetFor (webview-bundled) must apply the
 * IDENTICAL rule: they render in the same block, and the moment the two
 * disagree the breakdown exceeds the header above it — measured on the live
 * corpus at +180,670,338 tokens and +388 calls before this was shared. The
 * parameter is structural, not `TokenEntry`, so this file keeps its
 * zero-imports invariant (see the doc comment above).
 */
export function entryFingerprint(e: {
    responseId?: string;
    inp: number; out: number; cache: number; cacheWrite: number; reasoning: number;
    ts?: string;
}): string {
    if (e.responseId) return `rid:${e.responseId}`;
    return `${e.inp}:${e.out}:${e.cache}:${e.cacheWrite}:${e.reasoning}:${e.ts?.substring(0, 23) || ''}`;
}
