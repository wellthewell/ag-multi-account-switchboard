/**
 * Poll rates: the footer cannot offer what the host would reject.
 *
 * Ported from the --self-check block in src/services/usage/types.ts. Reads one
 * repo source file (the webview template) to prove the buttons are generated
 * rather than hardcoded; everything else is a constant lookup. Runs in CI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    POLL_INTERVALS_MS, DEFAULT_POLL_INTERVAL_MS, pollIntervalLabel,
} = require('../../out/shared/uiConstants');

const TEMPLATE = path.join(__dirname, '../../src/templates/webviewTemplate.ts');

describe('the offered rates', () => {
    test('the default is one the picker offers', () => {
        // Otherwise the footer highlights nothing on first open.
        assert.ok(POLL_INTERVALS_MS.includes(DEFAULT_POLL_INTERVAL_MS));
    });

    test('labels read as the user expects', () => {
        assert.deepStrictEqual(POLL_INTERVALS_MS.map(pollIntervalLabel), ['30s', '1m', '2m', '5m']);
    });
});

describe('one source of truth for the rate list', () => {
    // The buttons are generated from POLL_INTERVALS_MS and the host validates
    // against the same array, so a rate added to the UI is automatically
    // accepted. Reintroducing a second hardcoded list is the regression.
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');

    test('the footer buttons are generated from the constant', () => {
        assert.ok(tpl.includes('POLL_INTERVALS_MS.map'));
    });

    test('no literal data-ms value remains in the template', () => {
        assert.ok(!/data-ms="\d/.test(tpl));
    });
});
