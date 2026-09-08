/**
 * Cache write refusal — the code path that protects the hand-imported archive.
 *
 * `claude-code-imported` holds 175 entries and 12,942,976,240 tokens with no
 * source files anywhere. Four callers write the cache; refusal therefore lives
 * in StatsCache.write itself so none of them can forget it. These tests pin
 * that behaviour across every state the file on disk can be in.
 *
 * Hermetic: temp fixtures only, never the real cache. Runs in CI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { StatsCache } = require('../../out/services/usage/cache');
const { CACHE_SCHEMA_VERSION, LEGACY_CLAUDE_ARCHIVE_ID } = require('../../out/services/usage/types');

const ARCHIVE_TOKENS = 12942976240;

/** A cache pointed at a temp file instead of the user's real one. */
function cacheAt(filePath) {
    class TempCache extends StatsCache {
        get filePath() { return filePath; }
    }
    return new TempCache();
}

/** A minimal on-disk cache containing the archive, at a given schema version. */
function fixture(schemaVersion) {
    const body = {
        perConvo: {
            [LEGACY_CLAUDE_ARCHIVE_ID]: {
                entries: [{
                    responseId: 'cc-claude-opus-4-8-2026-06-05',
                    source: 'metadata',
                    inp: 0, out: 0, cache: ARCHIVE_TOKENS, cacheWrite: 0, reasoning: 0,
                    model: 'claude-opus-4-8', provider: 'anthropic',
                    ts: '2026-06-05T12:00:00.000Z',
                }],
            },
        },
        fetchedIds: [LEGACY_CLAUDE_ARCHIVE_ID],
        stats: {},
        updatedAt: '2026-08-14T00:00:00.000Z',
    };
    if (schemaVersion !== undefined) body.schemaVersion = schemaVersion;
    return JSON.stringify(body);
}

function tmpFile(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cache-test-'));
    const file = path.join(dir, 'cache.json');
    if (contents !== null) fs.writeFileSync(file, contents);
    return { dir, file };
}

/** Arguments write() needs; the values are irrelevant to refusal. */
function someWrite(cache) {
    return cache.write({ 'x': { entries: [] } }, ['x'], {}, new Map());
}

function rejectedCopies(dir) {
    return fs.readdirSync(dir).filter((f) => f.includes('.rejected-'));
}

function archiveTotal(data) {
    const entries = data.perConvo[LEGACY_CLAUDE_ARCHIVE_ID].entries;
    return entries.reduce((n, e) => n + e.inp + e.out + e.cache + e.cacheWrite + e.reasoning, 0);
}

describe('probe() classifies every on-disk state', () => {
    test('a missing file is absent', () => {
        const { file } = tmpFile(null);
        assert.strictEqual(cacheAt(file).probe(), 'absent');
    });

    test('the current schema is ok', () => {
        const { file } = tmpFile(fixture(CACHE_SCHEMA_VERSION));
        assert.strictEqual(cacheAt(file).probe(), 'ok');
    });

    test('the previous schema is ok — it has a migration', () => {
        const { file } = tmpFile(fixture(2));
        assert.strictEqual(cacheAt(file).probe(), 'ok',
            'v2 migrates in place; classifying it stale or unreadable would strand every existing install');
    });

    test('a superseded schema with no migration is stale, not unreadable', () => {
        const { file } = tmpFile(fixture(1));
        assert.strictEqual(cacheAt(file).probe(), 'stale',
            'v1 is decodable and known-superseded, so it must rebuild rather than refuse forever');
    });

    test('an absent schemaVersion is stale', () => {
        const { file } = tmpFile(fixture(undefined));
        assert.strictEqual(cacheAt(file).probe(), 'stale');
    });

    test('a schema from a NEWER build is unreadable', () => {
        const { file } = tmpFile(fixture(CACHE_SCHEMA_VERSION + 96));
        assert.strictEqual(cacheAt(file).probe(), 'unreadable',
            'a newer build wrote it; overwriting would destroy data this build cannot read');
    });

    test('truncated JSON is unreadable', () => {
        const { file } = tmpFile('{"perConvo":{"claude-code');
        assert.strictEqual(cacheAt(file).probe(), 'unreadable');
    });

    test('a missing top-level field is unreadable', () => {
        const { file } = tmpFile(JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, fetchedIds: [], stats: {} }));
        assert.strictEqual(cacheAt(file).probe(), 'unreadable',
            'no perConvo means the contents are unknown, which is the case refusal exists for');
    });
});

