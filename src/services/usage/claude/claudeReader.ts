/**
 * One Claude Code transcript -> TokenEntry[].
 *
 * Two things make this non-obvious:
 *
 * 1. One assistant turn spans 1-8 JSONL rows sharing a `requestId` (thinking,
 *    text and tool_use arrive as separate rows, each repeating the same usage
 *    block). `requestId` is the unit of one API call, and the dedupe key.
 *    Counting rows overstates calls by ~2.3x.
 *
 * 2. `output_tokens_details.thinking_tokens` is a BREAKDOWN of `output_tokens`,
 *    not an addend — unlike Gemini, where reasoning is a disjoint bucket. The
 *    aggregator's total is additive, so thinking is split out of output here.
 *    That keeps `out + reasoning === output_tokens` and needs no aggregator change.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { TokenEntry } from '../types';
import { createLogger } from '../../../utils/logger';

const log = createLogger('ClaudeReader');

export async function readClaudeTranscript(filePath: string): Promise<TokenEntry[]> {
    const byRequest = new Map<string, TokenEntry>();
    let violations = 0;

    // Streamed: active transcripts reach tens of megabytes.
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line || line.indexOf('"usage"') === -1) continue;

        let row: any;
        // A transcript being appended to can end mid-line. Skip it, keep going.
        try { row = JSON.parse(line); } catch { continue; }

        if (row.type !== 'assistant') continue;

        const msg = row.message;
        const u = msg?.usage;
        if (!u || typeof u !== 'object') continue;

        const model = msg.model;
        if (!model || model === '<synthetic>') continue;

        // requestId is the unit of one API call: thinking, text and tool_use
        // blocks from the SAME call are written as separate rows, each
        // repeating the identical usage block. Keying on requestId (falling
        // back to message.id) collapses those 1-8 rows to one entry instead
        // of overcounting calls by ~2.3x. First-seen wins — every row in a
        // turn carries the same usage, so which row wins does not matter,
        // but keeping the first keeps the earliest timestamp for the call.
        const key = row.requestId || msg.id;
        if (!key || byRequest.has(key)) continue;

        const output = u.output_tokens ?? 0;
        const thinking = u.output_tokens_details?.thinking_tokens ?? 0;

        // thinking_tokens is a BREAKDOWN of output_tokens, not an addend (unlike
        // Gemini's disjoint reasoning bucket). thinking <= output_tokens is the
        // invariant that guarantees the split below is meaningful; a violation
        // means the field's meaning has changed upstream, so skip rather than
        // store a number that would silently inflate totals.
        if (thinking > output) {
            violations++;
            continue;
        }

        byRequest.set(key, {
            responseId: key,
            source: 'metadata',
            inp: u.input_tokens ?? 0,
            out: output - thinking,
            cache: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            reasoning: thinking,
            model,
            provider: 'anthropic',
            ts: row.timestamp || '',
        });
    }

    if (violations > 0) {
        log.warn(`${filePath}: skipped ${violations} entries with thinking > output_tokens`);
    }

    return [...byRequest.values()];
}
