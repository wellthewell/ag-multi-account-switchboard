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
 * `stale`  — a file IS there, decodes structurally, and carries a schemaVersion
 *            this build KNOWS, has superseded, and has no migration for (see
 *            ARCHIVE_FREE_LEGACY_VERSIONS). Its contents are therefore known,
 *            not unknown: it provably cannot hold `claude-code-imported`, and
 *            what it does hold is structurally incomplete. A rebuild is the
 *            right handling — but only after a copy of it is safely on disk.
 * `unreadable` — a file IS there and its contents are UNKNOWN: unparseable,
 *                missing a top-level field, or carrying a schemaVersion ABOVE
 *                this build's (written by a newer build, whose data this build
 *                cannot interpret and must not clobber). Writing over it
 *                destroys whatever it holds, which on a real machine includes
 *                `claude-code-imported` — 12.94B tokens, hand-imported, with
 *                no source files anywhere. Every write is refused.
 */
export type CacheState = 'absent' | 'ok' | 'stale' | 'unreadable';

/**
 * Schema versions BELOW CACHE_SCHEMA_VERSION that are known, superseded, and
 * provably free of the hand-imported archive — so a rebuild over them destroys
 * nothing irreplaceable and is preferable to refusing writes forever.
 *
 * Exactly {absent, 1} today, and that is a historical fact rather than a
 * judgement call: `schemaVersion` did not exist before commit 9da46be
 * (2026-05-04), which introduced it as `2` together with the reasoning /
 * cacheWrite metrics. `claude-code-imported` was hand-imported in August 2026,
 * into a file that was already v2. A v1-format (or version-absent) file holding
 * the archive is therefore impossible, not merely unlikely. v1 data is also
 * structurally incomplete (pre-reasoning/cacheWrite), which is why this is a
 * rebuild rather than a migration.
 *
 * A version NOT in this set — including a future v2/v3 should CACHE_SCHEMA_VERSION
 * ever move past them without a migration — stays `unreadable` and keeps refusing
 * every write. That is the safe failure direction: adding a version here is a
 * deliberate assertion that files of that version cannot hold the archive.
 */
const ARCHIVE_FREE_LEGACY_VERSIONS: ReadonlySet<number> = new Set([1]);

export class StatsCache {
    /**
     * One backup ATTEMPT per StatsCache instance. A refusal repeats on every
     * refresh pass (every ~60 s); the copy must not.
     */
    private backupTaken = false;

    /**
     * Whether a preserved copy of the rejected file is actually on disk —
     * either taken by this instance, or found already there from an earlier
     * one. Distinct from `backupTaken`, which only records that an attempt was
     * made: a `stale` rebuild is permitted only when a copy genuinely EXISTS,
     * so "attempted and failed" must not read as "safe to proceed".
     */
    private backupSucceeded = false;

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
                // Two structurally different cases, deliberately split.
                //
                // A version this build KNOWS and has superseded (v1, or absent
                // — see ARCHIVE_FREE_LEGACY_VERSIONS) is `stale`: its contents
                // are known, provably archive-free, and structurally
                // incomplete, so a rebuild is correct once a copy is safe.
                // Classifying it `unreadable` — as this did until now — refused
                // every write forever, which silently switched the entire
                // Claude-tracking feature off for that user with no recovery
                // short of hand-deleting a dotfile.
                //
                // Anything else (a version ABOVE CACHE_SCHEMA_VERSION, i.e.
                // written by a NEWER build) stays `unreadable`: its contents
                // are unknown to this build and clobbering them destroys data
                // this build cannot even read, archive included.
                const version = data.schemaVersion ?? 1;
                const stale = ARCHIVE_FREE_LEGACY_VERSIONS.has(version) && version < CACHE_SCHEMA_VERSION;
                log.info(`Cache read: ignoring schema v${version}; rebuild required for v${CACHE_SCHEMA_VERSION}`);
                return { state: stale ? 'stale' : 'unreadable', data: null };
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
     *
     * Returns whether a preserved copy is actually ON DISK — freshly made here,
     * or found already there from an earlier instance. The `stale` rebuild in
     * write() is gated on exactly this: a failed copy keeps refusing, which is
     * what stops "let the rebuild proceed" from reopening the hole it closes.
     */
    private preserveRejected(state: 'stale' | 'unreadable'): boolean {
        if (this.backupTaken) return this.backupSucceeded;
        this.backupTaken = true;   // set before the attempt: never retry-loop on a failing copy

        // What follows the copy differs by state, and the user is the one who
        // has to act on it, so say which it is rather than one vague sentence.
        const consequence = state === 'stale'
            ? `This build has SUPERSEDED that schemaVersion and has no migration for it, so the ledger will be `
              + `rebuilt from source files — the copy is your fallback for anything that cannot be re-derived.`
            : `No writes will happen until the file at ${this.filePath} is repaired or removed — this is `
              + `deliberate: overwriting it would destroy the hand-imported claude-code-imported archive, which `
              + `has no other copy. If you just updated the extension, reload every open window and retry.`;

        // `backupTaken` is per-instance, i.e. per window per session, so
        // without this every window launch over a still-refused file deposited
        // another ~1.3 MB copy into ~/.gemini/antigravity/brain/. One copy of a
        // given rejected file is the whole point; the second is litter.
        const already = this.existingRejectedCopy();
        if (already) {
            this.backupSucceeded = true;
            log.warn(
                `Usage cache REJECTED (${state}). A copy of it was ALREADY preserved at ${already}; not taking `
                + `another. ${consequence}`,
            );
            return true;
        }

        const stamp = new Date().toISOString().replace(/:/g, '-');
        const dest = this.filePath.replace(/\.json$/, '') + `.rejected-${stamp}.json`;
        try {
            fs.copyFileSync(this.filePath, dest);
            this.backupSucceeded = true;
            log.warn(`Usage cache REJECTED (${state}). A copy of it was preserved at ${dest}. ${consequence}`);
        } catch (e: any) {
            log.warn(
                `Usage cache REJECTED (${state}) and the preservation copy FAILED (${e?.message}). `
                + `Still refusing every write to ${this.filePath}; nothing was overwritten.`,
            );
        }
        return this.backupSucceeded;
    }

