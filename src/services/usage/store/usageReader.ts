/**
 * Reads token usage straight from a conversation store.
 *
 * The language server serves only conversations that existed when it started,
 * so anything the agy command-line client creates afterwards is invisible to
 * it. The store is the source of truth and is read directly.
 *
 * Interpretation is deliberately shared with the server path: the decoded
 * fields are shaped into a MetadataUsage and handed to extractTokens(), so the
 * two sources cannot drift apart in how a number becomes a token count.
 *
 * No static logger import here by design: this module is required directly by
 * plain `node` (self-check, and ad-hoc store inspection), where utils/logger.ts's
 * `import ... from 'vscode'` has nothing to resolve against. Its siblings
 * (shared/db.ts, shared/protobuf.ts, store/enumMap.ts) follow the same rule —
 * decode failures return null/skip silently. The one exception is the
 * read-failure branch in readGenMetadata below, which lazily and guardedly
 * requires the real logger so a failure is at least named in the extension
 * host, without breaking any plain-node caller.
 */

import { readFields } from '../../../shared/protobuf';
import { dbAllAt } from '../../../shared/db';
import { TokenEntry, TokenEntrySource, MetadataUsage, entryFingerprint, mergePreferredEntry } from '../types';
import { extractTokens } from '../aggregator';
import { modelNameFromEnum, providerNameFromEnum } from './enumMap';

export type LearnedEnums = { models?: Record<number, string>; providers?: Record<number, string> };

/**
 * Usage submessage field numbers. The submessage's own shape is identical
 * between gen_metadata and steps — only the path used to reach it differs
 * (gen_metadata: buf -> 1 -> 4; steps: buf -> 9 directly). See
 * decodeUsageSubmessage and readStepsUsage.
 */
const F_MODEL = 1, F_INPUT = 2, F_OUTPUT = 3, F_CACHE_READ = 5,
      F_PROVIDER = 6, F_REASONING = 9, F_RESPONSE_ID = 11;

function sub(buf: Buffer, field: number): Buffer | null {
    const f = readFields(buf).find(x => x.field === field && x.wireType === 2);
    return f?.bytes ?? null;
}

/**
 * Interprets an already-located usage submessage plus its unix-seconds
 * timestamp. Shared by both sources so they cannot drift apart in how a
 * number becomes a token count — each source only differs in how it locates
 * `usage` and `seconds` before calling in. `source` is taken explicitly
 * rather than hardcoded, so a future third call site cannot forget to tag
 * it and silently mislabel entries into mergePreferredEntry's metadata-wins
 * logic.
 */
function decodeUsageSubmessage(usage: Buffer, seconds: number, source: TokenEntrySource, learned?: LearnedEnums): TokenEntry | null {
    const g: Record<number, any> = {};
    for (const f of readFields(usage)) {
        g[f.field] = f.wireType === 0 ? f.varint : f.bytes;
    }
    if (g[F_INPUT] === undefined && g[F_OUTPUT] === undefined) return null;
    if (!seconds) return null;

    const model = modelNameFromEnum(Number(g[F_MODEL] ?? 0), learned?.models);
    const provider = providerNameFromEnum(Number(g[F_PROVIDER] ?? 0), learned?.providers);

    // Shaped as the server's JSON so extractTokens() stays the single
    // interpreter of token fields. Field 10 (responseOutputTokens) is
    // deliberately omitted: it has been observed disagreeing with field 3
    // and is unverified, so it must not reach cost.
    const usageJson: MetadataUsage = {
        inputTokens: String(g[F_INPUT] ?? 0),
        outputTokens: String(g[F_OUTPUT] ?? 0),
        cacheReadTokens: String(g[F_CACHE_READ] ?? 0),
        reasoningTokens: String(g[F_REASONING] ?? 0),
        model,
        apiProvider: provider,
    };
    const t = extractTokens(usageJson);

    const ridBuf = g[F_RESPONSE_ID];
    return {
        responseId: Buffer.isBuffer(ridBuf) ? ridBuf.toString('utf-8') : undefined,
        source,
        inp: t.inp, out: t.out, cache: t.cache, cacheWrite: t.cacheWrite, reasoning: t.reasoning,
        model, provider,
        ts: new Date(seconds * 1000).toISOString(),
    };
}

export function decodeGenMetadataBlob(buf: Buffer, learned?: LearnedEnums): TokenEntry | null {
    try {
        const outer = sub(buf, 1);
        if (!outer) return null;
        const usage = sub(outer, 4);
        if (!usage) return null;

        // timestamp: outer -> field 9 -> field 4 -> field 1 (unix seconds)
        let seconds = 0;
        const t1 = sub(outer, 9);
        const t2 = t1 ? sub(t1, 4) : null;
        if (t2) seconds = readFields(t2).find(f => f.field === 1)?.varint ?? 0;

        return decodeUsageSubmessage(usage, seconds, 'metadata', learned);
    } catch { /* a malformed row must not take down the conversation */
        return null;
    }
}

