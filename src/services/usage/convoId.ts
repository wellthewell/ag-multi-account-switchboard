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
