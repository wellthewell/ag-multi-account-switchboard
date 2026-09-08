/**
 * enumMap — turning Antigravity's numeric model and provider enums into names.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure
 * lookups plus two downstream consumers, no I/O. Runs in CI.
 *
 * The load-bearing idea is that an unrecognised enum must stay *visibly*
 * unrecognised all the way through. It must not be guessed into a plausible
 * name, must not be priced, and must not be humanised into something the
 * health card's unknown-model scan can no longer detect — otherwise a model
 * this build has never seen disappears quietly instead of being surfaced.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { modelNameFromEnum, providerNameFromEnum, isUnknownEnumName } = require('../../out/services/usage/store/enumMap');
const { calculateTotalCost } = require('../../out/shared/usage-components');
const { getModelDisplayName } = require('../../out/services/usage/aggregator');

const UNKNOWN_MODEL = modelNameFromEnum(4242);

function bucket(displayName) {
    return [{ displayName, input: 1e6, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 }];
}

describe('model enums follow the 1000 + N rule', () => {
    test('known placeholders resolve', () => {
        assert.strictEqual(modelNameFromEnum(1073), 'MODEL_PLACEHOLDER_M73');
        assert.strictEqual(modelNameFromEnum(1026), 'MODEL_PLACEHOLDER_M26');
        assert.strictEqual(modelNameFromEnum(1266), 'MODEL_PLACEHOLDER_M266',
            'M266 exists in production — verified against real data');
    });

    test('an unknown enum is named, not guessed', () => {
        assert.strictEqual(modelNameFromEnum(4242), 'MODEL_UNKNOWN_4242');
    });

    test('the range boundaries are unknown, not off-by-one placeholders', () => {
        assert.strictEqual(modelNameFromEnum(1000), 'MODEL_UNKNOWN_1000');
        assert.strictEqual(modelNameFromEnum(2000), 'MODEL_UNKNOWN_2000');
    });

    test('a learned pair beats the unknown fallback', () => {
        assert.strictEqual(modelNameFromEnum(4242, { 4242: 'MODEL_CLAUDE_9_OPUS' }), 'MODEL_CLAUDE_9_OPUS');
    });
});

describe('provider enums', () => {
    test('seeded providers resolve', () => {
        assert.strictEqual(providerNameFromEnum(24), 'API_PROVIDER_GOOGLE_GEMINI');
        assert.strictEqual(providerNameFromEnum(26), 'API_PROVIDER_ANTHROPIC_VERTEX');
    });

    test('an unknown provider is named', () => {
        assert.strictEqual(providerNameFromEnum(99), 'API_PROVIDER_UNKNOWN_99');
    });
});

describe('unknown names stay detectable', () => {
    test('isUnknownEnumName recognises them', () => {
        assert.ok(isUnknownEnumName(UNKNOWN_MODEL));
        assert.ok(isUnknownEnumName(providerNameFromEnum(99)));
    });

    test('known names are not flagged', () => {
        assert.ok(!isUnknownEnumName('MODEL_PLACEHOLDER_M73'));
    });
});

describe('an unknown model is not priced', () => {
    test('a known model is priced', () => {
        assert.ok(calculateTotalCost(bucket('Claude Opus 4.8')) > 0);
    });

    test('an unknown model contributes no cost', () => {
        assert.strictEqual(calculateTotalCost(bucket(UNKNOWN_MODEL)), 0,
            'guessing a price for a model we cannot identify would be worse than showing nothing');
    });
});

describe('an unknown model survives display formatting', () => {
    test('getModelDisplayName does not humanise the unknown marker away', () => {
        // The health card builds its unknownModels list by scanning ModelBucket
        // .displayName with isUnknownEnumName. If formatting strips the marker,
        // an unrecognised model silently vanishes from the card meant to surface it.
        const shown = getModelDisplayName(UNKNOWN_MODEL, 'API_PROVIDER_GOOGLE_GEMINI', '2026-01-01T00:00:00.000Z');
        assert.ok(isUnknownEnumName(shown));
    });
});
