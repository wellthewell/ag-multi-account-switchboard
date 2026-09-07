/**
 * Disk cache management for usage stats.
 * Handles read/write persistence and synchronous cache loading.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DeepUsageStats } from '../../types';
import {
    CACHE_SCHEMA_VERSION,
    DiskCacheData,
    ConvoTokenData,
    entryFingerprint,
    mergePreferredEntry,
} from './types';
import { aggregateFromPerConvo } from './aggregator';
import { createLogger } from '../../utils/logger';

const log = createLogger('StatsCache');

/**
 * v2 → v3 is additive: v3 only introduces the optional TokenEntry.accountKey,
 * which the Claude reader writes and pins resolve for everything older. So this
 * stamps the version and touches nothing else.
 *
 * It exists at all because read() returns null on a version mismatch, and a
 * rebuild would permanently destroy `claude-code-imported` — 12.94B tokens with
 * no source files to re-read.
 */
export function migrateV2ToV3(data: DiskCacheData): DiskCacheData {
    return { ...data, schemaVersion: 3 };
}

/**
 * The cache is a ledger, not a mirror of disk.
 *
 * A conversation present on disk is replaced by its fresh read — the file is
 * the truth for it, and callers only pass a fresh read that succeeded in full.
 * A conversation with no backing file keeps whatever it already had: that
 * covers the synthetic Claude Code import, which exists only here, and any
 * conversation the user deletes from Antigravity later.
 */
export function mergeIntoLedger(
    existing: Record<string, ConvoTokenData>,
    fresh: Record<string, ConvoTokenData>,
    presentIds: Set<string>,
): Record<string, ConvoTokenData> {
    const out: Record<string, ConvoTokenData> = {};
    for (const [cid, data] of Object.entries(existing)) {
        if (!presentIds.has(cid)) out[cid] = data;   // no file — preserve verbatim
    }
    for (const [cid, data] of Object.entries(fresh)) out[cid] = data;
    for (const [cid, data] of Object.entries(existing)) {
        if (!out[cid]) out[cid] = data;              // present but not re-read this pass
    }
    return out;
}

/**
 * What the file at `filePath` is, right now.
 *
 * `absent` — no file. A first-ever cold boot; writing is correct.
 * `ok`     — read() would return data.
 * `unreadable` — a file IS there and read() rejects it: unparseable, missing a
 *                top-level field, or a schemaVersion this build does not
 *                accept. Writing over it destroys whatever it holds, which on
 *                a real machine includes `claude-code-imported` — 12.94B
 *                tokens, hand-imported, with no source files anywhere.
 */
export type CacheState = 'absent' | 'ok' | 'unreadable';

export class StatsCache {
    /**
     * One backup per StatsCache instance. A refusal repeats on every refresh
     * pass (every ~60 s); the copy must not.
     */
    private backupTaken = false;

