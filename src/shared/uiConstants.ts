/**
 * UI Constants — Pure values safe for both extension host AND webview bundles.
 * NO Node APIs, NO vscode imports. This file is the SSOT for values
 * shared across the webview ↔ extension boundary.
 */

// ─── UI Percentage Thresholds ───

/** Quota remaining: green ≥ this, yellow below */
export const QUOTA_HEALTHY_PCT = 50;
/** Quota remaining: yellow ≥ this, red below */
export const QUOTA_WARN_PCT = 20;
/** Usage: red ≥ this */
export const USAGE_HIGH_PCT = 80;
/** Usage: yellow ≥ this */
export const USAGE_MEDIUM_PCT = 50;
/** Context window percentage threshold for "warning" state */
export const CTX_WARNING_PCT = 75;
/** Context window percentage threshold for "critical/error" state */
export const CTX_CRITICAL_PCT = 90;

// ─── Rendering Defaults ───

/** Default cascade list render limit */
export const CASCADE_LIST_LIMIT = 20;
/** Default max cascade title length */
export const CASCADE_TITLE_MAX_LEN = 45;
/** Enriched cascade list render limit */
export const CASCADE_ENRICHED_LIMIT = 30;
/** Enriched cascade max title length */
export const CASCADE_ENRICHED_TITLE_MAX_LEN = 55;
/** Hours in a day for chart bucketing */
export const HOURS_IN_DAY = 24;

// ─── Polling ───

/**
 * Poll rates the footer picker offers, in milliseconds. Single source of truth:
 * the host validates incoming rates against this list and the footer buttons are
 * generated from it, so a rate cannot be offered in the UI that the host would
 * then silently reject.
 */
export const POLL_INTERVALS_MS = [30_000, 60_000, 120_000, 300_000] as const;

/** The rate used until the user picks one. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Short label for a poll rate, e.g. 30_000 -> "30s", 120_000 -> "2m". */
export function pollIntervalLabel(ms: number): string {
    return ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}m`;
}
