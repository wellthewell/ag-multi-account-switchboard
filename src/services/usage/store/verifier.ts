/**
 * Cross-checks a store read against the language server for any conversation
 * the server can still serve.
 *
 * Three fields were validated against 599 calls before this existed: input,
 * output and cache read. Reasoning was matched on a single sample and appears
 * on 72% of entries, and responseOutputTokens has been seen disagreeing with
 * outputTokens. This is what promotes those from assumed to verified, and
 * what catches the store format changing under us.
 */
import { ServerInfo } from '../../../types';
import { callLsJson } from '../../../utils/lsClient';
import { EP, MetadataUsage } from '../types';
import { readGenMetadata } from './usageReader';
import { extractTokens } from '../aggregator';
import { createLogger } from '../../../utils/logger';

const log = createLogger('UsageVerifier');

export type Divergence = { conversationId: string; responseId: string; field: string; file: number | string; server: number | string };

export async function verifyConversation(
    serverInfo: ServerInfo, cid: string, dbPath: string,
): Promise<{ compared: number; divergences: Divergence[] } | null> {
    const resp: any = await callLsJson(serverInfo, EP.METADATA, { cascade_id: cid }, 10000).catch(() => null);
    const items: any[] = resp?.generatorMetadata || resp?.generator_metadata || [];
    if (!items.length) return null;                 // the server cannot serve it; nothing to compare

    const fileResult = await readGenMetadata(dbPath);
    if (!fileResult) return null;

    const byRid = new Map(fileResult.entries.filter(e => e.responseId).map(e => [e.responseId!, e]));
    const divergences: Divergence[] = [];
    let compared = 0;

    for (const item of items) {
        const usage: MetadataUsage = item?.chatModel?.usage || item?.chat_model?.usage;
        const rid = usage?.responseId || usage?.response_id;
        if (!usage || !rid) continue;
        const mine = byRid.get(rid);
        if (!mine) continue;
        compared++;
        const theirs = extractTokens(usage);
        for (const field of ['inp', 'out', 'cache', 'cacheWrite', 'reasoning'] as const) {
            if ((mine as any)[field] !== (theirs as any)[field]) {
                divergences.push({ conversationId: cid, responseId: rid, field, file: (mine as any)[field], server: (theirs as any)[field] });
            }
        }
        const theirModel = usage.model || '';
        if (theirModel && mine.model !== theirModel) {
            divergences.push({ conversationId: cid, responseId: rid, field: 'model', file: mine.model, server: theirModel });
        }
    }

    if (divergences.length) {
        log.warn(`verifier: ${divergences.length} divergences in ${cid.slice(0, 8)} across ${compared} calls`);
        for (const d of divergences.slice(0, 5)) {
            log.warn(`  ${d.field}: file=${d.file} server=${d.server} (${d.responseId})`);
        }
    } else {
        log.info(`verifier: ${cid.slice(0, 8)} clean across ${compared} calls`);
    }
    return { compared, divergences };
}