    /** Path to the disk cache file */
    get filePath(): string {
        return path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '.deep_stats_cache.json');
    }

    /**
     * Single decoder for what is on disk — the ONLY place the accept/reject
     * rules live, so `read()` and `probe()` can never drift apart. Drift is not
     * hypothetical here: a probe that accepted a file read() rejects would
     * re-open the exact archive-destruction hole this exists to close.
     */
    private load(): { state: CacheState; data: DiskCacheData | null } {
        try {
            if (!fs.existsSync(this.filePath)) return { state: 'absent', data: null };
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            let data = JSON.parse(raw) as DiskCacheData;
            if (!data.perConvo || !data.fetchedIds || !data.stats) return { state: 'unreadable', data: null };
            if (data.schemaVersion === 2) {
                log.info('Cache read: migrating v2 -> v3 in place (archive preserved)');
                data = migrateV2ToV3(data);
            }
            if (data.schemaVersion !== CACHE_SCHEMA_VERSION) {
                log.info(`Cache read: ignoring schema v${data.schemaVersion ?? 1}; rebuild required for v${CACHE_SCHEMA_VERSION}`);
                return { state: 'unreadable', data: null };
            }
            return { state: 'ok', data };
        } catch { /* expected: cache file may be corrupted; a file that exists but cannot be decoded is never 'absent' */
            return { state: 'unreadable', data: null };
        }
    }

    /**
     * Classify the file on disk without consuming it. Cheap enough to call on
     * every write (one parse; writes happen about once a minute) and
     * deliberately NOT sticky — deleting or repairing the file recovers the
     * extension without a restart.
     */
    probe(): CacheState {
        return this.load().state;
    }

    /**
     * Preserve a rejected file before anything can overwrite it, and say so
     * loudly. This is the only mechanical enforcement of the spec's §15 "take a
     * copy of .deep_stats_cache.json before the first v3 write" instruction,
     * which is otherwise addressed to a human and enforced by nothing. It turns
     * every remaining variant of the archive-destruction bug from terminal into
     * recoverable.
     *
     * ISO with `:` replaced by `-`: colons are legal on POSIX but hostile in
     * Finder and illegal on Windows, and this file is the last copy of data
     * that cannot be regenerated — it must be trivially movable.
     */
    private preserveRejected(): void {
        if (this.backupTaken) return;
        this.backupTaken = true;   // set before the attempt: never retry-loop on a failing copy
        const stamp = new Date().toISOString().replace(/:/g, '-');
        const dest = this.filePath.replace(/\.json$/, '') + `.rejected-${stamp}.json`;
        try {
            fs.copyFileSync(this.filePath, dest);
            log.warn(
                `Usage cache REJECTED (unreadable, or a schemaVersion this build does not accept). `
                + `A copy of it was preserved at ${dest}. No writes will happen until the file at `
                + `${this.filePath} is repaired or removed — this is deliberate: overwriting it would `
                + `destroy the hand-imported claude-code-imported archive, which has no other copy. `
                + `If you just updated the extension, reload every open window and retry.`,
            );
        } catch (e: any) {
            log.warn(
                `Usage cache REJECTED and the preservation copy FAILED (${e?.message}). `
                + `Still refusing every write to ${this.filePath}; nothing was overwritten.`,
            );
        }
    }

    /** Read cached data from disk. Returns null if missing or corrupted. */
    read(): DiskCacheData | null {
        const { state, data } = this.load();
        if (state === 'unreadable') { this.preserveRejected(); return null; }
        if (!data) return null;
        try {
            // Sanitize: remove duplicate entries that may have been persisted
            // by older versions with the RPC pagination overlap bug.
            let totalRemoved = 0;
            for (const cid of Object.keys(data.perConvo)) {
                const entries = data.perConvo[cid].entries;
                if (!entries || entries.length === 0) continue;
                const byFingerprint = new Map<string, typeof entries[number]>();
                for (const e of entries) {
                    const fp = entryFingerprint(e);
                    const existing = byFingerprint.get(fp);
                    byFingerprint.set(fp, existing ? mergePreferredEntry(existing, e) : e);
                }
                const clean = [...byFingerprint.values()];
                if (clean.length < entries.length) {
                    totalRemoved += entries.length - clean.length;
                    data.perConvo[cid] = { entries: clean };
                }
            }
            if (totalRemoved > 0) {
                log.info(`Cache read: sanitized ${totalRemoved} duplicate entries`);
            }

            return data;
        } catch { /* expected: a sanitizer failure on otherwise-decodable data */
            return null;
        }
    }

    /** Write stats data to disk cache. */
    write(
        perConvo: Record<string, ConvoTokenData>,
        fetchedIds: string[],
        stats: DeepUsageStats,
        titleMap: Map<string, string>,
        stepCounts?: Map<string, number>,
        entryCounts?: Record<string, { meta: number; steps: number }>,
        mtimes?: Record<string, number>,
        /** Set once by the caller when absent; never recomputed here. */
        countingChangedAt?: string,
    ): void {
        // Refusal is a property of the CACHE, not of one caller.
        //
        // write() has four callers across three refresh modes
        // (twoPhaseFullFetch twice, refreshFromStore, incrementalRefresh,
        // refreshClaudeUsage) and two of them build their merge base from an
        // empty map when read() returned null — so they would happily replace
        // a whole ledger, archive included, with a partial rebuild. Only one
        // of them ever grew a guard, and it runs LAST, by which time the file
        // is already valid again and the guard is a no-op. Checking here means
        // no caller — including one written later — can forget it.
        //
        // 'unreadable' means a file is present and read() rejects it: a parse
        // failure, a missing top-level field, or a schemaVersion this build
        // does not accept. That last case is not hypothetical on this branch:
        // CACHE_SCHEMA_VERSION went 2 -> 3, so during an extension update a
        // window running the new build writes v3 while a window still running
        // the old build reads it, gets null, and cold-boots. The old build
        // cannot be fixed from here (it has neither the migration nor this
        // refusal) — hence the CHANGELOG note telling users to reload every
        // window on upgrade — but from v3 forward this refusal is what makes a
        // rebuild-over-the-archive impossible rather than merely unlikely.
        if (this.probe() === 'unreadable') {
            this.preserveRejected();
            log.warn(`Refusing to write the usage cache: ${this.filePath} exists but cannot be decoded. `
                + `Nothing was overwritten.`);
            return;
        }
        try {
            // Serialize titleMap as plain object for JSON persistence
            const titleMapObj: Record<string, string> = {};
            for (const [k, v] of titleMap) titleMapObj[k] = v;
            const stepCountsObj: Record<string, number> = {};
            if (stepCounts) { for (const [k, v] of stepCounts) stepCountsObj[k] = v; }
            const data: DiskCacheData = {
                schemaVersion: CACHE_SCHEMA_VERSION,
                perConvo, fetchedIds, stats,
                updatedAt: new Date().toISOString(),
                titleMap: titleMapObj,
                stepCounts: stepCounts ? stepCountsObj : undefined,
                entryCounts,
                mtimes,
                countingChangedAt,
            };
            const tmp = this.filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
            fs.renameSync(tmp, this.filePath); // atomic on POSIX
            log.info(`Disk cache written: ${fetchedIds.length} conversations, ${titleMap.size} titles`);
        } catch (e: any) {
            log.warn('Failed to write disk cache:', e?.message);
        }
    }

    /**
     * Synchronous disk cache load — returns pre-aggregated stats instantly.
     * Called during refresh() to populate usage stats BEFORE the first webview render.
     * Returns null if no cache exists.
     */
    loadSync(currentTitleMap: Map<string, string>): { stats: DeepUsageStats; titleMap: Map<string, string> } | null {
        const cache = this.read();
        if (!cache) return null;

        let titleMap = currentTitleMap;

        if (cache.titleMap) {
            titleMap = new Map(Object.entries(cache.titleMap));
        }
        // Re-aggregate from raw entries so semantic fixes apply to older caches.
        // aggregateFromPerConvo never sets .health (it has no knowledge of the
        // service's own per-refresh counters) — carry the persisted snapshot
        // forward from the raw disk record instead of losing it on every
        // synchronous cold-start load, which runs before any real refresh.
        const stats = aggregateFromPerConvo(cache.perConvo, titleMap);
        if (cache.stats.health) stats.health = cache.stats.health;

        log.info(`loadSync: loaded ${cache.fetchedIds.length} conversations, titles: ${titleMap.size}`);
        return { stats, titleMap };
    }
}
