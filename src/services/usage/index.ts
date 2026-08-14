/**
 * UsageStatsService — orchestrates token usage statistics from the Antigravity
 * Language Server's cascade trajectory endpoints.
 *
 * Data flow:
 * 1. Scan ~/.gemini/antigravity/brain/ for conversation UUIDs
 * 2. Fetch metadata for each via parallel batched API calls
 * 3. Aggregate into daily/hourly/model/cascade breakdowns
 *
 * Delegates to:
 * - aggregator.ts — pure aggregation functions
 * - cache.ts — disk cache persistence
 * - types.ts — shared types and constants
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ServerInfo, DeepUsageStats } from '../../types';
import { RpcDirectClient } from '../rpcDirectClient';
import { callLsJson } from '../../utils/lsClient';
import { createLogger } from '../../utils/logger';
import {
    ConvoTokenData, DiskCacheData, TokenEntry,
    EP, BATCH_CONCURRENCY, HOT_THRESHOLD_MS, FETCH_TIMEOUT_MS,
    entryFingerprint, mergePreferredEntry, isConvoDirty,
} from './types';
import { aggregateFromPerConvo, extractTokens } from './aggregator';
import { StatsCache, mergeIntoLedger } from './cache';
import { ProcessLock } from './processLock';
import { getGlobalIndexData } from '../../shared/titleResolver';
import { BRAIN_DIR, CONVERSATIONS_DIR } from '../../shared/agPaths';
import { gridMode } from '../../shared/helpers';
import { concurrentPool } from './pool';
import { listConversations } from './store/conversationStore';
import { readConversationUsage } from './store/usageReader';
import { verifyConversation } from './store/verifier';
import { isUnknownEnumName } from './store/enumMap';
import type { UsageHealth } from '../../shared/usage-components';

const log = createLogger('UsageStats');

export class UsageStatsService {

    /** Memory cache for deep stats (expensive to compute) */
    private deepStatsCache: DeepUsageStats | null = null;

    /** In-memory per-convo data — available during progressive fetch before disk cache exists */
    private currentPerConvo: Record<string, ConvoTokenData> = {};
    private currentTitleMap: Map<string, string> = new Map();
    private currentStepCounts: Map<string, number> = new Map();

    /** Raw (pre-dedup) meta/steps counts per conversation — for correct offset-based delta */
    private rawFetchCounts: Record<string, { meta: number; steps: number }> = {};

    /** Surfaced by the health card. */
    public lastVerification: { compared: number; diverged: number; at: string } | null = null;

    /**
     * Snapshot of what fed the last store-path refresh — attached onto the
     * DeepUsageStats object returned to callers (see refreshFromStore and
     * getFilteredStats) rather than exposed as a separate channel, since the
     * panel and sidebar already receive DeepUsageStats and nothing else.
     */
    private lastHealth: UsageHealth | null = null;

    private readonly cache = new StatsCache();
    private readonly processLock = new ProcessLock();

    // ═══════════════════════════════════════════
    //  Deep Stats (All-Time, All Conversations)
    // ═══════════════════════════════════════════

    async fetchDeepStats(
        serverInfo: ServerInfo,
        forceRefresh = false,
        /** Called when background backfill completes with updated stats */
        onBackfillComplete?: (stats: DeepUsageStats) => void,
        /** Called during scan with (done, total) for progress UI */
        onProgress?: (done: number, total: number) => void,
    ): Promise<DeepUsageStats | null> {
        log.diag(`fetchDeepStats: port=${serverInfo.port} forceRefresh=${forceRefresh} memCache=${!!this.deepStatsCache}`);

        // 1. Instant return from memory cache (fastest) — skip if forceRefresh
        if (this.deepStatsCache && !forceRefresh) {

            return this.deepStatsCache;
        }

        // 2. Try disk cache + incremental refresh (picks up new conversations)
        const diskCache = this.cache.read();
        if (diskCache) {
            this.deepStatsCache = diskCache.stats;
            log.diag(`fetchDeepStats: disk cache hit — ${diskCache.fetchedIds.length} conversations`);

            // Cross-process lock: only 1 window fetches, others read cache only
            if (!this.processLock.acquire()) {

                return this.deepStatsCache;
            }
            try {

                const updated = this.useServerSource()
                    ? await this.incrementalRefresh(serverInfo, diskCache).catch((e: any) => {
                        log.warn('fetchDeepStats: incrementalRefresh threw:', e?.message);
                        return false;
                    })
                    : !!(await this.refreshFromStore(serverInfo, diskCache).catch((e: any) => {
                        log.warn('fetchDeepStats: refreshFromStore threw:', e?.message);
                        return null;
                    }));

                if (updated && onBackfillComplete) onBackfillComplete(this.deepStatsCache!);
            } finally {
                this.processLock.release();
            }

            return this.deepStatsCache;
        }

        // 3. Two-phase fetch (first time only — no disk cache exists)
        log.diag('fetchDeepStats: no disk cache — cold two-phase fetch');
        //    Lock guard: only 1 window does the expensive cold boot
        if (!this.processLock.acquire()) {
            log.diag('fetchDeepStats: lock held by another instance — returning null');
            return null;
        }
        try {
            return this.useServerSource()
                ? await this.twoPhaseFullFetch(serverInfo, onBackfillComplete, onProgress)
                : await this.refreshFromStore(serverInfo, null);
        } finally {
            this.processLock.release();
        }
    }

    /**
     * Whether usage should come from the language server instead of the
     * conversation store. Store-read ('auto') is the default; 'server' is a
     * temporary rollback for the case where the store path diverges from the
     * server's numbers, kept only until the store path has run a release
     * without divergence. Defaults to false (store) if vscode is unavailable,
     * e.g. when this module is required by a plain-node script.
     */
    private useServerSource(): boolean {
        try {
            const vscode = require('vscode');
            return vscode.workspace.getConfiguration('ag-switchboard').get('usageSource') === 'server';
        } catch { return false; }
    }

    /**
     * Two-phase full fetch:
     * Phase 1: Fetch recent conversations (mtime < 48h) → return immediately for 24h view
     * Phase 2: Backfill remaining conversations in background → notify via callback
     */
    private async twoPhaseFullFetch(
        serverInfo: ServerInfo,
        onBackfillComplete?: (stats: DeepUsageStats) => void,
        onProgress?: (done: number, total: number) => void,
    ): Promise<DeepUsageStats | null> {
        try {
            this.rawFetchCounts = {};
            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');


            const allIds = this.discoverConversationIds();

            if (allIds.length === 0) {
                log.warn('twoPhaseFullFetch: NO conversations found on disk — check brain dir exists and contains UUID folders');
                const emptyStats = aggregateFromPerConvo({}, new Map());
                this.deepStatsCache = emptyStats;
                if (onBackfillComplete) onBackfillComplete(emptyStats);
                return emptyStats;
            }

            // Stat before fetching — see convoMtimes() and incrementalRefresh()
            const mtimes = this.convoMtimes(allIds);

            // Split into HOT (recent 48h) and COLD
            const cutoffMs = Date.now() - HOT_THRESHOLD_MS;
            const { hot, cold } = this.partitionByMtime(allIds, cutoffMs);
            log.diag(`twoPhaseFullFetch: ${hot.length} hot + ${cold.length} cold = ${allIds.length} total`);

            // Phase 1: Fetch HOT conversations + trajectory summaries (titles + stepCounts)

            const [summaries, hotData] = await Promise.all([
                this.fetchTrajectorySummaries(serverInfo),
                this.fetchConversationData(serverInfo, hot, onProgress ? (d) => onProgress(d, allIds.length) : undefined),
            ]);

            log.diag(`twoPhaseFullFetch: Phase 1 API done — titleMap=${summaries.titleMap.size} titles, stepCounts=${summaries.stepCounts.size}, hotData=${Object.keys(hotData).length} convos with data`);

            this.currentTitleMap = summaries.titleMap;
            this.currentStepCounts = summaries.stepCounts;
            this.currentPerConvo = { ...hotData };

            const hotStats = aggregateFromPerConvo(hotData, summaries.titleMap);
            this.deepStatsCache = hotStats;
            log.diag(`twoPhaseFullFetch: Phase 1 aggregated — totalCalls=${hotStats.totalCalls} totalTokens=${hotStats.totalTokens} from ${hot.length} hot convos`);

            // If no cold conversations, write final cache and return
            if (cold.length === 0) {
                log.diag('twoPhaseFullFetch: no cold conversations — writing cache and returning Phase 1 result');
                const entryCounts = this.buildEntryCounts();
                this.cache.write(hotData, allIds, hotStats, summaries.titleMap, summaries.stepCounts, entryCounts, mtimes);
                return hotStats;
            }

            // Phase 2: Fetch COLD conversations inline (not background).
            // Returning partial Phase 1 data caused flip-flop ($3 → $177 → $203).
            // Await full result so the UI transitions once: loading → correct data.

            const hotDone = hot.length;
            const coldData = await this.fetchConversationData(serverInfo, cold, onProgress ? (d) => onProgress(hotDone + d, allIds.length) : undefined);
            log.diag(`twoPhaseFullFetch: Phase 2 API done — coldData=${Object.keys(coldData).length} convos with data`);

            const merged = { ...hotData, ...coldData };
            this.currentPerConvo = merged;

            const fullStats = aggregateFromPerConvo(merged, summaries.titleMap);
            this.deepStatsCache = fullStats;

            // Build entryCounts for offset-based delta on next incremental
            const entryCounts = this.buildEntryCounts();
            this.cache.write(merged, allIds, fullStats, summaries.titleMap, summaries.stepCounts, entryCounts, mtimes);
            log.info(`twoPhaseFullFetch: done — ${fullStats.totalCalls} calls, ${Object.keys(merged).length} convos`);

            if (onBackfillComplete) onBackfillComplete(fullStats);
            return fullStats;

        } catch (e: any) {
            log.warn('twoPhaseFullFetch: FAILED with error:', e?.message);
            log.warn('twoPhaseFullFetch: stack:', e?.stack?.split('\n').slice(0, 5).join(' | '));
            return null;
        }
    }

    /**
     * Refresh usage from the conversation store.
     *
     * Replaces the language-server fetch as the data path. The server only
     * serves conversations that existed when it started, so anything the agy
     * command-line client creates afterwards is permanently invisible to it.
     */
    private async refreshFromStore(serverInfo: ServerInfo, diskCache: DiskCacheData | null): Promise<DeepUsageStats | null> {
        const conversations = listConversations();
        if (conversations.length === 0) {
            log.warn('refreshFromStore: no conversations found in any install root');
            return this.deepStatsCache;
        }

        const cachedMtimes = diskCache?.mtimes || {};
        const cachedPerConvo = diskCache?.perConvo || {};
        const presentIds = new Set(conversations.map(c => c.id));

        // A conversation sitting at zero entries is retried unconditionally, but
        // ONLY on the first store-mode pass — this must stay a one-shot sweep,
        // never a permanent rule. That first sweep is what recovers conversations
        // stranded by the previous server-only path (their entries never got
        // backfilled because that path could not see them at all — a real
        // machine measured 27 of 108 conversations sitting at zero entries this
        // way). Once recovery has happened, a zero-entry conversation is
        // trusted: it genuinely has no model calls, not one the old path
        // missed. Without the one-shot gate, those 27 get re-read, re-aggregated
        // (~4,400 entries), and rewritten to an atomic 1.1MB cache on every
        // 60-second poll, forever — the exact "disk write rate unchanged"
        // regression this plan exists to avoid, and it also makes the
        // dirty.length===0 early-return path below unreachable in practice.
        //
        // Gated on countingChangedAt rather than deleted outright or keyed on
        // `cachedMtimes[c.id] === undefined`:
        //   - Deleting it outright silently stops recovering the conversations
        //     this whole plan was built to recover.
        //   - Keying it on mtime-absence is the same mistake wearing a
        //     different hat: conversations stranded by the old server path
        //     already have a recorded mtime (that path tracked mtimes, it just
        //     never read the entries behind them), so mtime-absence would skip
        //     precisely the conversations that need recovering.
        // countingChangedAt is unset before the first store-mode pass and
        // written by it (see below), and incrementalRefresh (the 'server'-mode
        // path) only ever forwards whatever value it read, never mints its own
        // — so a user who has been on usageSource:'server' the whole time still
        // gets exactly one recovery sweep the moment they switch to 'store'. A
        // brand-new, never-before-seen conversation is still read once
        // regardless of this gate: it is absent from cachedMtimes, and
        // `?? 0` makes it dirty either way.
        //
        // Do NOT delete this gate and do NOT key it on mtime-absence — either
        // change silently undoes the recovery this comment exists to protect.
        const firstStorePass = !diskCache?.countingChangedAt;
        const dirty = conversations.filter(c => {
            const hasEntries = !!cachedPerConvo[c.id]?.entries?.length;
            if (!hasEntries && firstStorePass) return true;
            return c.mtimeMs > (cachedMtimes[c.id] ?? 0);
        });

        log.info(`refreshFromStore: ${dirty.length} of ${conversations.length} conversations to read`);

        // Nothing changed since the last pass. incrementalRefresh returns false in
        // the same situation specifically to suppress a redundant onBackfillComplete
        // — mirror that here instead of re-aggregating and rewriting an identical
        // cache. this.deepStatsCache is left exactly as the caller already set it.
        if (dirty.length === 0) {
            // This is the common case, not an edge case — a quick reload or a
            // second window with nothing new — so the health card must not go
            // dark here. No new read happened, so unreadable/skippedRows are 0
            // (not carried forward: both are documented as "this pass", and no
            // pass ran); unknownModels comes from the stats already on disk,
            // which are still current since nothing changed. No cache.write
            // happens on this path, so countingChangedAt is carried forward
            // as-is rather than fabricated — a fresh value here would never
            // be persisted and would silently drift on every such reload.
            this.lastHealth = {
                source: 'store',
                conversations: conversations.length,
                unreadable: 0,
                unknownModels: (diskCache?.stats?.models || []).filter(m => isUnknownEnumName(m.displayName)).map(m => m.displayName),
                skippedRows: 0,
                verification: this.lastVerification,
                countingChangedAt: diskCache?.countingChangedAt || null,
            };
            if (this.deepStatsCache) this.deepStatsCache.health = this.lastHealth;
            return null;
        }

        const fresh: Record<string, ConvoTokenData> = {};
        const mtimes: Record<string, number> = { ...cachedMtimes };
        let failed = 0;
        let skippedRows = 0;
        for (const c of dirty) {
            // Freshness comes from what listConversations() already captured, not a
            // fresh stat taken after the read. A session that writes mid-read would
            // otherwise end up with a newer mtime recorded than the data actually
            // captured, and that gap would never be picked up on a later pass.
            const before = c.mtimeMs;
            const result = await readConversationUsage(c.dbPath);
            // null means the read failed outright — never "no usage". Recording a
            // failed read's mtime would freeze this conversation forever: the dirty
            // check above only retries on a zero-entry conversation or an mtime
            // advance, and a recorded mtime satisfies both. Skipping leaves the old
            // mtime in place so the next pass retries it.
            if (result === null) { failed++; continue; }
            fresh[c.id] = { entries: result.entries };
            mtimes[c.id] = before;
            skippedRows += result.skipped;
        }
        if (failed > 0) log.warn(`refreshFromStore: ${failed} conversations unreadable this pass; will retry`);

        // fresh is built only from ids in `dirty`, which is filtered from `conversations`
        // (i.e. listConversations()'s output) — so its keys are always a subset of
        // presentIds. mergeIntoLedger trusts that invariant rather than checking it.
        const merged = mergeIntoLedger(cachedPerConvo, fresh, presentIds);

        // The server still owns titles; only usage moved to the store. It tolerates
        // being unreachable, so this cannot reintroduce the dependency the store
        // path exists to remove.
        const summaries = await this.fetchTrajectorySummaries(serverInfo).catch(() => null);
        if (summaries) {
            this.currentTitleMap = summaries.titleMap;
            this.currentStepCounts = summaries.stepCounts;
        }

        const titleMap = this.currentTitleMap.size > 0
            ? this.currentTitleMap
            : new Map<string, string>(Object.entries(diskCache?.titleMap || {}));
        const stats = aggregateFromPerConvo(merged, titleMap);

        // Recorded once, on first sight, and threaded through every subsequent
        // write. Rewriting it on every refresh would erase the very thing it
        // exists to say: when counting changed, not "as of the last refresh".
        // A cold boot with no prior cache at all (diskCache is null) has no
        // "before" to compare against — stamping "now" there would tell a
        // first-ever user counting changed relative to a history they never
        // had. Only stamp it once an actual pre-existing cache was loaded and
        // found to be missing the field.
        const countingChangedAt: string | null = diskCache
            ? (diskCache.countingChangedAt || new Date().toISOString())
            : null;

        // Snapshot of what fed this pass, attached onto the stats object itself
        // (see DeepUsageStats.health) BEFORE cache.write, not after — write()
        // serializes synchronously via JSON.stringify, so assigning .health
        // any later would leave the persisted copy permanently one snapshot
        // behind, and every subsequent process start would load stats with no
        // .health at all.
        this.lastHealth = {
            source: 'store',
            conversations: Object.keys(merged).length,
            unreadable: failed,
            unknownModels: stats.models.filter(m => isUnknownEnumName(m.displayName)).map(m => m.displayName),
            skippedRows,
            verification: this.lastVerification,
            countingChangedAt,
        };
        stats.health = this.lastHealth;

        this.deepStatsCache = stats;
        this.currentPerConvo = merged;
        this.cache.write(merged, Object.keys(merged), stats, titleMap,
            this.currentStepCounts, diskCache?.entryCounts, mtimes, countingChangedAt ?? undefined);
        log.info(`refreshFromStore: complete — ${stats.totalCalls} calls across ${Object.keys(merged).length} conversations`);

        // Non-blocking: compare a few conversations the server can still serve.
        void (async () => {
            let compared = 0, diverged = 0;
            for (const c of conversations.slice(0, 5)) {
                const r = await verifyConversation(serverInfo, c.id, c.dbPath).catch(() => null);
                if (!r) continue;
                compared += r.compared; diverged += r.divergences.length;
            }
            this.lastVerification = { compared, diverged, at: new Date().toISOString() };
            if (diverged > 0) log.warn(`verifier: ${diverged} divergences across ${compared} compared calls`);
        })();

        return stats;
    }

    /**
     * Partition conversation IDs into hot (mtime > cutoff) and cold.
     */
    private partitionByMtime(ids: string[], cutoffMs: number): { hot: string[]; cold: string[] } {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        const hot: string[] = [];
        const cold: string[] = [];
        for (const cid of ids) {
            try {
                const stat = fs.statSync(path.join(brainDir, cid));
                if (stat.mtimeMs > cutoffMs) {
                    hot.push(cid);
                } else {
                    cold.push(cid);
                }
            } catch { // EXPECTED: directory deleted between readdir and stat — treat as hot
                // Can't stat → treat as hot (fetch it)
                hot.push(cid);
            }
        }
        return { hot, cold };
    }

    /**
     * Newest on-disk mtime per conversation: max(brain dir, conversations/<id>.db).
     *
     * The LS only *lists* trajectories it has loaded, so `GetAllCascadeTrajectories`
     * is blind to conversations created by the agy CLI — their stepCount reads 0
     * forever and stepCount-delta detection never marks them dirty. Disk mtime sees
     * them because both stores are on disk regardless of who wrote them.
     */
    private convoMtimes(ids: string[]): Record<string, number> {
        const out: Record<string, number> = {};
        for (const cid of ids) {
            let newest = 0;
            for (const p of [path.join(BRAIN_DIR, cid), path.join(CONVERSATIONS_DIR, `${cid}.db`)]) {
                try {
                    const m = fs.statSync(p).mtimeMs;
                    if (m > newest) newest = m;
                } catch { /* expected: .db absent for IDE-only convos, or dir removed mid-scan */ }
            }
            if (newest > 0) out[cid] = newest;
        }
        return out;
    }

    /**
     * Incremental refresh — fetches NEW conversations + re-fetches MODIFIED ones.
     * Uses filesystem mtime to detect conversations that changed since last cache update.
     */
    private async incrementalRefresh(serverInfo: ServerInfo, diskCache: DiskCacheData): Promise<boolean> {
        try {
            this.rawFetchCounts = {};
            const allIds = this.discoverConversationIds();
            const cachedSet = new Set(diskCache.fetchedIds);
            log.diag(`incrementalRefresh: disk has ${allIds.length} convos, cache has ${cachedSet.size} fetched IDs`);

            // 1. NEW conversations (not in cache at all)
            const newIds = allIds.filter(id => !cachedSet.has(id));
            log.diag(`incrementalRefresh: ${newIds.length} new conversations not in cache`);

            // 2. CHANGED conversations — stepCount delta OR disk mtime delta.
            //    stepCount is precise but only covers convos the LS has loaded (IDE
            //    sessions); mtime is the fallback that catches agy CLI sessions, which
            //    the LS never lists. Stat BEFORE fetching so a session still writing
            //    doesn't get a newer mtime recorded than the data we actually read.
            const currentMtimes = this.convoMtimes(allIds);

            const summaries = await this.fetchTrajectorySummaries(serverInfo);
            this.currentTitleMap = summaries.titleMap;
            this.currentStepCounts = summaries.stepCounts;

            const cachedStepCounts = diskCache.stepCounts || {};
            const cachedMtimes = diskCache.mtimes || {};
            const changedIds = allIds.filter(id => {
                if (!cachedSet.has(id)) return false; // already in newIds
                return isConvoDirty({
                    stepCount: summaries.stepCounts.get(id) ?? 0,
                    cachedStepCount: cachedStepCounts[id] ?? 0,
                    mtime: currentMtimes[id] ?? 0,
                    cachedMtime: cachedMtimes[id],
                    hasEntries: !!diskCache.perConvo[id]?.entries?.length,
                });
            });
            log.diag(`incrementalRefresh: ${changedIds.length} conversations changed (stepCount or mtime delta)`);

            const dirtyIds = [...new Set([...newIds, ...changedIds])];

            if (dirtyIds.length === 0) {
                log.info('incrementalRefresh: nothing to fetch — all conversations up to date');
                // Same reasoning as refreshFromStore's mirror-image early return:
                // this is the common case, not an edge case, and must not leave
                // the card either dark or showing a stale 'store' source/verification
                // superimposed on data this path is now serving. verification is
                // hardcoded null, never this.lastVerification — this path runs no
                // verifier at all, and carrying forward a prior store-mode result
                // would be exactly the false confidence Important 2 flagged.
                this.lastHealth = {
                    source: 'server',
                    conversations: diskCache.fetchedIds.length,
                    unreadable: 0,
                    unknownModels: (diskCache.stats?.models || []).filter(m => isUnknownEnumName(m.displayName)).map(m => m.displayName),
                    skippedRows: 0,
                    verification: null,
                    countingChangedAt: diskCache.countingChangedAt || null,
                };
                if (this.deepStatsCache) this.deepStatsCache.health = this.lastHealth;
                return false;
            }

            // Build offset map for changed conversations (new ones start at 0)
            const cachedEntryCounts = diskCache.entryCounts || {};
            const offsetMap = new Map<string, { meta: number; steps: number }>();
            for (const cid of changedIds) {
                const cached = cachedEntryCounts[cid];
                // Zero cached entries means the previous fetch produced nothing usable —
                // re-read from offset 0 instead of skipping past rows we never kept.
                if (cached && diskCache.perConvo[cid]?.entries?.length) offsetMap.set(cid, cached);
            }

            log.info(`incrementalRefresh: fetching ${dirtyIds.length} dirty (${newIds.length} new + ${changedIds.length} changed)`);

            const deltaCount = [...offsetMap.values()].filter(v => v.meta > 0 || v.steps > 0).length;
            log.info(`Deep stats: incremental fetch — ${newIds.length} new, ${changedIds.length} changed (${deltaCount} offset-based delta)`);

            const freshData = await this.fetchConversationData(serverInfo, dirtyIds, undefined, offsetMap);

            // ADDITIVE merge: never delete entries, only add new unique ones.
            // Prevents flip-flop when steps endpoint sporadically returns empty.
            const merged = { ...diskCache.perConvo };
            for (const [cid, fresh] of Object.entries(freshData)) {
                const existing = merged[cid];
                if (!existing) {
                    merged[cid] = fresh;
                } else {
                    const byFingerprint = new Map<string, TokenEntry>();
                    for (const e of existing.entries) {
                        byFingerprint.set(entryFingerprint(e), e);
                    }
                    let changed = false;
                    for (const e of fresh.entries) {
                        const fp = entryFingerprint(e);
                        const previous = byFingerprint.get(fp);
                        const next = previous ? mergePreferredEntry(previous, e) : e;
                        if (!previous || next !== previous) changed = true;
                        byFingerprint.set(fp, next);
                    }
                    if (changed) {
                        merged[cid] = { entries: [...byFingerprint.values()] };
                    }
                }
            }
            const mergedIds = [...new Set([...diskCache.fetchedIds, ...newIds])];

            // Build entryCounts from raw (pre-dedup) fetch counts.
            // Meta/steps use independent LS offsets — must NOT mix via deduped entry count.
            const entryCounts = this.buildEntryCounts(cachedEntryCounts);

            const stats = aggregateFromPerConvo(merged, summaries.titleMap);

            // Attached before cache.write, same as refreshFromStore, so the
            // persisted copy carries it too. verification is hardcoded null:
            // this path runs no verifier, so null correctly means "not run"
            // rather than carrying forward a stale 'store'-mode result and
            // implying it still applies to server-sourced data.
            this.lastHealth = {
                source: 'server',
                conversations: mergedIds.length,
                unreadable: 0,
                unknownModels: stats.models.filter(m => isUnknownEnumName(m.displayName)).map(m => m.displayName),
                skippedRows: 0,
                verification: null,
                countingChangedAt: diskCache.countingChangedAt || null,
            };
            stats.health = this.lastHealth;

            this.deepStatsCache = stats;
            this.currentPerConvo = merged;
            // countingChangedAt carried forward verbatim: this is the 'server'
            // rollback path, not the one that sets it, and a write that omitted
            // it would erase the marker if a user ever toggles back to it.
            this.cache.write(merged, mergedIds, stats, summaries.titleMap, summaries.stepCounts, entryCounts, { ...cachedMtimes, ...currentMtimes }, diskCache.countingChangedAt);

            log.info(`incrementalRefresh: complete — totalCalls=${stats.totalCalls} (${newIds.length} new + ${changedIds.length} changed convos updated)`);
            return true;
        } catch (e: any) {
            log.warn('incrementalRefresh: FAILED:', e?.message);
            return false;
        }
    }

    /**
     * Fetch metadata for conversation IDs (parallel chunks).
     * Hybrid: RPC Direct (HTTPS) first, HTTP fallback on failure.
     */
    private async fetchConversationData(
        serverInfo: ServerInfo,
        conversationIds: string[],
        onProgress?: (done: number) => void,
        /** Per-conversation offsets for delta fetch (incrementalRefresh only) */
        offsetMap?: Map<string, { meta: number; steps: number }>,
    ): Promise<Record<string, ConvoTokenData>> {
        const result: Record<string, ConvoTokenData> = {};
        if (conversationIds.length === 0) {
            log.diag('fetchConversationData: called with 0 conversations — returning empty');
            return result;
        }

        const rpc = new RpcDirectClient(serverInfo);
        const rpcAvailable = rpc.isAvailable();
        log.diag(`fetchConversationData: ${conversationIds.length} conversations — RPC available=${rpcAvailable} (httpsPort=${serverInfo.httpsPort ?? 'none'})`);

        let useRpc = false;
        if (rpcAvailable) {
            try {
                useRpc = await rpc.heartbeat();
                log.diag(`fetchConversationData: RPC heartbeat ${useRpc ? '✓ validated' : '✗ failed'} on port ${serverInfo.httpsPort}`);
            } catch (e: any) {
                log.diag('fetchConversationData: RPC heartbeat threw:', e?.message);
            }
        } else {
            log.diag(`fetchConversationData: RPC not available — httpsPort is ${serverInfo.httpsPort} — will use HTTP fallback`);
        }

        let processed = 0;
        let withEntries = 0;
        await concurrentPool(
            conversationIds,
            async (cid) => {
                const offsets = offsetMap?.get(cid);
                const entries = await this.fetchAndDedup(
                    serverInfo, rpc, useRpc, cid, 1,
                    offsets?.meta ?? 0, offsets?.steps ?? 0,
                );
                if (entries.length > 0) { result[cid] = { entries }; withEntries++; }
            },
            BATCH_CONCURRENCY,
            () => { this.processLock.heartbeat(); processed++; onProgress?.(processed); },
        );
        log.diag(`fetchConversationData: pool done — ${processed} processed, ${withEntries}/${conversationIds.length} had token data`);

        // Retry: conversations with known stepCounts but 0 entries (timeout under load)
        if (this.currentStepCounts) {
            const missed = conversationIds.filter(cid =>
                !(cid in result) && (this.currentStepCounts?.get(cid) ?? 0) > 0,
            );
            if (missed.length > 0) {
                log.diag(`fetchConversationData: retrying ${missed.length} missed conversations (serial)`);
                let retryHits = 0;
                await concurrentPool(
                    missed,
                    async (cid) => {
                        // Retry always does full fetch (offset=0) — the delta may have been the issue
                        const entries = await this.fetchAndDedup(serverInfo, rpc, false, cid, 2, 0, 0);
                        if (entries.length > 0) {
                            result[cid] = { entries };
                            retryHits++;
                            log.diag(`fetchConversationData: RETRY OK: ${cid.substring(0, 12)} — ${entries.length} entries`);
                        }
                    },
                    1,
                );
                if (retryHits > 0) log.info(`fetchConversationData: retry recovered ${retryHits}/${missed.length}`);
            } else {
                const zeroEntryCount = conversationIds.filter(cid => !(cid in result)).length;
                if (zeroEntryCount > 0) {
                    log.diag(`fetchConversationData: ${zeroEntryCount} conversations returned 0 entries and had 0 stepCount (likely empty/no-op)`);
                }
            }
        }

        return result;
    }

    /** Fetch meta+steps for a single conversation, merge, and dedup. */
    private async fetchAndDedup(
        serverInfo: ServerInfo, rpc: RpcDirectClient, useRpc: boolean,
        cid: string, timeoutMultiplier: number,
        startMetaOffset = 0, startStepOffset = 0,
    ): Promise<TokenEntry[]> {
        const STEPS_TIMEOUT = 20000 * timeoutMultiplier;
        const META_TIMEOUT = FETCH_TIMEOUT_MS * timeoutMultiplier;

        // RPC Direct doesn't support offset — use only for full fetch (offset=0)
        const canRpc = useRpc && startMetaOffset === 0 && startStepOffset === 0;

        const [metaResult, stepsResult] = await Promise.allSettled([
            this.fetchMetaForConvo(serverInfo, rpc, canRpc, cid, META_TIMEOUT, startMetaOffset),
            this.fetchStepsForConvo(serverInfo, rpc, canRpc, cid, STEPS_TIMEOUT, startStepOffset),
        ]);

        const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;
        const steps = stepsResult.status === 'fulfilled' ? stepsResult.value : null;

        // Track raw counts BEFORE dedup — meta/steps use independent LS offsets
        this.rawFetchCounts[cid] = {
            meta: startMetaOffset + (meta?.length ?? 0),
            steps: startStepOffset + (steps?.length ?? 0),
        };

        const metaEntries = meta ? this.extractEntries(meta) : [];
        const stepEntries = steps ? this.extractStepEntries(steps) : [];

        return this.dedupEntries([...metaEntries, ...stepEntries]);
    }

    /**
     * Fetch ALL metadata for a conversation using cumulative-offset pagination.
     *
     * The LS caps each response at ~8 MB, so large conversations (4000+ entries)
     * require multiple calls. The `generator_metadata_offset` parameter skips
     * that many entries from the start. We use the cumulative item count as
     * the next offset and stop when no new items arrive.
     *
     * History: paginateAll (pre-b61) produced 20× redundant 8 MB payloads
     * because it re-fetched overlapping ranges without a proper stop condition.
     */
    private async fetchMetaForConvo(
        serverInfo: ServerInfo, rpc: RpcDirectClient, useRpc: boolean,
        cid: string, timeout: number, startOffset = 0,
    ): Promise<any[] | null> {
        if (useRpc) {
            const result = await rpc.getMetadata(cid);
            if (result) return result;
        }
        const all: any[] = [];
        let offset = startOffset;
        for (let pg = 0; pg < 30; pg++) {
            const resp = await callLsJson(serverInfo, EP.METADATA,
                { cascade_id: cid, generator_metadata_offset: offset }, timeout,
            ).catch((err) => { log.warn(`Meta page ${pg} for ${cid.substring(0,8)}: ${err?.message}`); return null; });
            const items = resp?.generatorMetadata || resp?.generator_metadata || [];
            if (items.length === 0) break;
            all.push(...items);
            offset = startOffset + all.length;
        }
        return all.length > 0 ? all : null;
    }

    /**
     * Fetch ALL steps for a conversation using cumulative-offset pagination.
     * Same strategy as fetchMetaForConvo — cumulative offset until exhausted.
     */
    private async fetchStepsForConvo(
        serverInfo: ServerInfo, rpc: RpcDirectClient, useRpc: boolean,
        cid: string, timeout: number, startOffset = 0,
    ): Promise<any[] | null> {
        if (useRpc) {
            const result = await rpc.getSteps(cid);
            if (result) return result;
        }
        const all: any[] = [];
        let offset = startOffset;
        for (let pg = 0; pg < 30; pg++) {
            const resp = await callLsJson(serverInfo, EP.STEPS,
                { cascade_id: cid, step_offset: offset }, timeout,
            ).catch((err) => { log.warn(`Steps page ${pg} for ${cid.substring(0,8)}: ${err?.message}`); return null; });
            const items = resp?.steps || [];
            if (items.length === 0) break;
            all.push(...items);
            offset = startOffset + all.length;
        }
        return all.length > 0 ? all : null;
    }

    /** Dedup usage entries by responseId when present, preferring metadata over steps. */
    private dedupEntries(entries: TokenEntry[]): TokenEntry[] {
        const byFingerprint = new Map<string, TokenEntry>();
        for (const e of entries) {
            const fp = entryFingerprint(e);
            const existing = byFingerprint.get(fp);
            byFingerprint.set(fp, existing ? mergePreferredEntry(existing, e) : e);
        }
        return [...byFingerprint.values()];
    }

    /**
     * Build per-conversation entry counts for offset-based delta fetch.
     * Uses raw (pre-dedup) meta/steps counts from rawFetchCounts.
     * Critical: generator_metadata_offset and step_offset are independent
     * LS-side counters. Using deduped entry count (meta+steps combined)
     * would produce offset > totalMeta → LS returns 0 → silent data loss.
     */
    private buildEntryCounts(
        existingCounts?: Record<string, { meta: number; steps: number }>,
    ): Record<string, { meta: number; steps: number }> {
        return { ...(existingCounts || {}), ...this.rawFetchCounts };
    }

    /**
     * Re-aggregate stats with a date range filter.
     * Called when user changes time range (24h/7d/30d/all).
     * Prefers in-memory data to avoid redundant disk I/O.
     */
    getFilteredStats(range: string): DeepUsageStats | null {
        // Prefer memory → disk fallback
        let perConvo: Record<string, ConvoTokenData> | null = null;
        let titleMap = this.currentTitleMap;

        if (Object.keys(this.currentPerConvo).length > 0) {
            perConvo = this.currentPerConvo;
        } else {
            const diskCache = this.cache.read();
            if (diskCache) {
                perConvo = diskCache.perConvo;
                titleMap = diskCache.titleMap
                    ? new Map<string, string>(Object.entries(diskCache.titleMap))
                    : this.currentTitleMap;
            }
        }

        if (!perConvo) return this.deepStatsCache;

        let dateFilter: string | { from?: string; to?: string } = '';
        if (range !== 'all') {
            const now = new Date();
            let cutoff: Date | null = null;
            let upperBound: Date | null = null;

            // gridMode is the SSOT for day-bounded ranges, so the squares the grid
            // draws and the entries this filter keeps always describe the same window.
            const mode = gridMode(range, now);
            if (mode.kind === 'strip') {
                cutoff = new Date(`${mode.from}T00:00:00`);       // local midnight
                const dayAfter = new Date(`${mode.to}T00:00:00`);
                dayAfter.setDate(dayAfter.getDate() + 1);
                if (dayAfter < now) upperBound = dayAfter;        // closed window (last-month)
            } else if (range === '24h') {
                cutoff = new Date(now.getTime() - 86400000);      // rolling, pairs with the hourly view
            } else if (range === 'today') {
                cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            }

            if (cutoff) {
                dateFilter = upperBound
                    ? { from: cutoff.toISOString(), to: upperBound.toISOString() }
                    : cutoff.toISOString();
            }
        }

        const filtered = aggregateFromPerConvo(perConvo, titleMap, dateFilter);
        // Health is a property of the last refresh, not of the selected range —
        // reattach it here so the health card survives a range switch instead of
        // vanishing every time aggregateFromPerConvo builds a fresh stats object.
        if (this.lastHealth) filtered.health = this.lastHealth;
        return filtered;
    }

    // ─── Trajectory Summaries (titles + stepCounts) ───

    private async fetchTrajectorySummaries(serverInfo: ServerInfo): Promise<{
        titleMap: Map<string, string>;
        stepCounts: Map<string, number>;
    }> {
        const titleMap = new Map<string, string>();
        const stepCounts = new Map<string, number>();
        // Phase 1: Fetch global data directly from state.vscdb (SSOT for all workspaces)
        try {
            const globalData = await getGlobalIndexData();
            for (const [id, title] of globalData.titleMap.entries()) {
                titleMap.set(id, title);
            }
            for (const [id, count] of globalData.stepCounts.entries()) {
                stepCounts.set(id, count);
            }
            log.info(`fetchTrajectorySummaries: loaded ${globalData.titleMap.size} titles, ${globalData.stepCounts.size} stepCounts from vscdb`);
        } catch (e: any) {
            log.warn('Failed to fetch global index data:', e.message);
        }

        // Phase 2: Fetch current workspace stats via LS

        try {
            const trajResp = await callLsJson(serverInfo, EP.TRAJECTORIES, {});
            if (!trajResp) {
                log.warn('fetchTrajectorySummaries: API returned null/empty response — LS may be offline or on wrong port');
                return { titleMap, stepCounts };
            }
            const sums = trajResp?.trajectorySummaries || {};
            const entries = Object.entries(sums);


            // Debug: log first entry's field names to help diagnose schema changes
            if (entries.length > 0) {
                const [firstId, firstVal] = entries[0];
                log.diag(`fetchTrajectorySummaries: sample fields for ${firstId.substring(0, 12)}: [${Object.keys(firstVal as any).join(', ')}]`);
            } else {
                log.warn('fetchTrajectorySummaries: trajectorySummaries is empty — no conversations visible to this LS instance');
                log.warn(`fetchTrajectorySummaries: raw response keys: [${Object.keys(trajResp).join(', ')}]`);
            }

            for (const [id, v] of entries) {
                const val = v as any;
                const title = val.summary || val.title || val.displayName || val.name || val.description || '';
                // LS titles have highest fidelity for the current workspace, so override if present
                if (title) titleMap.set(id, title);
                else if (!titleMap.has(id)) titleMap.set(id, 'Untitled');

                const sc = parseInt(val.stepCount || '0', 10);
                if (sc > 0) stepCounts.set(id, sc);
            }
            log.diag(`fetchTrajectorySummaries: done — ${titleMap.size} titles, ${stepCounts.size} with stepCounts`);
        } catch (e: unknown) {
            log.warn('fetchTrajectorySummaries: FAILED:', (e as Error)?.message);
        }
        return { titleMap, stepCounts };
    }

    /**
     * Synchronous disk cache load — returns pre-aggregated stats instantly.
     * Called during refresh() to populate usage stats BEFORE the first webview render.
     * Returns null if no cache exists (triggers full async fetch instead).
     */
    loadFromDiskCacheSync(): DeepUsageStats | null {
        if (this.deepStatsCache) return this.deepStatsCache;
        const result = this.cache.loadSync(this.currentTitleMap);
        if (!result) return null;
        this.currentTitleMap = result.titleMap;
        // Seed lastHealth from the persisted snapshot (see StatsCache.loadSync)
        // so a range switch immediately after this cold-start load still shows
        // it via getFilteredStats, instead of the card only appearing once a
        // real refresh eventually completes in this session.
        if (result.stats.health) this.lastHealth = result.stats.health;
        // NOTE: intentionally NOT setting this.deepStatsCache here.
        // The quotaManager stores this in lastUsageStats.
        // Keeping deepStatsCache empty allows fetchDeepStats() to proceed
        // to incrementalRefresh() for fresh data from the language server.
        return result.stats;
    }

    /** Scan ~/.gemini/antigravity/brain/ for conversation UUIDs */
    private discoverConversationIds(): string[] {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) {
            log.warn(`discoverConversationIds: brain dir does not exist: ${brainDir}`);
            return [];
        }

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        try {
            const allEntries = fs.readdirSync(brainDir, { withFileTypes: true });
            const uuidDirs = allEntries.filter(d => d.isDirectory() && UUID_RE.test(d.name));
            log.diag(`discoverConversationIds: brain dir has ${allEntries.length} total entries, ${uuidDirs.length} are UUID conversation dirs`);
            return uuidDirs.map(d => d.name);
        } catch (e: any) {
            log.warn(`discoverConversationIds: failed to read brain dir: ${e?.message}`);
            return [];
        }
    }

    // ─── Response Extractors ───




    /** Extract TokenEntry[] from metadata items array */
    private extractEntries(items: any[]): TokenEntry[] {
        const entries: TokenEntry[] = [];

        for (const item of items) {
            const cm = item.chatModel || item.chat_model || {};
            const usage = cm.usage || {};
            const { inp, out, cache, cacheWrite, reasoning } = extractTokens(usage);
            if (inp === 0 && out === 0 && cache === 0 && cacheWrite === 0 && reasoning === 0) continue;

            const rawModel = cm.responseModel || cm.response_model || usage.model || cm.model || 'Unknown';
            const apiProvider = usage.apiProvider || usage.api_provider || '';
            const responseId = usage.responseId || usage.response_id || '';

            const ts = cm.chatStartMetadata?.createdAt || cm.chat_start_metadata?.created_at || '';
            entries.push({
                responseId: responseId || undefined,
                source: 'metadata',
                inp, out, cache, cacheWrite, reasoning,
                model: rawModel,
                provider: apiProvider,
                ts,
            });
        }

        return entries;
    }

    /** Extract TokenEntry[] from steps items array */
    private extractStepEntries(steps: any[]): TokenEntry[] {
        const entries: TokenEntry[] = [];

        for (const step of steps) {
            const usage = step.modelUsage || step.model_usage || step.metadata?.modelUsage || {};
            const rawModel = usage.model || 'Unknown';
            const { inp, out, cache, cacheWrite, reasoning } = extractTokens(usage);
            if (inp === 0 && out === 0 && cache === 0 && cacheWrite === 0 && reasoning === 0) continue;
            const responseId = usage.responseId || usage.response_id || '';

            // Protobuf schema: real timestamp lives inside step.metadata (CortexStepMetadata)
            const meta = step.metadata || {};
            let ts = meta.createdAt || meta.created_at || meta.startedAt || meta.started_at
                || step.createdAt || step.created_at || step.startTime || step.start_time || '';
            // Handle stepTimestamp (varint epoch from GetCascadeTrajectory's TrajectoryStep wrapper)
            if (!ts) {
                const epoch = Number(step.stepTimestamp || step.step_timestamp || 0);
                if (epoch > 1e9) {
                    ts = new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString();
                }
            }
            entries.push({
                responseId: responseId || undefined,
                source: 'steps',
                inp, out, cache, cacheWrite, reasoning,
                model: rawModel,
                provider: '',
                ts,
            });
        }

        return entries;
    }

}
