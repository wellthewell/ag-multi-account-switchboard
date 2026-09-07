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