describe('write() refuses while the file is undecodable', () => {
    test('a newer schema is left byte-identical', () => {
        const { dir, file } = tmpFile(fixture(CACHE_SCHEMA_VERSION + 96));
        const before = fs.readFileSync(file);

        assert.strictEqual(someWrite(cacheAt(file)), false, 'write must report refusal');
        assert.deepStrictEqual(fs.readFileSync(file), before, 'the file must not be touched');
        assert.strictEqual(rejectedCopies(dir).length, 1, 'a copy must be preserved');
    });

    test('a truncated file is left byte-identical', () => {
        const { dir, file } = tmpFile('{"perConvo":{"claude-code');
        const before = fs.readFileSync(file);

        assert.strictEqual(someWrite(cacheAt(file)), false);
        assert.deepStrictEqual(fs.readFileSync(file), before);
        assert.strictEqual(rejectedCopies(dir).length, 1);
    });

    test('the archive survives a refused write intact', () => {
        const { file } = tmpFile(fixture(CACHE_SCHEMA_VERSION + 96));

        someWrite(cacheAt(file));

        const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.ok(onDisk.perConvo[LEGACY_CLAUDE_ARCHIVE_ID], 'the archive conversation must still be present');
        assert.strictEqual(archiveTotal(onDisk), ARCHIVE_TOKENS,
            'the archive token total must be unchanged — it cannot be regenerated');
    });

    test('repeated refusals do not accumulate copies', () => {
        const { dir, file } = tmpFile(fixture(CACHE_SCHEMA_VERSION + 96));

        someWrite(cacheAt(file));
        someWrite(cacheAt(file));
        someWrite(cacheAt(file));

        assert.strictEqual(rejectedCopies(dir).length, 1,
            'each window launch would otherwise deposit another full copy of the cache');
    });
});

describe('write() proceeds where it safely can', () => {
    test('an absent file is written', () => {
        const { file } = tmpFile(null);
        assert.strictEqual(someWrite(cacheAt(file)), true);
        assert.ok(fs.existsSync(file), 'a first run must be able to create the cache');
    });

    test('the current schema is written', () => {
        const { file } = tmpFile(fixture(CACHE_SCHEMA_VERSION));
        assert.strictEqual(someWrite(cacheAt(file)), true);
    });

    test('a stale schema rebuilds after preserving a copy', () => {
        const { dir, file } = tmpFile(fixture(1));

        assert.strictEqual(someWrite(cacheAt(file)), true,
            'refusing here would strand the install: no write would ever succeed again');
        assert.strictEqual(rejectedCopies(dir).length, 1,
            'the superseded file must be preserved before it is replaced');
        assert.strictEqual(
            JSON.parse(fs.readFileSync(file, 'utf-8')).schemaVersion,
            CACHE_SCHEMA_VERSION,
            'the rebuilt file carries the current schema',
        );
    });

    test('the preserved copy of a stale file still holds its contents', () => {
        const { dir, file } = tmpFile(fixture(1));

        someWrite(cacheAt(file));

        const copy = rejectedCopies(dir)[0];
        const preserved = JSON.parse(fs.readFileSync(path.join(dir, copy), 'utf-8'));
        assert.strictEqual(archiveTotal(preserved), ARCHIVE_TOKENS,
            'the copy is the fallback for anything the rebuild cannot re-derive');
    });
});

describe('read() agrees with probe()', () => {
    test('every refusing state reads as null', () => {
        for (const contents of [
            fixture(CACHE_SCHEMA_VERSION + 96),
            '{"perConvo":{"claude-code',
            JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, fetchedIds: [], stats: {} }),
        ]) {
            const { file } = tmpFile(contents);
            const cache = cacheAt(file);
            assert.strictEqual(cache.probe(), 'unreadable');
            assert.strictEqual(cache.read(), null, 'read must not hand out data it classified undecodable');
        }
    });

    test('a v2 file reads back migrated, with the archive intact', () => {
        const { file } = tmpFile(fixture(2));

        const data = cacheAt(file).read();

        assert.ok(data, 'v2 must be readable');
        assert.strictEqual(data.schemaVersion, CACHE_SCHEMA_VERSION, 'read migrates in place');
        assert.strictEqual(archiveTotal(data), ARCHIVE_TOKENS,
            'the migration must not alter the archive — this is what makes the schema bump safe');
    });
});
