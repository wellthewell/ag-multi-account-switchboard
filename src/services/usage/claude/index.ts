/**
 * Claude usage ingestion — filesystem only.
 *
 * Deliberately has no ServerInfo dependency: unlike the Antigravity store path,
 * this works with no language server running.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConvoTokenData, TokenEntry } from '../types';
import { readClaudeTranscript } from './claudeReader';
import { discoverClaudeRoots, readAccountForRoot } from './claudeAccounts';

export interface IngestOptions {
    /** Override roots (tests). Defaults to discovered roots. */
    roots?: string[];
    /** Previously recorded mtimes, keyed by ledger id. Unchanged files are skipped. */
    mtimes?: Record<string, number>;
}

export interface IngestResult {
    perConvo: Record<string, ConvoTokenData>;
    mtimes: Record<string, number>;
    ids: string[];
}

/** `claude:<sessionId>` — the prefix keeps Claude and Antigravity id spaces disjoint. */
export function ledgerIdFor(transcriptPath: string): string {
    return `claude:${path.basename(transcriptPath, '.jsonl')}`;
}

export function discoverClaudeTranscripts(roots: string[] = discoverClaudeRoots()): string[] {
    const out: string[] = [];
    for (const root of roots) {
        const projects = path.join(root, 'projects');
        let slugs: string[];
        try { slugs = fs.readdirSync(projects); } catch { continue; }
        for (const slug of slugs) {
            const dir = path.join(projects, slug);
            let files: string[];
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
            }
        }
    }
    return out;
}

export async function ingestClaudeUsage(opts: IngestOptions = {}): Promise<IngestResult> {
    const roots = opts.roots ?? discoverClaudeRoots();
    const known = opts.mtimes ?? {};

    // The active account stamps rows read now. Everything older is resolved by
    // claudePins at aggregation time.
    const activeKey = roots
        .map(readAccountForRoot)
        .find((a) => a)?.accountUuid;

    const perConvo: Record<string, ConvoTokenData> = {};
    const mtimes: Record<string, number> = {};
    const ids: string[] = [];

    for (const file of discoverClaudeTranscripts(roots)) {
        const id = ledgerIdFor(file);
        ids.push(id);

        let mtime: number;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        mtimes[id] = mtime;

        if (known[id] === mtime) continue;   // unchanged, skip the parse

        const entries: TokenEntry[] = await readClaudeTranscript(file);
        if (entries.length === 0) continue;

        if (activeKey) for (const e of entries) e.accountKey = activeKey;
        perConvo[id] = { entries };
    }

    return { perConvo, mtimes, ids };
}
