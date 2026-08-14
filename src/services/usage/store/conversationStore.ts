/**
 * Enumerates conversations across every Antigravity install root.
 *
 * Antigravity keeps data under antigravity, antigravity-ide and
 * antigravity-cli. Looking in only one means a normal install hides every
 * command-line conversation. Roots are resolved to real paths first, because
 * on a symlinked setup all three are the same directory and would otherwise
 * be scanned three times.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type StoredConversation = { id: string; dbPath: string; brainPath: string; mtimeMs: number };

const INSTALL_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const UUID_LENGTH = 36;

function realRoots(): { conversations: string; brain: string }[] {
    const seen = new Set<string>();
    const out: { conversations: string; brain: string }[] = [];
    for (const name of INSTALL_ROOTS) {
        const base = path.join(os.homedir(), '.gemini', name);
        const conversations = path.join(base, 'conversations');
        try {
            const real = fs.realpathSync(conversations);
            if (seen.has(real)) continue;
            seen.add(real);
            let brain = path.join(base, 'brain');
            try { brain = fs.realpathSync(brain); } catch { /* brain may not exist */ }
            out.push({ conversations: real, brain });
        } catch { /* root not installed */ }
    }
    return out;
}

/**
 * Newest signal for a conversation. SQLite writes land in the write-ahead log
 * first and only reach the .db at a checkpoint — a call was observed recorded
 * while the .db timestamp was 92 seconds stale, and the brain directory lagged
 * seven minutes. Taking the maximum is what makes live sessions detectable.
 *
 * Readers create the -shm sidecar, so it is not a write signal — including it
 * makes every conversation permanently dirty after its first read, turning
 * incremental refresh into a permanent full rescan. The -wal signal survives
 * because writers append to it; readers do not touch it.
 */
export function conversationFreshness(dbPath: string, brainPath: string): number {
    let newest = 0;
    for (const p of [dbPath, `${dbPath}-wal`, brainPath]) {
        try {
            const m = fs.statSync(p).mtimeMs;
            if (m > newest) newest = m;
        } catch { /* absent files simply do not contribute */ }
    }
    return newest;
}

/** Deduplicated by conversation id; when an id appears twice, newest wins. */
export function listConversations(): StoredConversation[] {
    const byId = new Map<string, StoredConversation>();
    for (const root of realRoots()) {
        let files: string[] = [];
        try { files = fs.readdirSync(root.conversations); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.db')) continue;
            const id = f.slice(0, -3);
            if (id.length !== UUID_LENGTH) continue;
            const dbPath = path.join(root.conversations, f);
            const brainPath = path.join(root.brain, id);
            const entry: StoredConversation = { id, dbPath, brainPath, mtimeMs: conversationFreshness(dbPath, brainPath) };
            const existing = byId.get(id);
            if (!existing || entry.mtimeMs > existing.mtimeMs) byId.set(id, entry);
        }
    }
    return [...byId.values()];
}