/** null means the read failed — never conflate that with "no usage". */
export async function readGenMetadata(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null> {
    const rows = await dbAllAt(dbPath, 'select quote(data) from gen_metadata order by idx');
    if (rows === null) {
        // Lazy + guarded on purpose: utils/logger imports vscode at module scope,
        // so a static import would break every plain-node caller — the self-check
        // and the store verification scripts both run outside the extension host.
        // This branch only runs on a real read failure, never during those.
        try { require('../../../utils/logger').createLogger('UsageReader').warn(`gen_metadata unreadable: ${dbPath}`); }
        catch { /* outside the extension host — the caller reports the failure count */ }
        return null;
    }
    const entries: TokenEntry[] = [];
    for (const r of rows) {
        const cell = r[0];
        if (!cell || !cell.startsWith("X'")) continue;
        const e = decodeGenMetadataBlob(Buffer.from(cell.slice(2, -1), 'hex'), learned);
        if (e) entries.push(e);
    }
    return entries;
}

/**
 * A steps row carries the same usage submessage as gen_metadata, but reached by
 * a different path — measured across 3,527 rows in 34 conversations:
 *
 *     gen_metadata:  usage at 1 -> 4     timestamp at 1 -> 9 -> 4 -> 1
 *     steps:         usage at 9          timestamp at 1 -> 1
 *
 * 1,644 of those rows carry usage at field 9 and every row has a timestamp at
 * 1.1. The submessage's own field numbering is identical in both, which is why
 * the two share one decoder for it (decodeUsageSubmessage).
 *
 * The usage message is mirrored at 28.2 in the same blob; only field 9 is read,
 * so the duplicate never enters the list.
 *
 * step_payload is never selected: it holds conversation content and is the bulk
 * of the file.
 */
export async function readStepsUsage(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null> {
    const rows = await dbAllAt(dbPath, 'select quote(metadata) from steps where metadata is not null order by idx');
    if (rows === null) {
        // Lazy + guarded on purpose: utils/logger imports vscode at module scope,
        // so a static import would break every plain-node caller — the self-check
        // and the store verification scripts both run outside the extension host.
        // This branch only runs on a real read failure, never during those.
        try { require('../../../utils/logger').createLogger('UsageReader').warn(`steps unreadable: ${dbPath}`); }
        catch { /* outside the extension host — the caller reports the failure count */ }
        return null;
    }
    const entries: TokenEntry[] = [];
    for (const r of rows) {
        const cell = r[0];
        if (!cell || !cell.startsWith("X'")) continue;
        const buf = Buffer.from(cell.slice(2, -1), 'hex');

        // Same guard as decodeGenMetadataBlob: one malformed row must not take
        // down the conversation. The protobuf reader clamps rather than throws,
        // but a garbage varint reaching `new Date(seconds * 1000)` raises
        // RangeError, which would otherwise reject the promise and bypass the
        // documented "null if either table fails" contract entirely.
        try {
            const usage = sub(buf, 9);
            if (!usage || usage.length === 0) continue;      // a step with no model call
            const stamp = sub(buf, 1);
            const seconds = stamp ? (readFields(stamp).find(f => f.field === 1)?.varint ?? 0) : 0;
            if (!seconds) continue;

            const e = decodeUsageSubmessage(usage, seconds, 'steps', learned);
            if (e) entries.push(e);
        } catch { /* skip this row; siblings still count */ }
    }
    return entries;
}

/** Metadata is the canonical accounting; steps only fills gaps. */
export function mergeSources(metadata: TokenEntry[], steps: TokenEntry[]): TokenEntry[] {
    const byFingerprint = new Map<string, TokenEntry>();
    for (const e of metadata) byFingerprint.set(entryFingerprint(e), e);
    for (const e of steps) {
        const fp = entryFingerprint(e);
        const existing = byFingerprint.get(fp);
        byFingerprint.set(fp, existing ? mergePreferredEntry(existing, e) : e);
    }
    return [...byFingerprint.values()];
}

/**
 * Full usage for one conversation. Returns null if either table failed —
 * a partial read must never be mistaken for a complete one, or it would
 * truncate the ledger.
 */
export async function readConversationUsage(dbPath: string, learned?: LearnedEnums): Promise<TokenEntry[] | null> {
    const [meta, steps] = await Promise.all([readGenMetadata(dbPath, learned), readStepsUsage(dbPath, learned)]);
    if (meta === null || steps === null) return null;
    return mergeSources(meta, steps);
}
