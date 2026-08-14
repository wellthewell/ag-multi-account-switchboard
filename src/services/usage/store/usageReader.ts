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
import { TokenEntry, MetadataUsage, entryFingerprint, mergePreferredEntry } from '../types';
import { extractTokens } from '../aggregator';
import { modelNameFromEnum, providerNameFromEnum } from './enumMap';

export type LearnedEnums = { models?: Record<number, string>; providers?: Record<number, string> };

/** usage submessage: gen_metadata.data -> field 1 -> field 4 */
const F_MODEL = 1, F_INPUT = 2, F_OUTPUT = 3, F_CACHE_READ = 5,
      F_PROVIDER = 6, F_REASONING = 9, F_RESPONSE_ID = 11;

function sub(buf: Buffer, field: number): Buffer | null {
    const f = readFields(buf).find(x => x.field === field && x.wireType === 2);
    return f?.bytes ?? null;
}

export function decodeGenMetadataBlob(buf: Buffer, learned?: LearnedEnums): TokenEntry | null {
    try {
        const outer = sub(buf, 1);
        if (!outer) return null;
        const usage = sub(outer, 4);
        if (!usage) return null;

        const g: Record<number, any> = {};
        for (const f of readFields(usage)) {
            g[f.field] = f.wireType === 0 ? f.varint : f.bytes;
        }
        if (g[F_INPUT] === undefined && g[F_OUTPUT] === undefined) return null;

        // timestamp: outer -> field 9 -> field 4 -> field 1 (unix seconds)
        let seconds = 0;
        const t1 = sub(outer, 9);
        const t2 = t1 ? sub(t1, 4) : null;
        if (t2) seconds = readFields(t2).find(f => f.field === 1)?.varint ?? 0;
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
            source: 'metadata',
            inp: t.inp, out: t.out, cache: t.cache, cacheWrite: t.cacheWrite, reasoning: t.reasoning,
            model, provider,
            ts: new Date(seconds * 1000).toISOString(),
        };
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
 * Steps rows carry the same usage submessage nested one level deeper, under
 * the step's metadata blob. step_payload is never selected: it holds
 * conversation content and is the bulk of the file.
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
        // Try the blob directly, then each length-delimited child: the usage
        // submessage sits at a different depth depending on step type.
        const candidates: Buffer[] = [buf, ...readFields(buf).filter(f => f.wireType === 2 && f.bytes).map(f => f.bytes!)];
        for (const c of candidates) {
            const e = decodeGenMetadataBlob(c, learned);
            if (e) { entries.push({ ...e, source: 'steps' }); break; }
        }
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
