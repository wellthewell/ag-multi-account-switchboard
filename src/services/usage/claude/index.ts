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

/**
 * `claude:<sessionId>` for a top-level transcript, or `claude:<sessionId>:<agentId>`
 * for a subagent transcript nested at `<slug>/<sessionId>/subagents/<agentId>.jsonl`
 * (a subagent run writes its own transcript there, alongside — never inside — its
 * parent's own `<sessionId>.jsonl`).
 *
 * Derived from the path segments between the project slug directory and the file
 * itself, dropping the literal `subagents` segment, rather than from the bare
 * filename: two different sessions can each spawn an agent that happens to reuse
 * the same agent id, and a basename-only id would collapse both onto one ledger
 * key. The id is pure path arithmetic — no file content, no timestamp — so it
 * stays stable across runs, which matters because it doubles as the mtime cache
 * key: an id that changed between runs would re-parse that file forever.
 */
export function ledgerIdFor(transcriptPath: string): string {
    const parts = transcriptPath.split(path.sep);
    const projectsIdx = parts.lastIndexOf('projects');
    // parts[projectsIdx] = 'projects', parts[projectsIdx + 1] = the slug (not
    // part of the id), so there must be at least one more segment (the file)
    // after that for this to be a well-formed transcript path.
    if (projectsIdx === -1 || projectsIdx + 2 >= parts.length) {
        // Layout is not what discoverClaudeTranscripts produces — fall back to
        // the bare filename rather than throwing.
        return `claude:${path.basename(transcriptPath, '.jsonl')}`;
    }
    const afterSlug = parts.slice(projectsIdx + 2).filter((seg) => seg !== 'subagents');
    afterSlug[afterSlug.length - 1] = afterSlug[afterSlug.length - 1].replace(/\.jsonl$/, '');
    return `claude:${afterSlug.join(':')}`;
}

/** Depth-first collection of every `.jsonl` file under `dir`. A plain synchronous
 *  walk: `Dirent.isDirectory()` (from `readdirSync`'s own dirents) reflects an
 *  `lstat`, not a `stat`, so it never reports true for a symlink — this walk
 *  simply never descends into one, which rules out a symlink cycle for free
 *  without any cycle-tracking of its own. */
function collectJsonlFiles(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectJsonlFiles(full, out);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            out.push(full);
        }
    }
}

export function discoverClaudeTranscripts(roots: string[] = discoverClaudeRoots()): string[] {
    const out: string[] = [];
    for (const root of roots) {
        const projects = path.join(root, 'projects');
        let slugs: string[];
        try { slugs = fs.readdirSync(projects); } catch { continue; }
        for (const slug of slugs) {
            // Transcripts live at any depth beneath a slug directory, not just
            // directly inside it: a subagent run writes its own transcript to
            // <slug>/<sessionId>/subagents/<agentId>.jsonl, three levels down.
            collectJsonlFiles(path.join(projects, slug), out);
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
