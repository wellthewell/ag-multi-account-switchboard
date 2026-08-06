/**
 * Shared helpers — SSOT for both extension host and webview.
 * Pure functions only: no DOM, no Node APIs, no side effects.
 */

import {
    QUOTA_HEALTHY_PCT, QUOTA_WARN_PCT,
    USAGE_HIGH_PCT, USAGE_MEDIUM_PCT,
    HOURS_IN_DAY,
} from './uiConstants';

// ─── CSS class helpers ───

export function dotClass(pct: number): string {
    return pct >= QUOTA_HEALTHY_PCT ? 'g' : pct >= QUOTA_WARN_PCT ? 'y' : 'r';
}

export const fillClass = dotClass;

export function pctClass(pct: number): string {
    return pct >= USAGE_HIGH_PCT ? 'r' : pct >= USAGE_MEDIUM_PCT ? 'y' : 'g';
}

// ─── Time helpers ───

export function timeLeft(resetTimeStr: string | undefined | null): string {
    if (!resetTimeStr) return '';
    const reset = new Date(resetTimeStr);
    if (isNaN(reset.getTime())) return '';
    const diff = reset.getTime() - Date.now();
    if (diff <= 0) return 'Reset';
    return formatDurationMs(diff);
}

/** Duration in ms → compact string: "5h 23m", "42m", "2d 3h" */
export function formatDurationMs(ms: number): string {
    if (ms <= 0) return '';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= HOURS_IN_DAY) {
        const d = Math.floor(h / HOURS_IN_DAY);
        const rh = h % HOURS_IN_DAY;
        return rh > 0 ? d + 'd ' + rh + 'h' : d + 'd';
    }
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}



// ─── Model/Tier name helpers ───

export function shortModelName(name: string | undefined | null): string {
    if (!name) return '?';
    return name.split('/').pop()!.replace(/^models-/, '').replace(/^models_/, '');
}

/**
 * Normalize any model identifier (LS enum, API key, or label) to a canonical
 * lowercase alphanumeric string for cross-source pin matching.
 *
 * "Claude Opus 4.6 (Thinking)" → "claudeopus46thinking"
 * "claude-opus-4-6-thinking"   → "claudeopus46thinking"
 * "MODEL_PLACEHOLDER_M26"      → "modelplaceholderm26"
 */
export function normalizeModelKey(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function shortTierName(name: string | undefined | null): string {
    if (!name) return '';
    const parts = name.split(' ');
    return parts[parts.length - 1] || name;
}

// ─── Number formatters ───



/** Number → locale string with separators (28,921) */
export function fmtNum(n: number): string {
    return n.toLocaleString();
}

/** Large number → compact string (1.2M, 489.7K) */
export function fmtBig(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

/** ISO date → short display (Apr 19) */
export function fmtShortDate(iso: string): string {
    if (!iso || iso.length < 10) return iso;
    const parts = iso.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10);
}

// ─── HTML/Security helpers ───

/** HTML entity escape */
export function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** CSP nonce generator */
export function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

// ─── Activity grid windows ───

/** Local calendar date as YYYY-MM-DD. Not toISOString() — that shifts to UTC. */
export function isoDay(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** How the activity grid should be drawn for a range filter. */
export type GridMode =
    | { kind: 'hourly' }
    | { kind: 'strip'; from: string; to: string }  // inclusive local dates
    | { kind: 'year' };

/**
 * The window the activity grid should span for a given range filter — and the
 * SSOT for the range's date cutoff, so the squares drawn and the data counted
 * always agree.
 *
 * A full calendar year is only worth drawing for All Time; a 7d filter that
 * paints 52 empty weeks is noise. Short ranges get a day strip spanning exactly
 * the period, sub-day ranges get the hourly heatmap instead.
 *
 * Self-check: `node out/services/usage/types.js --self-check`
 */
export function gridMode(range: string, now: Date = new Date()): GridMode {
    // N calendar days ending today (inclusive), so "7d" draws exactly 7 squares
    const lastNDays = (n: number): GridMode => ({
        kind: 'strip',
        from: isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n + 1)),
        to: isoDay(now),
    });

    switch (range) {
        case '24h':
        case 'today':
            return { kind: 'hourly' };
        case '7d':
            return lastNDays(7);
        case '30d':
            return lastNDays(30);
        case 'this-week':
            return lastNDays(now.getDay() || 7);  // getDay(): Sun=0 → treat as 7th day of a Mon-start week
        case 'this-month':
            return lastNDays(now.getDate());
        case 'last-month':
            return {
                kind: 'strip',
                from: isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
                to: isoDay(new Date(now.getFullYear(), now.getMonth(), 0)),  // day 0 = last day of prev month
            };
        default:
            return { kind: 'year' };
    }
}