    /**
     * The path of an existing `.rejected-*` copy of THIS cache file, if any.
     * Deliberately a directory scan rather than a remembered path: the whole
     * point is to see copies left by earlier StatsCache instances — other
     * windows, earlier sessions — which no in-memory flag can know about.
     */
    private existingRejectedCopy(): string | null {
        try {
            const dir = path.dirname(this.filePath);
            const stem = path.basename(this.filePath).replace(/\.json$/, '') + '.rejected-';
            const hit = fs.readdirSync(dir).find(f => f.startsWith(stem) && f.endsWith('.json'));
            return hit ? path.join(dir, hit) : null;
        } catch { /* expected: the directory may be unreadable or gone — treat as "no copy" */
            return null;
        }
    }

    /** Read cached data from disk. Returns null if missing or corrupted. */
    read(): DiskCacheData | null {
        const { state, data } = this.load();
        // 'stale' is handled exactly as 'unreadable' here — preserve a copy,
        // return null — so the cold-boot path rebuilds. The two states diverge
        // only in write(), which permits the rebuild for 'stale' (once the copy
        // above is confirmed on disk) and refuses it forever for 'unreadable'.
        // Taking the copy HERE also means it exists before the first write,
        // rather than being raced by it.
        if (state === 'unreadable' || state === 'stale') { this.preserveRejected(state); return null; }
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

    /**
     * Write stats data to disk cache.
     *
     * Returns `true` only when the file on disk now holds this data: `false` on
     * a refusal (see the state rules below) and `false` on a swallowed I/O
     * failure. Callers must not publish rebuilt data into their own in-memory
     * state on `false` — on a refusal the disk file is intact and the rebuilt
     * ledger is archive-less, so publishing it makes 12.94B preserved tokens
     * look lost.
     */
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
    ): boolean {
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
        //
        // Returns whether anything was actually persisted, so a caller cannot
        // publish a rebuilt, archive-less ledger into its own in-memory state
        // (and thence the panel) off a write that never landed.
        const state = this.probe();
        if (state === 'unreadable') {
            this.preserveRejected(state);
            log.warn(`Refusing to write the usage cache: ${this.filePath} exists but cannot be decoded. `
                + `Nothing was overwritten.`);
            return false;
        }
        // 'stale' is the third case, distinct from both 'ok' and 'unreadable':
        // a KNOWN, superseded, provably archive-free schema (v1, or absent —
        // see ARCHIVE_FREE_LEGACY_VERSIONS). A rebuild over it is correct, but
        // only once a copy of it is genuinely on disk. Gating on the copy
        // SUCCEEDING is what keeps this from reopening the archive hole: a
        // failed copy falls through to the same refusal as 'unreadable'.
        //
        // This costs at most one copy, not one per write: read() has almost
        // always taken it already (preserveRejected is per-instance and
        // short-circuits), and the write below leaves the file at
        // CACHE_SCHEMA_VERSION, after which probe() returns 'ok' and this
        // branch is never reached again.
        if (state === 'stale' && !this.preserveRejected(state)) {
            log.warn(`Refusing to write the usage cache: ${this.filePath} carries a superseded schemaVersion and a `
                + `rebuild is due, but the preservation copy FAILED, so the rebuild would be unrecoverable. `
                + `Nothing was overwritten.`);
            return false;
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
            return true;
        } catch (e: any) {
            // Still swallowed, deliberately: refreshClaudeUsage's read-back
            // verification exists precisely because write() never throws, and
            // several callers rely on that. This only REPORTS the failure —
            // returning false — so a caller can decline to publish state off a
            // write that did not land. It does not start throwing.
            log.warn('Failed to write disk cache:', e?.message);
            return false;
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
