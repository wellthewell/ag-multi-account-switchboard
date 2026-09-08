/**
 * getModelDisplayName + the learned-label store.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Pure, no
 * I/O — but the learned labels are MODULE-GLOBAL state in types.js, so every
 * test here restores what it changed and the file ends by clearing them.
 *
 * Antigravity reports models as opaque numeric enums. A seed table names the
 * ones we have identified; anything else has to stay visibly unknown rather
 * than be guessed into a plausible name. Labels are also learned at runtime
 * from API responses, and the load-bearing constraint is that a learned label
 * must never override a mapping that drives PRICING — M26 resolves date-aware
 * (Opus 4.5 before the 4.6 cutoff), and a label overwriting that would silently
 * change what the panel charges for.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { getModelDisplayName } = require('../../out/services/usage/aggregator');
const {
    learnModelLabels, allLearnedModelLabels, setLearnedModelLabels,
} = require('../../out/services/usage/types');

after(() => setLearnedModelLabels({}));

describe('the seed table', () => {
    test('a seeded placeholder shows the vendor name', () => {
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M187'), 'Gemini 3.5 Flash (Low)');
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M298'), 'Gemini 3.7 Flash (High)');
    });

    test('an unseen placeholder admits it is unknown', () => {
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Placeholder M9999');
    });
});

describe('learning a label at runtime', () => {
    test('only complete pairs are learned, and only new ones are returned', () => {
        const learned = learnModelLabels([
            { label: 'Gemini 4.0 Pro (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M9999' } },
            { label: 'no key', modelOrAlias: {} },
            { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M8888' } },
        ]);
        assert.deepStrictEqual(learned, { 'MODEL_PLACEHOLDER_M9999': 'Gemini 4.0 Pro (High)' });
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Gemini 4.0 Pro (High)',
            'a learned label takes effect immediately');
    });

    test('re-learning the same label reports nothing fresh', () => {
        // Otherwise we write persisted state on every poll.
        assert.deepStrictEqual(
            learnModelLabels([{ label: 'Gemini 4.0 Pro (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M9999' } }]),
            {},
        );
    });

    test('a label never overrides a priced placeholder', () => {
        learnModelLabels([{ label: 'WRONG', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M26' } }]);
        assert.strictEqual(
            getModelDisplayName('MODEL_PLACEHOLDER_M26', undefined, '2026-01-01T00:00:00.000Z'),
            'Claude Opus 4.5 (Thinking)',
            'date-aware resolution has to survive a bad learned label',
        );
    });
});

describe('the persistence round-trip', () => {
    test('snapshot, clear and restore', () => {
        const snapshot = allLearnedModelLabels();
        assert.strictEqual(snapshot['MODEL_PLACEHOLDER_M9999'], 'Gemini 4.0 Pro (High)');

        setLearnedModelLabels({});
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Placeholder M9999', 'cleared state forgets');
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M187'), 'Gemini 3.5 Flash (Low)', 'but the seed survives a clear');

        setLearnedModelLabels(snapshot);
        assert.strictEqual(getModelDisplayName('MODEL_PLACEHOLDER_M9999'), 'Gemini 4.0 Pro (High)');
    });
});
