/**
 * decodeGenMetadataBlob + mergeSources — reading Antigravity's own ledger.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure: the
 * fixture blob is built with the same protobuf encoder the reader decodes, so
 * there is no database and no I/O. Runs in CI.
 *
 * Two decisions are pinned here. Output tokens come from field 3, never field
 * 10 — field 10 is unverified and has been observed disagreeing, so the
 * fixture sets them to different values on purpose. And a malformed blob must
 * decode to null rather than a zero-filled entry, because a zero entry counts
 * as a real call that used nothing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { encodeVarintField, encodeMessage, encodeString } = require('../../out/shared/protobuf');
const { decodeGenMetadataBlob, mergeSources } = require('../../out/services/usage/store/usageReader');

const usage = Buffer.concat([
    encodeVarintField(1, 1073),     // model enum -> MODEL_PLACEHOLDER_M73
    encodeVarintField(2, 15027),    // input
    encodeVarintField(3, 126),      // output
    encodeVarintField(5, 12232),    // cache read
    encodeVarintField(6, 24),       // provider -> Gemini
    encodeVarintField(9, 401),      // reasoning
    encodeVarintField(10, 44),      // responseOutputTokens — divergent on purpose
    encodeString(11, 'eXZkatT5D8ONjuMPy9KhkA0'),
]);
const stamp = encodeMessage(9, encodeMessage(4, encodeVarintField(1, 1784968824)));
const blob = encodeMessage(1, Buffer.concat([encodeMessage(4, usage), stamp]));

describe('decodeGenMetadataBlob', () => {
    const entry = decodeGenMetadataBlob(blob);

    test('token counts', () => {
        assert.strictEqual(entry.inp, 15027);
        assert.strictEqual(entry.cache, 12232);
        assert.strictEqual(entry.reasoning, 401, 'priced, and present on 72% of entries');
    });

    test('output comes from field 3, never field 10', () => {
        assert.strictEqual(entry.out, 126);
    });

    test('enums resolve to names', () => {
        assert.strictEqual(entry.model, 'MODEL_PLACEHOLDER_M73');
        assert.strictEqual(entry.provider, 'API_PROVIDER_GOOGLE_GEMINI');
    });

    test('identity, source tag and timestamp', () => {
        assert.strictEqual(entry.responseId, 'eXZkatT5D8ONjuMPy9KhkA0');
        assert.strictEqual(entry.source, 'metadata');
        assert.strictEqual(entry.ts, new Date(1784968824000).toISOString(), 'from unix seconds');
    });

    test('a malformed blob yields null, never a zero entry', () => {
        assert.strictEqual(decodeGenMetadataBlob(Buffer.from([0x00])), null);
    });
});

describe('mergeSources — metadata wins, steps fills gaps', () => {
    const row = (over) => ({
        responseId: 'A', source: 'metadata', inp: 10, out: 1, cache: 0, cacheWrite: 0,
        reasoning: 0, model: 'M', provider: 'P', ts: '2026-08-01T00:00:00.000Z', ...over,
    });
    const merged = mergeSources(
        [row({})],
        [row({ source: 'steps', inp: 99, out: 9 }), row({ responseId: 'B', source: 'steps', inp: 5 })],
    );

    test('the duplicate collapses and the steps-only entry survives', () => {
        assert.strictEqual(merged.length, 2);
    });

    test('metadata wins for a shared response id', () => {
        assert.strictEqual(merged.find((e) => e.responseId === 'A').inp, 10);
    });

    test('steps-only entries are kept — 3.3% of history depends on it', () => {
        assert.ok(merged.find((e) => e.responseId === 'B'));
    });
});
