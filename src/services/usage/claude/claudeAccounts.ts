/**
 * Claude Code account discovery — read-only.
 *
 * Enumerates config ROOTS, never credentials. The keychain holds a second
 * entry (`Claude Code-credentials-69ff85f3`) that is a dead artifact from an
 * abandoned Jul 2026 login; enumerating keychain entries would report a
 * phantom account. See the spec, §12.2.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeAccount {
    email: string;
    accountUuid: string;
    organizationUuid?: string;
    seatTier?: string;
    accountCreatedAt?: string;
    /** Config root this identity was read from. */
    root: string;
}

/** A root is a directory containing `projects/`. */
function isRoot(dir: string): boolean {
    try { return fs.statSync(path.join(dir, 'projects')).isDirectory(); }
    catch { return false; }
}

export function discoverClaudeRoots(
    homeDir: string = os.homedir(),
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const candidates = env.CLAUDE_CONFIG_DIR
        ? [env.CLAUDE_CONFIG_DIR]
        : [path.join(homeDir, '.claude')];
    return candidates.filter(isRoot);
}

/**
 * The identity file's position depends on how the root was configured:
 * INSIDE when CLAUDE_CONFIG_DIR is set, ADJACENT in the default layout.
 * Verified against Claude Code 2.1.263. Both must be tried.
 */
export function readAccountForRoot(root: string): ClaudeAccount | null {
    const candidates = [
        path.join(root, '.claude.json'),
        path.join(path.dirname(root), '.claude.json'),
    ];

    for (const file of candidates) {
        let parsed: any;
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); }
        catch { continue; }

        const o = parsed?.oauthAccount;
        // A valid root may legitimately have no oauthAccount — it is written on
        // login, not on init. Not an error, and must not log as one.
        if (!o?.emailAddress || !o?.accountUuid) continue;

        return {
            email: o.emailAddress,
            accountUuid: o.accountUuid,
            organizationUuid: o.organizationUuid,
            seatTier: o.seatTier,
            accountCreatedAt: o.accountCreatedAt,
            root,
        };
    }
    return null;
}

export function discoverClaudeAccounts(): ClaudeAccount[] {
    const byUuid = new Map<string, ClaudeAccount>();
    for (const root of discoverClaudeRoots()) {
        const acct = readAccountForRoot(root);
        if (acct && !byUuid.has(acct.accountUuid)) byUuid.set(acct.accountUuid, acct);
    }
    return [...byUuid.values()];
}
