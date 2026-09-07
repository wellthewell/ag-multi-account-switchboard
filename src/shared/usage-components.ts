/**
 * Shared Usage Stats render components — SSOT for sidebar & detail panel.
 * Pure HTML-string generators. No DOM, no Node APIs, no side effects.
 * Used by: webview/renderers/usage.ts (sidebar) & providers/usageStatsPanel.ts (detail panel)
 */

import { fmtNum, fmtBig, fmtShortDate, escHtml, escAttr, isoDay } from './helpers';
import { DailyBucket, HourlyBucket, ModelBucket, CascadeBucket, MonthlyBucket, MonthlyModelEntry, ProviderBucket, WeekdayBucket } from '../types';
import type { DeepUsageStats } from '../types';
import {
    CASCADE_LIST_LIMIT, CASCADE_TITLE_MAX_LEN,
    CASCADE_ENRICHED_LIMIT, CASCADE_ENRICHED_TITLE_MAX_LEN,
} from './uiConstants';
// Runtime imports for the Claude account facet (below).
//
// ConvoTokenData is `import type` — erased at compile time, so it cannot
// affect the webview bundle regardless of what services/usage/types.ts
// otherwise contains.
//
// isClaudeConvo/LEGACY_CLAUDE_ARCHIVE_ID come from ./convoId, NOT from
// services/usage/types.ts: that file ends in a --self-check block whose
// require() calls reach fs/path/os/sqlite/the language server client, and
// esbuild resolves every literal require() it can reach in the AST
// regardless of the runtime `if (require.main === module)` guard around it
// — confirmed empirically (`npm run compile:webview` failed with "Could not
// resolve 'fs'" the moment anything real was imported from that file here).
// convoId.ts has zero imports and is safe. claudePins.ts was updated to
// import from convoId.ts too, for the same reason, so resolveBacklogAccount
// is safe to import directly.
//
// discoverClaudeAccounts (services/usage/claude/claudeAccounts.ts) itself
// touches fs/path/os directly — there is no dependency-free version of it —
// so it cannot be statically imported here at all. It is registered instead,
// mirroring setExternalPricingResolver just below: the extension host calls
// setClaudeAccountResolver once with the real function; accountFacetFor uses
// it if set, and otherwise still resolves every account's uuid/tokens/calls
// correctly (see accountFacetFor) — it only loses the human-readable email
// label for a *stamped* row until the resolver is registered, which the
// self-check does not assert on.
import type { ConvoTokenData } from '../services/usage/types';
import { isClaudeConvo, LEGACY_CLAUDE_ARCHIVE_ID, entryFingerprint } from '../services/usage/convoId';
import { resolveBacklogAccount } from '../services/usage/claude/claudePins';

export type UsageTotals = {
    input: number;
    output: number;
    cache?: number;
    cacheWrite?: number;
    reasoning?: number;
};

/** All token telemetry for a bucket/model/month. */
export function usageTotal(u: UsageTotals): number {
    return u.input + u.output + (u.cache || 0) + (u.cacheWrite || 0) + (u.reasoning || 0);
}

// ═══════════════════════════════════════════
//  KPI Cards
// ═══════════════════════════════════════════

export function kpiCard(_icon: string, value: string, label: string, color: string = ''): string {
    const style = color ? ` style="border-color:${color}33"` : '';
    const dot = color ? `<span class="deep-kpi-dot" style="background:${color}"></span>` : '';
    return `<div class="deep-kpi"${style}>`
        + '<div class="deep-kpi-val">' + value + '</div>'
        + '<div class="deep-kpi-label">' + dot + label + '</div>'
        + '</div>';
}

// ═══════════════════════════════════════════
//  Daily Breakdown Bars
// ═══════════════════════════════════════════

export function renderDailyBars(daily: DailyBucket[], costPerToken: number = 0): string {
    if (!daily || daily.length === 0) return '<div class="deep-empty">No data for this period</div>';

    const sorted = [...daily].sort((a, b) => b.date.localeCompare(a.date));
    const maxTokens = Math.max(...sorted.map(d => usageTotal(d)), 1);

    let html = '<div class="deep-daily-chart">';
    for (const d of sorted) {
        const total = usageTotal(d);
        const barW = (total / maxTokens) * 100;
        const inPct = total > 0 ? (d.input / total * barW) : 0;
        const caPct = total > 0 ? (d.cache / total * barW) : 0;
        const ouPct = total > 0 ? (d.output / total * barW) : 0;
        const rePct = total > 0 ? ((d.reasoning || 0) / total * barW) : 0;

        let tipText = fmtShortDate(d.date) + '&#10;Input: ' + fmtBig(d.input) + '&#10;Cache: ' + fmtBig(d.cache) + '&#10;Output: ' + fmtBig(d.output) + '&#10;Total: ' + fmtBig(total) + ' (' + fmtNum(d.calls) + ' calls)';
        if (costPerToken > 0) {
            tipText += '&#10;Est. Cost: ' + fmtDollar(total * costPerToken);
        }
        html += '<div class="deep-daily-row" data-tip="' + tipText + '">';
        html += '<span class="deep-daily-date">' + fmtShortDate(d.date) + '</span>';
        html += '<div class="deep-daily-bar">';
        if (inPct > 0) html += '<div class="usage-bar-seg usage-c-input" style="width:' + inPct.toFixed(1) + '%"></div>';
        if (caPct > 0) html += '<div class="usage-bar-seg usage-c-cache" style="width:' + caPct.toFixed(1) + '%"></div>';
        if (ouPct > 0) html += '<div class="usage-bar-seg usage-c-output" style="width:' + ouPct.toFixed(1) + '%"></div>';
        if (rePct > 0) html += '<div class="usage-bar-seg usage-c-reasoning" style="width:' + rePct.toFixed(1) + '%"></div>';
        html += '</div>';
        html += '<span class="deep-daily-total">' + fmtBig(total) + '</span>';
        html += '</div>';
    }
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Hourly Heatmap (24-hour pattern)
// ═══════════════════════════════════════════

export function renderHourlyHeatmap(hourly: HourlyBucket[], costPerToken: number = 0): string {
    if (!hourly || hourly.length === 0) return '';

    const maxTokens = Math.max(...hourly.map(h => usageTotal(h)), 1);
    const peakHour = hourly.reduce((best, cur) =>
        usageTotal(cur) > usageTotal(best) ? cur : best, hourly[0]);

    let html = '<div class="deep-heatmap-wrap">';
    html += '<div class="deep-heatmap">';
    for (const h of hourly) {
        const total = usageTotal(h);
        const intensity = maxTokens > 0 ? (total / maxTokens) : 0;
        const isPeak = h.hour === peakHour.hour;
        const cls = isPeak ? ' deep-heatmap-peak' : '';
        const tipCls = h.hour <= 2 ? ' tip-right' : h.hour >= 22 ? ' tip-left' : '';
        let tipText = `${String(h.hour).padStart(2, '0')}:00`;
        tipText += `&#10;Tokens: ${fmtBig(total)}`;
        tipText += `&#10;Calls: ${fmtNum(h.calls)}`;
        if (total > 0) {
            tipText += `&#10;Input: ${fmtBig(h.input)}`;
            tipText += `&#10;Cache: ${fmtBig(h.cache)}`;
            tipText += `&#10;Output: ${fmtBig(h.output)}`;
        }
        if (costPerToken > 0 && total > 0) {
            tipText += `&#10;Cost: ~${fmtDollar(total * costPerToken)}`;
        }
        html += `<div class="deep-heatmap-cell${cls}${tipCls}" style="--intensity:${intensity.toFixed(3)}" data-tip="${tipText}">`;
        html += '<span class="deep-heatmap-hour">' + h.hour + '</span>';
        html += '</div>';
    }
    html += '</div>';
    html += '<div class="deep-heatmap-info">Peak: <strong>' + String(peakHour.hour).padStart(2, '0') + ':00</strong> (' + fmtBig(usageTotal(peakHour)) + ')</div>';
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  GitHub-style Daily Contribution Grid
// ═══════════════════════════════════════════

const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_INITIALS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];  // Date.getDay() order

/**
 * @param large — if true, uses gh-grid-lg class for bigger cells (detail panel)
 * @param year — which year to render (defaults to current year)
 * @param costPerToken — blended cost per token for cost estimation
 */
export function renderDailyGrid(daily: DailyBucket[], large: boolean = false, year?: number, costPerToken: number = 0): string {
    const selectedYear = year ?? new Date().getFullYear();
    const today = isoDay(new Date());

    // Build date → tokens lookup
    const dateMap = new Map<string, { total: number; calls: number }>();
    for (const d of daily) {
        if (!d.date.startsWith(String(selectedYear))) continue; // filter to selected year
        const total = usageTotal(d);
        dateMap.set(d.date, { total, calls: d.calls });
    }

    // Full year: Jan 1 → Dec 31
    const gridStartDate = new Date(selectedYear, 0, 1);   // Jan 1
    const gridEndDate = new Date(selectedYear, 11, 31);    // Dec 31

    // Align start to Monday
    const startDay = gridStartDate.getDay();
    const mondayOffset = startDay === 0 ? -6 : 1 - startDay;
    const gridStart = new Date(gridStartDate);
    gridStart.setDate(gridStart.getDate() + mondayOffset);

    // Extend end to Sunday
    const endDay = gridEndDate.getDay();
    const sundayOffset = endDay === 0 ? 0 : 7 - endDay;
    const gridEnd = new Date(gridEndDate);
    gridEnd.setDate(gridEnd.getDate() + sundayOffset);

    const maxTokens = Math.max(...Array.from(dateMap.values()).map(v => v.total), 1);

    type Cell = { date: string; total: number; calls: number; future: boolean };
    const weeks: Cell[][] = [];
    let currentWeek: Cell[] = [];
    const cursor = new Date(gridStart);
    let peakDay = { date: '', total: 0, calls: 0 };

    while (cursor <= gridEnd) {
        // The cursor is built from local dates (gridStart was created from getDate() math),
        // so it must be read back as a local date — toISOString re-interprets local midnight
        // as the previous day in UTC for positive offsets, shifting every cell backward by one.
        const iso = isoDay(cursor);
        const data = dateMap.get(iso);
        const total = data?.total || 0;
        const calls = data?.calls || 0;
        const future = iso > today;
        currentWeek.push({ date: iso, total, calls, future });
        if (total > peakDay.total) peakDay = { date: iso, total, calls };
        if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
        cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    // Month labels
    const lgCls = large ? ' gh-grid-lg' : '';
    let html = '<div class="gh-grid-wrap' + lgCls + '">';
    html += '<div class="gh-month-row"><span class="gh-day-label"></span>';
    let lastMonth = -1;
    for (const week of weeks) {
        const m = new Date(week[0].date + 'T00:00:00').getMonth();
        html += '<span class="gh-month-label">' + (m !== lastMonth ? MONTH_NAMES[m] : '') + '</span>';
        if (m !== lastMonth) lastMonth = m;
    }
    html += '</div>';

    // Grid
    html += '<div class="gh-grid">';
    html += '<div class="gh-day-col">';
    for (let row = 0; row < 7; row++) html += '<span class="gh-day-label">' + DAY_LABELS[row] + '</span>';
    html += '</div>';

    for (const week of weeks) {
        html += '<div class="gh-week-col">';
        for (const cell of week) html += gridCell(cell, maxTokens, costPerToken);
        html += '</div>';
    }
    html += '</div>';

    html += gridFooter(peakDay);
    html += '</div>';
    return html;
}

/** One heatmap square — shared by the year grid and the day strip. */
function gridCell(
    cell: { date: string; total: number; calls: number; future?: boolean },
    maxTokens: number,
    costPerToken: number,
): string {
    const level = cell.future || cell.total === 0 ? 0
        : (cell.total / maxTokens) < 0.15 ? 1
        : (cell.total / maxTokens) < 0.35 ? 2
        : (cell.total / maxTokens) < 0.65 ? 3 : 4;
    const costStr = (costPerToken > 0 && cell.total > 0) ? '&#10;~' + fmtDollar(cell.total * costPerToken) : '';
    const title = cell.future ? fmtShortDate(cell.date)
        : fmtShortDate(cell.date) + '&#10;' + (cell.total > 0 ? fmtBig(cell.total) + ' tokens&#10;' + fmtNum(cell.calls) + ' calls' + costStr : 'No activity');
    return '<div class="gh-cell gh-lvl-' + level + '" data-tip="' + title + '"></div>';
}

/** Legend + peak-day line shared by the year grid and the day strip. */
function gridFooter(peakDay: { date: string; total: number }): string {
    let html = '<div class="gh-footer">';
    html += '<span class="gh-legend">Less <span class="gh-cell gh-lvl-0 gh-sm"></span><span class="gh-cell gh-lvl-1 gh-sm"></span><span class="gh-cell gh-lvl-2 gh-sm"></span><span class="gh-cell gh-lvl-3 gh-sm"></span><span class="gh-cell gh-lvl-4 gh-sm"></span> More</span>';
    if (peakDay.total > 0) {
        html += '<span class="gh-peak">Peak: <strong>' + fmtShortDate(peakDay.date) + '</strong> (' + fmtBig(peakDay.total) + ')</span>';
    }
    html += '</div>';
    return html;
}

/**
 * Day strip — one square per day across exactly the selected period.
 *
 * The year grid is the wrong shape for a short range: a 7d filter lights one
 * column and leaves ~52 empty ones. Here every square is inside the window, and
 * the colour scale is relative to the window's own peak, so a quiet week still
 * shows contrast instead of washing out against an all-time maximum.
 */
export function renderDayStrip(
    daily: DailyBucket[],
    large: boolean,
    window: { from: string; to: string },
    costPerToken: number = 0,
): string {
    const today = isoDay(new Date());
    const dateMap = new Map<string, { total: number; calls: number }>();
    for (const d of daily) dateMap.set(d.date, { total: usageTotal(d), calls: d.calls });

    type Cell = { date: string; total: number; calls: number; future: boolean };
    const days: Cell[] = [];
    const cursor = new Date(window.from + 'T00:00:00');
    const end = new Date(window.to + 'T00:00:00');
    let peakDay = { date: '', total: 0 };

    while (cursor <= end && days.length < 400) {
        const iso = isoDay(cursor);
        const data = dateMap.get(iso);
        const total = data?.total || 0;
        days.push({ date: iso, total, calls: data?.calls || 0, future: iso > today });
        if (total > peakDay.total) peakDay = { date: iso, total };
        cursor.setDate(cursor.getDate() + 1);
    }

    const maxTokens = Math.max(...days.map(d => d.total), 1);
    // Past ~10 squares there is no room to label every one; tick weekly instead.
    const labelEvery = days.length > 10;

    let html = '<div class="gh-strip-wrap' + (large ? ' gh-strip-lg' : '') + '">';
    html += '<div class="gh-strip">';
    // Tracks the last *labelled* month, not the last cell's — otherwise a silent
    // cell swallows the rollover and the strip never names the new month.
    let lastLabeledMonth = -1;
    for (let i = 0; i < days.length; i++) {
        const cell = days[i];
        const dt = new Date(cell.date + 'T00:00:00');

        let label = '';
        if (!labelEvery || i % 7 === 0 || i === days.length - 1) {
            label = dt.getMonth() !== lastLabeledMonth
                ? MONTH_NAMES[dt.getMonth()] + ' ' + dt.getDate()
                : (labelEvery ? String(dt.getDate()) : DAY_INITIALS[dt.getDay()] + ' ' + dt.getDate());
            lastLabeledMonth = dt.getMonth();
        }

        html += '<div class="gh-strip-day">';
        html += gridCell(cell, maxTokens, costPerToken);
        html += '<span class="gh-strip-label">' + label + '</span>';
        html += '</div>';
    }
    html += '</div>';

    html += gridFooter(peakDay);
    html += '</div>';
    return html;
}

/** Extract available years from daily data (sorted descending) */
export function getAvailableYears(daily: DailyBucket[]): number[] {
    if (!daily || daily.length === 0) return [new Date().getFullYear()];
    const years = new Set<number>();
    for (const d of daily) {
        if (d.date.length >= 4) years.add(parseInt(d.date.slice(0, 4), 10));
    }
    return Array.from(years).sort((a, b) => b - a); // newest first
}

/** Year selector buttons */
export function renderYearSelector(years: number[], activeYear: number): string {
    if (years.length <= 1) return ''; // single year — no need for selector
    let html = '<div class="gh-year-bar">';
    for (const y of years) {
        const active = y === activeYear ? ' active' : '';
        html += '<button class="gh-year-btn' + active + '" data-action="set-grid-year" data-year="' + y + '">' + y + '</button>';
    }
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Model Breakdown
// ═══════════════════════════════════════════

export function renderModelBreakdown(models: ModelBucket[], totalTokens: number): string {
    if (!models || models.length === 0) return '';

    let html = '';
    for (const m of models) {
        const mTotal = usageTotal(m);
        const pct = totalTokens > 0 ? (mTotal / totalTokens * 100).toFixed(1) : '0';
        const barPct = totalTokens > 0 ? (mTotal / totalTokens * 100) : 0;

        html += '<div class="deep-model">';
        // Header: name + total + pct
        html += '<div class="deep-model-hdr">';
        html += '<span class="deep-model-name">' + escHtml(m.displayName) + '</span>';
        html += '<span class="deep-model-stats">' + fmtNum(mTotal) + ' <span class="deep-model-pct">' + pct + '%</span></span>';
        html += '</div>';
        // Stacked progress bar (input + cache + output)
        html += '<div class="deep-model-bar">';
        if (mTotal > 0) {
            const inW = (m.input / mTotal * 100).toFixed(1);
            const caW = (m.cache / mTotal * 100).toFixed(1);
            const ouW = (m.output / mTotal * 100).toFixed(1);
            const reW = ((m.reasoning || 0) / mTotal * 100).toFixed(1);
            html += '<div class="usage-bar-seg usage-c-input" style="width:' + inW + '%"></div>';
            html += '<div class="usage-bar-seg usage-c-cache" style="width:' + caW + '%"></div>';
            html += '<div class="usage-bar-seg usage-c-output" style="width:' + ouW + '%"></div>';
            if ((m.reasoning || 0) > 0) html += '<div class="usage-bar-seg usage-c-reasoning" style="width:' + reW + '%"></div>';
        } else {
            html += '<div class="deep-model-fill" style="width:0%"></div>';
        }
        html += '</div>';
        // Detail: ● input · ● cache · ● output
        html += '<div class="deep-model-detail">';
        html += '<span><span class="usage-dot usage-c-input"></span>' + fmtNum(m.input) + ' in</span>';
        html += '<span><span class="usage-dot usage-c-cache"></span>' + fmtNum(m.cache) + ' cache</span>';
        html += '<span><span class="usage-dot usage-c-output"></span>' + fmtNum(m.output) + ' out</span>';
        if ((m.reasoning || 0) > 0) {
            html += '<span><span class="usage-dot usage-c-reasoning"></span>' + fmtNum(m.reasoning) + ' reas.</span>';
        }
        html += '</div>';
        html += '<div class="deep-model-calls">' + fmtNum(m.calls) + ' calls</div>';
        html += '</div>';
    }
    return html;
}

// ═══════════════════════════════════════════
//  Cascade / Conversation List
// ═══════════════════════════════════════════

export function renderCascadeList(cascades: CascadeBucket[], limit: number = CASCADE_LIST_LIMIT, maxTitleLen: number = CASCADE_TITLE_MAX_LEN): string {
    const shown = cascades.slice(0, limit);

    let html = '<div class="deep-cascade-list">';
    for (const c of shown) {
        const total = usageTotal(c);
        const title = c.title || 'Conversation';
        const short = title.length > maxTitleLen ? title.substring(0, maxTitleLen) + '…' : title;

        html += '<div class="deep-cascade-row">';
        html += '<span class="deep-cascade-title">' + escHtml(short) + '</span>';
        html += '<span class="deep-cascade-tokens">' + fmtBig(total) + '</span>';
        html += '</div>';
    }
    if (cascades.length > limit) {
        html += '<div class="deep-cascade-more">+' + (cascades.length - limit) + ' more</div>';
    }
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Estimated API Cost
// ═══════════════════════════════════════════

/** Per-1M-token pricing — updated April 2026 */
export type PricingEntry = { input: number; output: number; cache: number; reasoning: number };

/** External pricing resolver — injected by extension at boot (e.g. LiteLLM catalog) */
let externalResolver: ((displayName: string) => PricingEntry | null) | null = null;

/** Register an external pricing resolver (e.g. LiteLLM dynamic catalog) */
export function setExternalPricingResolver(resolver: (displayName: string) => PricingEntry | null): void {
    externalResolver = resolver;
}

let pricing: Record<string, PricingEntry> = {
    // Claude family (Anthropic) — reasoning = output rate per Anthropic pricing
    opus:           { input: 5.00,  output: 25.00, cache: 0.50, reasoning: 25.00 },
    sonnet:         { input: 3.00,  output: 15.00, cache: 0.30, reasoning: 15.00 },
    haiku:          { input: 1.00,  output: 5.00,  cache: 0.10, reasoning: 5.00 },
    // Gemini 3.x family
    'gemini-3-pro':   { input: 2.00,  output: 12.00, cache: 0.20, reasoning: 12.00 },
    'gemini-3-flash': { input: 0.50,  output: 3.00,  cache: 0.05, reasoning: 3.00 },
    // Gemini 2.5 family (deprecated June 2026)
    'gemini-2-pro':   { input: 1.25,  output: 10.00, cache: 0.125, reasoning: 10.00 },
    'gemini-2-flash': { input: 0.30,  output: 2.50,  cache: 0.03, reasoning: 2.50 },
    'flash-lite':     { input: 0.10,  output: 0.40,  cache: 0.01, reasoning: 0.40 },
    // Other
    'gpt-oss':      { input: 2.50,  output: 10.00, cache: 0.25, reasoning: 10.00 },
};

/** Override pricing at runtime (called from extension with VS Code settings) */
export function updatePricing(overrides: Record<string, Partial<PricingEntry>>): void {
    for (const [key, val] of Object.entries(overrides)) {
        if (val && typeof val.input === 'number') {
            pricing[key] = {
                input: val.input ?? pricing[key]?.input ?? 3,
                output: val.output ?? pricing[key]?.output ?? 15,
                cache: val.cache ?? pricing[key]?.cache ?? 0.3,
                reasoning: val.reasoning ?? val.output ?? pricing[key]?.reasoning ?? 15,
            };
        }
    }
}

/** Export current pricing for webview injection */
export function getPricing(): Record<string, PricingEntry> {
    return { ...pricing };
}

export function matchPricing(displayName: string, pricingKey?: string): PricingEntry {
    // 1. External resolver (LiteLLM dynamic catalog — highest priority after settings override)
    if (externalResolver) {
        // The id first — the catalog is keyed by id, and the display label
        // matches nothing. Falling back to the label costs one failed lookup
        // and keeps older cached buckets, which carry no id, working.
        const external = (pricingKey && externalResolver(pricingKey)) || externalResolver(displayName);
        if (external) return external;
    }

    // 2. Hardcoded fallback — keyword-based heuristic matching
    const lower = displayName.toLowerCase();
    // Claude tiers
    if (lower.includes('opus'))   return pricing['opus'];
    if (lower.includes('haiku'))  return pricing['haiku'];
    if (lower.includes('sonnet')) return pricing['sonnet'];
    // Gemini tiers — version-aware (2.5 vs 3.x)
    if (lower.includes('flash lite') || lower.includes('flash-lite'))  return pricing['flash-lite'];
    if (lower.includes('checkpoint'))  return { input: 0, output: 0, cache: 0, reasoning: 0 };
    const is25 = lower.includes('2.5') || lower.includes('2_5');
    if (lower.includes('flash'))  return pricing[is25 ? 'gemini-2-flash' : 'gemini-3-flash'];
    if (lower.includes('pro') || lower.includes('gemini'))
        return pricing[is25 ? 'gemini-2-pro' : 'gemini-3-pro'];
    // GPT
    if (lower.includes('gpt'))    return pricing['gpt-oss'];
    return pricing['sonnet']; // fallback
}

/** Smart dollar format: $0.42 for small, $15 for large */
export function fmtDollar(v: number): string {
    if (v < 0.01) return '$0';
    if (v < 1)    return '$' + v.toFixed(2);
    if (v < 10)   return '$' + v.toFixed(1);
    return '$' + Math.round(v).toLocaleString();
}

/** Calculate total estimated cost from model data */
export function calculateTotalCost(models: ModelBucket[]): number {
    if (!models || models.length === 0) return 0;
    let total = 0;
    for (const m of models) {
        // An unrecognised model has no rate. Pricing it at zero would understate
        // cost silently. The prefix is a literal, not imported from enumMap, because
        // this file is bundled for the browser webview while enumMap is extension-host only.
        if (m.displayName && m.displayName.startsWith('MODEL_UNKNOWN_')) continue;
        const p = matchPricing(m.displayName, m.rawModel);
        total += (m.input / 1e6) * p.input
            + ((m.cache || 0) / 1e6) * p.cache
            + ((m.cacheWrite || 0) / 1e6) * (p.input * 1.25)
            + (m.output / 1e6) * p.output
            + ((m.reasoning || 0) / 1e6) * p.reasoning;
    }
    return total;
}

/**
 * Compact model breakdown — sidebar version.
 * Shows only: model name + single bar + percentage. No in/cache/out detail.
 */
export function renderCompactModelBreakdown(models: ModelBucket[], totalTokens: number): string {
    if (!models || models.length === 0) return '';

    let html = '';
    for (const m of models) {
        const mTotal = usageTotal(m);
        const pct = totalTokens > 0 ? (mTotal / totalTokens * 100).toFixed(1) : '0';
        const barPct = totalTokens > 0 ? (mTotal / totalTokens * 100) : 0;

        html += '<div class="deep-model-compact">';
        html += '<div class="deep-model-hdr">';
        html += '<span class="deep-model-name">' + escHtml(m.displayName) + '</span>';
        html += '<span class="deep-model-pct">' + pct + '%</span>';
        html += '</div>';
        html += '<div class="deep-model-bar"><div class="usage-bar-seg usage-c-input" style="width:' + barPct.toFixed(1) + '%"></div></div>';
        html += '<div class="deep-model-detail">';
        html += '<span><span class="usage-dot usage-c-input"></span>' + fmtBig(m.input) + '</span>';
        html += '<span><span class="usage-dot usage-c-cache"></span>' + fmtBig(m.cache || 0) + '</span>';
        html += '<span><span class="usage-dot usage-c-output"></span>' + fmtBig(m.output) + '</span>';
        if ((m.reasoning || 0) > 0) {
            html += '<span><span class="usage-dot usage-c-reasoning"></span>' + fmtBig(m.reasoning) + ' reas.</span>';
        }
        html += '</div>';
        html += '</div>';
    }
    return html;
}

// ═══════════════════════════════════════════
//  Monthly Column Chart (calendar year, filter-independent)
// ═══════════════════════════════════════════

/** Estimate cost for a single month bucket using per-model pricing */
function estimateTopModelCosts(m: MonthlyBucket): MonthlyModelEntry[] {
    return m.topModels.map(tm => {
        // An unrecognised model has no rate. Pricing it at zero would understate
        // cost silently. The prefix is a literal, not imported from enumMap, because
        // this file is bundled for the browser webview while enumMap is extension-host only.
        if (tm.displayName && tm.displayName.startsWith('MODEL_UNKNOWN_')) {
            return { ...tm, cost: 0 };
        }
        const p = matchPricing(tm.displayName, tm.rawModel);
        const cost = (tm.inp * p.input + tm.cache * p.cache + (tm.cacheWrite || 0) * (p.input * 1.25) + tm.out * p.output + tm.reas * p.reasoning) / 1_000_000;
        return { ...tm, cost };
    });
}

/** Extract unique years from monthly data (newest first) */
export function getMonthlyYears(monthly: MonthlyBucket[]): number[] {
    if (!monthly || monthly.length === 0) return [new Date().getFullYear()];
    const years = new Set<number>();
    for (const m of monthly) {
        if (m.key.length >= 4) years.add(parseInt(m.key.slice(0, 4), 10));
    }
    return Array.from(years).sort((a, b) => b - a); // newest first
}

export function renderMonthlySummary(monthly: MonthlyBucket[], filterYear?: number): string {
    if (!monthly || monthly.length === 0) return '';

    // Filter to selected year (if provided), otherwise show all
    const MNAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let displayMonths: MonthlyBucket[];

    if (filterYear) {
        // Build full Jan-Dec for the year, filling gaps with empties
        const yearMap = new Map<number, MonthlyBucket>();
        for (const m of monthly) {
            if (m.key.startsWith(String(filterYear))) {
                yearMap.set(parseInt(m.key.slice(5, 7), 10) - 1, m);
            }
        }
        displayMonths = [];
        for (let i = 0; i < 12; i++) {
            displayMonths.push(yearMap.get(i) || {
                key: `${filterYear}-${String(i + 1).padStart(2, '0')}`,
                label: MNAMES[i],
                input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0,
                total: 0, cost: 0, topModels: [],
            });
        }
    } else {
        displayMonths = monthly;
    }

    if (displayMonths.length === 0) return '';

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const maxTotal = Math.max(...displayMonths.map(m => m.total), 1);
    const BAR_HEIGHT = 110;

    let html = '<div class="deep-mchart">';

    for (const m of displayMonths) {
        const topModels = estimateTopModelCosts(m);
        const isCurrent = m.key === currentMonthKey;
        const isEmpty = m.total === 0;
        const totalH = (m.total / maxTotal) * BAR_HEIGHT;
        const inH = m.total > 0 ? (m.input / m.total * totalH) : 0;
        const caH = m.total > 0 ? (m.cache / m.total * totalH) : 0;
        const ouH = m.total > 0 ? (m.output / m.total * totalH) : 0;
        const reH = m.total > 0 ? ((m.reasoning || 0) / m.total * totalH) : 0;

        const colCls = 'deep-mcol' + (isCurrent ? ' deep-mcol-current' : '') + (isEmpty ? ' deep-mcol-empty' : '');

        html += '<div class="' + colCls + '">';

        // Custom floating tooltip
        if (!isEmpty) {
            html += '<div class="deep-mcol-tip">';
            html += '<div class="deep-mcol-tip-hdr">' + m.label + (isCurrent ? ' <span class="deep-mcol-tip-badge">current</span>' : '') + '</div>';
            html += '<div class="deep-mcol-tip-row"><span>Tokens</span><span>' + fmtBig(m.total) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span>Cost</span><span class="deep-mcol-tip-cost">' + fmtDollar(m.cost) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span>Calls</span><span>' + fmtNum(m.calls) + '</span></div>';
            html += '<div class="deep-mcol-tip-sep"></div>';
            html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#4f9cf7"></span>Input</span><span>' + fmtBig(m.input) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#a78bfa"></span>Cache</span><span>' + fmtBig(m.cache) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#4ade80"></span>Output</span><span>' + fmtBig(m.output) + '</span></div>';
            if (m.reasoning > 0) {
                html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#f59e0b"></span>Reasoning</span><span>' + fmtBig(m.reasoning) + '</span></div>';
            }
            if (topModels.length > 0) {
                html += '<div class="deep-mcol-tip-sep"></div>';
                html += '<div class="deep-mcol-tip-models-hdr">Models</div>';
                for (const tm of topModels.slice(0, 5)) {
                    html += '<div class="deep-mcol-tip-model">';
                    html += '<span>' + escHtml(tm.displayName) + '</span>';
                    html += '<span>' + fmtBig(tm.tokens) + ' · ' + fmtDollar(tm.cost) + '</span>';
                    html += '</div>';
                }
            }
            html += '</div>';
        }

        // Value above bar
        if (!isEmpty) {
            html += '<div class="deep-mcol-val">' + fmtDollar(m.cost) + '</div>';
        } else {
            html += '<div class="deep-mcol-val deep-mcol-val-empty">—</div>';
        }
        // Stacked bar
            html += '<div class="deep-mcol-stack" style="height:' + BAR_HEIGHT + 'px">';
        if (!isEmpty) {
            if (reH > 0) html += '<div class="deep-mcol-seg" style="height:' + reH.toFixed(1) + 'px;background:#f59e0b"></div>';
            html += '<div class="deep-mcol-seg" style="height:' + ouH.toFixed(1) + 'px;background:#4ade80"></div>';
            html += '<div class="deep-mcol-seg" style="height:' + caH.toFixed(1) + 'px;background:#a78bfa"></div>';
            html += '<div class="deep-mcol-seg" style="height:' + inH.toFixed(1) + 'px;background:#4f9cf7"></div>';
        } else {
            html += '<div class="deep-mcol-seg deep-mcol-ghost" style="height:4px"></div>';
        }
        html += '</div>';
        // Month label
        html += '<div class="deep-mcol-lbl">' + m.label + '</div>';
        // Call count
        if (!isEmpty) {
            html += '<div class="deep-mcol-sub">' + fmtBig(m.total) + '</div>';
        }
        html += '</div>';
    }

    // Legend
    html += '</div>';
    html += '<div class="deep-mchart-legend">';
    html += '<span><span class="usage-dot usage-c-input"></span>Input</span>';
    html += '<span><span class="usage-dot usage-c-cache"></span>Cache</span>';
    html += '<span><span class="usage-dot usage-c-output"></span>Output</span>';
    html += '<span><span class="usage-dot usage-c-reasoning"></span>Reasoning</span>';
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Provider Breakdown
// ═══════════════════════════════════════════

const PROVIDER_COLORS: Record<string, string> = {
    'Claude (Vertex)': '#a78bfa',   // purple for Anthropic
    'Gemini': '#4f9cf7',            // blue for Google
    'OpenAI': '#4ade80',            // green for OpenAI
};

export function renderProviderBreakdown(providers: ProviderBucket[], totalTokens: number): string {
    if (!providers || providers.length === 0) return '<div class="deep-empty">No provider data</div>';

    let html = '<div class="provider-breakdown">';

    // Stacked horizontal bar
    html += '<div class="provider-stack-bar">';
    for (const p of providers) {
        const total = usageTotal(p);
        const pct = totalTokens > 0 ? (total / totalTokens * 100) : 0;
        if (pct < 0.5) continue;
        const color = PROVIDER_COLORS[p.displayName] || '#666';
        html += `<div class="provider-stack-seg" style="width:${pct.toFixed(1)}%;background:${color}" title="${escHtml(p.displayName)}: ${pct.toFixed(1)}%"></div>`;
    }
    html += '</div>';

    // Legend rows
    for (const p of providers) {
        const total = usageTotal(p);
        const pct = totalTokens > 0 ? (total / totalTokens * 100).toFixed(1) : '0';
        const color = PROVIDER_COLORS[p.displayName] || '#666';
        html += '<div class="provider-row">';
        html += `<span class="provider-dot" style="background:${color}"></span>`;
        html += `<span class="provider-name">${escHtml(p.displayName)}</span>`;
        html += `<span class="provider-pct">${pct}%</span>`;
        html += `<span class="provider-tokens">${fmtBig(total)}</span>`;
        html += `<span class="provider-calls">${fmtNum(p.calls)} calls</span>`;
        html += '</div>';
    }

    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Day-of-Week Distribution
// ═══════════════════════════════════════════

export function renderWeekdayChart(weekday: WeekdayBucket[]): string {
    if (!weekday || weekday.length === 0) return '<div class="deep-empty">No data</div>';

    // FORK CHANGE: plot token usage (input+output), not call count. Upstream plotted
    // `w.calls`, which is dominated by long agentic sessions firing many small calls (one
    // outlier day spikes its weekday). Cache reads are excluded on purpose — they are
    // repeated context re-reads that balloon on long sessions and distort the pattern.
    const tok = (w: WeekdayBucket) => w.input + w.output;
    const maxTok = Math.max(...weekday.map(tok), 1);
    const peakDay = weekday.reduce((a, b) => tok(b) > tok(a) ? b : a);
    const BAR_H = 80;

    let html = '<div class="weekday-chart">';
    for (const w of weekday) {
        const v = tok(w);
        const h = (v / maxTok) * BAR_H;
        const isPeak = w.day === peakDay.day;
        const cls = 'weekday-col' + (isPeak ? ' weekday-peak' : '');

        html += `<div class="${cls}">`;
        html += `<div class="weekday-val">${fmtBig(v)}</div>`;
        html += `<div class="weekday-bar-wrap" style="height:${BAR_H}px">`;
        html += `<div class="weekday-bar" style="height:${h.toFixed(1)}px"></div>`;
        html += '</div>';
        html += `<div class="weekday-lbl">${w.label}</div>`;
        html += '</div>';
    }
    html += '</div>';

    // Summary line (token share, not calls)
    const weekdayTok = weekday.filter(w => w.day < 5).reduce((s, w) => s + tok(w), 0);
    const weekendTok = weekday.filter(w => w.day >= 5).reduce((s, w) => s + tok(w), 0);
    const total = weekdayTok + weekendTok;
    const weekdayPct = total > 0 ? Math.round(weekdayTok / total * 100) : 0;
    html += `<div class="weekday-summary">Weekday ${weekdayPct}% · Weekend ${100 - weekdayPct}% · Peak: <strong>${peakDay.label}</strong></div>`;

    return html;
}

// ═══════════════════════════════════════════
//  Enriched Cascade List (with cost + mini bar)
// ═══════════════════════════════════════════

/** Render a single cascade row — shared between shown and overflow sections */
function renderCascadeRow(c: CascadeBucket, cpt: number, maxTokens: number, maxTitleLen: number): string {
    const total = usageTotal(c);
    const cost = total * cpt;
    const title = c.title || 'Conversation';
    const short = title.length > maxTitleLen ? title.substring(0, maxTitleLen) + '…' : title;
    const barW = (total / maxTokens * 100);
    const inPct = total > 0 ? (c.input / total * barW) : 0;
    const caPct = total > 0 ? (c.cache / total * barW) : 0;
    const ouPct = total > 0 ? (c.output / total * barW) : 0;
    const rePct = total > 0 ? ((c.reasoning || 0) / total * barW) : 0;

    let html = '<div class="cascade-row">';
    html += '<div class="cascade-header">';
    html += `<span class="cascade-title">${escHtml(short)}</span>`;
    html += `<span class="cascade-cost">${fmtDollar(cost)}</span>`;
    html += '</div>';
    html += '<div class="cascade-meta">';
    html += '<div class="cascade-bar">';
    if (inPct > 0) html += `<div class="usage-bar-seg usage-c-input" style="width:${inPct.toFixed(1)}%"></div>`;
    if (caPct > 0) html += `<div class="usage-bar-seg usage-c-cache" style="width:${caPct.toFixed(1)}%"></div>`;
    if (ouPct > 0) html += `<div class="usage-bar-seg usage-c-output" style="width:${ouPct.toFixed(1)}%"></div>`;
    if (rePct > 0) html += `<div class="usage-bar-seg usage-c-reasoning" style="width:${rePct.toFixed(1)}%"></div>`;
    html += '</div>';
    html += `<span class="cascade-stats">${fmtBig(total)} · ${fmtNum(c.calls)} calls</span>`;
    html += '</div>';
    html += '</div>';
    return html;
}

export function renderEnrichedCascadeList(cascades: CascadeBucket[], models: ModelBucket[], limit: number = CASCADE_ENRICHED_LIMIT, maxTitleLen: number = CASCADE_ENRICHED_TITLE_MAX_LEN): string {
    const shown = cascades.slice(0, limit);
    if (shown.length === 0) return '<div class="deep-empty">No conversations</div>';

    // Compute average cost-per-token from model data for estimation
    const totalCost = calculateTotalCost(models);
    const totalT = models.reduce((s, m) => s + usageTotal(m), 0);
    const cpt = totalT > 0 ? totalCost / totalT : 0;

    const maxTokens = Math.max(...shown.map(c => usageTotal(c)), 1);

    let html = '<div class="cascade-enriched">';
    for (const c of shown) html += renderCascadeRow(c, cpt, maxTokens, maxTitleLen);

    // Render overflow items (hidden by default)
    if (cascades.length > limit) {
        const overflow = cascades.slice(limit);
        html += '<div class="cascade-overflow" style="display:none">';
        for (const c of overflow) html += renderCascadeRow(c, cpt, maxTokens, maxTitleLen);
        html += '</div>';
        html += `<button class="cascade-more-btn" data-cascade-toggle="true" data-overflow-count="${overflow.length}">+${overflow.length} more</button>`;
    }
    html += '</div>';
    return html;
}


export function renderCostEstimate(models: ModelBucket[]): string {
    if (!models || models.length === 0) return '<div class="deep-empty">No model data</div>';

    let html = '<div class="deep-cost-table">';
    html += '<div class="deep-cost-row deep-cost-header">';
    html += '<span class="deep-cost-model">Model</span>';
    html += '<span class="deep-cost-val">Input</span>';
    html += '<span class="deep-cost-val">Cache</span>';
    html += '<span class="deep-cost-val">Output</span>';
    html += '<span class="deep-cost-val">Reas.</span>';
    html += '<span class="deep-cost-val deep-cost-total">Total</span>';
    html += '</div>';

    let grandTotal = 0;

    for (const m of models) {
        // An unrecognised model has no rate. Pricing it at zero would understate
        // cost silently. The prefix is a literal, not imported from enumMap, because
        // this file is bundled for the browser webview while enumMap is extension-host only.
        if (m.displayName && m.displayName.startsWith('MODEL_UNKNOWN_')) continue;
        const p = matchPricing(m.displayName, m.rawModel);
        const inputCost    = (m.input / 1e6) * p.input;
        const cacheCost    = ((m.cache || 0) / 1e6) * p.cache;
        const outputCost   = (m.output / 1e6) * p.output;
        const reasonCost   = ((m.reasoning || 0) / 1e6) * p.reasoning;
        const rowTotal     = inputCost + cacheCost + outputCost + reasonCost;
        grandTotal += rowTotal;

        if (rowTotal < 0.01) continue;

        html += '<div class="deep-cost-row">';
        html += '<span class="deep-cost-model">' + escHtml(m.displayName) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(inputCost) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(cacheCost) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(outputCost) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(reasonCost) + '</span>';
        html += '<span class="deep-cost-val deep-cost-total">' + fmtDollar(rowTotal) + '</span>';
        html += '</div>';
    }

    html += '<div class="deep-cost-row deep-cost-grand">';
    html += '<span class="deep-cost-model">TOTAL</span>';
    html += '<span class="deep-cost-val"></span><span class="deep-cost-val"></span><span class="deep-cost-val"></span><span class="deep-cost-val"></span>';
    html += '<span class="deep-cost-val deep-cost-total">' + fmtDollar(grandTotal) + '</span>';
    html += '</div></div>';
    html += '<div class="deep-cost-note">Based on current API pricing. Reasoning priced per model (may differ from output rate).</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Range Bar
// ═══════════════════════════════════════════

const RANGES = [
    { id: '24h', label: '24h' },
    { id: '7d', label: '7d' },
    { id: '30d', label: '30d' },
    { id: 'all', label: 'All Time' },
] as const;

export function renderRangeBar(activeRange: string, cssPrefix: string = 'deep'): string {
    let html = `<div class="${cssPrefix}-range-bar" id="usageRangeBar">`;
    for (const r of RANGES) {
        const active = activeRange === r.id ? ' active' : '';
        html += `<button class="${cssPrefix}-range-btn${active}" data-action="set-usage-range" data-range="${r.id}">${r.label}</button>`;
    }
    html += '</div>';
    return html;
}

export function rangeLabel(state: string): string {
    switch (state) {
        case '24h':        return 'Last 24h';
        case '7d':         return 'Last 7 Days';
        case '30d':        return 'Last 30 Days';
        case 'today':      return 'Today';
        case 'this-week':  return 'This Week';
        case 'this-month': return 'This Month';
        case 'last-month': return 'Last Month';
        default:           return 'All Time';
    }
}

// ═══════════════════════════════════════════
//  Honest Empty State
// ═══════════════════════════════════════════

/**
 * A range with no calls renders as an explicit statement, never a wall of
 * zeros. A silent zero is indistinguishable from a broken tool — that is
 * exactly how the store-blindness bug presented for four days.
 */
export function renderEmptyRange(lastActivityIso: string | null, rangeLabelText: string): string {
    let html = '<div class="usage-empty-range">';
    html += `<div class="usage-empty-title">No activity in ${escHtml(rangeLabelText)}</div>`;
    html += lastActivityIso
        ? `<div class="usage-empty-sub">Last session ${fmtShortDate(lastActivityIso.slice(0, 10))}</div>`
        : '<div class="usage-empty-sub">No usage recorded yet</div>';
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Data Health Card
// ═══════════════════════════════════════════

export type UsageHealth = {
    source: 'store' | 'server';
    conversations: number;
    unreadable: number;
    unknownModels: string[];
    /**
     * gen_metadata rows only (the canonical accounting table) that were read
     * but produced no entry — e.g. a cancelled streaming request, which
     * legitimately carries no usage. Does NOT cover steps rows: most steps
     * are not model calls at all, so a combined count would be dominated by
     * that normal noise rather than signal a regression (see
     * readGenMetadata's doc comment). Nothing else distinguishes the normal
     * case from a decode regression silently dropping rows; both are simply
     * absent entries from outside. The card's label names this scope
     * explicitly — do not relabel it as an unqualified total.
     */
    skippedRows: number;
    verification: { compared: number; diverged: number; at: string } | null;
    countingChangedAt: string | null;
};

/**
 * Says plainly where numbers came from and what would make them wrong.
 *
 * The cross-check line has THREE possible states, not two:
 *   - verification is null        -> the verifier has not run; no line at all.
 *   - compared is 0                -> it ran, but every sampled conversation was
 *                                     one the language server could no longer
 *                                     serve — the normal condition this whole
 *                                     plan exists to work around. Rendering this
 *                                     as "clean" would manufacture exactly the
 *                                     false confidence the verifier exists to
 *                                     prevent, so it says "not verified" instead.
 *   - compared > 0                 -> a real comparison happened; only this case
 *                                     may say "clean".
 */
export function renderHealthCard(h: UsageHealth): string {
    const rows: string[] = [];
    rows.push(`<div class="uh-row"><span>Source</span><span>${h.source === 'store' ? 'conversation store' : 'language server (legacy)'}</span></div>`);
    rows.push(`<div class="uh-row"><span>Conversations read</span><span>${fmtNum(h.conversations)}</span></div>`);
    if (h.unreadable > 0) {
        rows.push(`<div class="uh-row uh-warn"><span>Unreadable</span><span>${fmtNum(h.unreadable)} — will retry</span></div>`);
    }
    if (h.unknownModels.length > 0) {
        rows.push(`<div class="uh-row uh-warn"><span>Unrecognised models</span><span>${h.unknownModels.length} — excluded from cost</span></div>`);
    }
    if (h.skippedRows > 0) {
        // Labelled "metadata" explicitly: this counts gen_metadata rows only
        // (the canonical accounting table), not steps rows — see
        // readGenMetadata's doc comment for why. A reader relying on this as
        // a trust signal needs to know its scope, not just its value.
        rows.push(`<div class="uh-row"><span>Metadata rows skipped</span><span>${fmtNum(h.skippedRows)} — read, produced no entry</span></div>`);
    }
    if (h.verification) {
        const v = h.verification;
        // Labelled "Token counts", not "Cross-check": the verifier checks token
        // counts against the language server, not dollar rates. This card sits
        // directly beneath an estimated-cost figure that is itself ~95% keyword
        // guesswork on real data (most models resolve to a Placeholder M<n> with
        // no catalogue entry) — an unqualified "Cross-check: clean" reads as
        // vouching for the money, which this row never checked.
        if (v.compared === 0) {
            rows.push(`<div class="uh-row"><span>Token counts</span><span>not verified this run</span></div>`);
        } else if (v.diverged === 0) {
            rows.push(`<div class="uh-row"><span>Token counts</span><span>clean across ${fmtNum(v.compared)} calls</span></div>`);
        } else {
            rows.push(`<div class="uh-row uh-warn"><span>Token counts</span><span>${fmtNum(v.diverged)} divergences of ${fmtNum(v.compared)}</span></div>`);
        }
    }
    if (h.countingChangedAt) {
        rows.push(`<div class="uh-note">Counting changed on ${fmtShortDate(h.countingChangedAt)}: recovered sessions the language server could not see, sub-agent runs, local-time day bucketing (previously UTC), global deduplication, and live pricing that had silently never applied are all reflected now. Past figures have been restated — this is not only a change going forward.</div>`);
    }
    return `<div class="up-card up-bento-full"><div class="up-card-hdr">Data health</div>${rows.join('')}</div>`;
}

// ═══════════════════════════════════════════
//  Claude Account Facet & Provider Sections
// ═══════════════════════════════════════════

export interface AccountFacetRow {
    label: string;
    accountUuid: string | null;
    tokens: number;
    /** null when the underlying rows are day rollups, where a count is meaningless. */
    calls: number | null;
    from: string;
    to: string;
    note?: string;
}

/**
 * Group Claude usage by account.
 *
 * Rows read after this feature shipped carry `accountKey`. Older rows do not,
 * and resolve through claudePins. The archive is a day rollup: one entry per
 * model per day, so counting its entries yields 175 for six months of work.
 * That renders as null, never as a number.
 */
const ROLLUP_NOTE = 'day rollup — thinking not broken out';

/** What accountFacetFor needs from discoverClaudeAccounts — see the import comment above. */
export type ClaudeAccountLookup = () => Array<{ email: string; accountUuid: string }>;

/** External account resolver — injected by the extension host at boot (discoverClaudeAccounts). */
let claudeAccountResolver: ClaudeAccountLookup | null = null;

/**
 * Register the real discoverClaudeAccounts() (extension-host only, touches
 * fs/path/os — see the import comment above for why it cannot be imported
 * directly here). Until this is called, accountFacetFor still resolves every
 * account's uuid/tokens/calls correctly; it only falls back to the uuid (or
 * a pinned email, when one applies) instead of a discovered email for a
 * stamped row's label.
 */
export function setClaudeAccountResolver(resolver: ClaudeAccountLookup): void {
    claudeAccountResolver = resolver;
}

export function accountFacetFor(
    perConvo: Record<string, ConvoTokenData>,
): AccountFacetRow[] {
    // Stamped rows carry a uuid; look up the email so the panel never shows a raw uuid.
    // The same list also gates claudePins' date rules — those describe two
    // specific accounts' history, and on a machine holding neither they would
    // label a stranger's own usage with a stranger's email (see
    // resolveBacklogAccount's `discovered` parameter). Until the resolver is
    // registered this is empty, which disables the date rules: the archive
    // still resolves (by identity, unconditionally) and everything else falls
    // through to `unknown account`, which renders honestly.
    const discovered = claudeAccountResolver?.() ?? [];
    const emailByUuid = new Map<string, string>();
    for (const a of discovered) emailByUuid.set(a.accountUuid, a.email);

    const acc = new Map<string, AccountFacetRow>();
    // An account whose usage includes any rollup conversation cannot report a
    // real call count for that portion, so the whole row surrenders the number.
    const rollupAccounts = new Set<string>();

    // The SAME dedup rule aggregateFromPerConvo applies, with the same
    // cross-conversation scope (its `seenGlobally` set), using the same
    // function — see entryFingerprint in ../services/usage/convoId.
    //
    // Load-bearing, not defensive. Claude ingestion deliberately STORES
    // cross-file duplicates — a resumed session replays a request into a
    // second transcript — and leaves the collapse to the aggregator
    // (Ruling 12). Summing every stored entry here instead made this
    // breakdown exceed the provider header directly above it: measured on the
    // live corpus, header 15,695,716,154 tokens / 9,532 calls against facet
    // 15,876,386,492 / 9,920 — a breakdown 180,670,338 tokens and 388 calls
    // larger than its own total, rendered in the same block.
    const seenGlobally = new Set<string>();

    for (const [cid, data] of Object.entries(perConvo)) {
        if (!isClaudeConvo(cid)) continue;
        const isRollup = cid === LEGACY_CLAUDE_ARCHIVE_ID;

        for (const e of data.entries) {
            const fp = entryFingerprint(e);
            if (seenGlobally.has(fp)) continue;
            seenGlobally.add(fp);

            const pinned = resolveBacklogAccount(cid, e.ts, discovered);
            // Load-bearing: resolveBacklogAccount is called even for a row that
            // already carries an accountKey — but its `email` is used below ONLY
            // when pinned.accountUuid === uuid. A pinned email is date-derived, so
            // using it for a stamped row whose uuid it does not match would attach
            // one person's name to another account's usage. Do not "simplify" this
            // by skipping the pins lookup when accountKey is present.
            const uuid = e.accountKey ?? pinned?.accountUuid ?? null;
            const key = uuid ?? 'unknown';
            if (isRollup) rollupAccounts.add(key);

            let row = acc.get(key);
            if (!row) {
                row = {
                    // A pinned email may only label the uuid it actually resolved to.
                    // Falling back to it for a stamped row would attach a date-derived
                    // name to an account that disagrees with it.
                    label: (uuid ? emailByUuid.get(uuid) : undefined)
                        ?? (pinned && pinned.accountUuid === uuid ? pinned.email : undefined)
                        ?? uuid ?? 'unknown account',
                    accountUuid: uuid,
                    tokens: 0,
                    calls: 0,
                    from: e.ts, to: e.ts,
                };
                acc.set(key, row);
            }

            row.tokens += e.inp + e.out + e.cache + e.cacheWrite + e.reasoning;
            if (row.calls !== null) row.calls++;
            if (e.ts && e.ts < row.from) row.from = e.ts;
            if (e.ts && e.ts > row.to) row.to = e.ts;
        }
    }

    for (const key of rollupAccounts) {
        const row = acc.get(key);
        if (row) { row.calls = null; row.note = ROLLUP_NOTE; }
    }

    return [...acc.values()].sort((a, b) => b.tokens - a.tokens);
}

/**
 * One provider block: its own totals, its accounts beneath.
 *
 * There is deliberately no cross-provider total anywhere in this component.
 * On measured data a summed headline is ~97% Claude and describes neither tool.
 */
export function renderProviderSection(
    title: string,
    stats: DeepUsageStats,
    facet: AccountFacetRow[],
    /**
     * The window these totals cover, named in the header. The panel passes
     * 'all time' because this region deliberately ignores the range bar that
     * renders immediately below it — see renderProviderRegion. An unlabelled
     * lifetime total sitting on top of a dashboard filtered to 24h reads as
     * that day's number; the old hero honoured the range, so the difference
     * has to be visible rather than merely documented in the source.
     */
    scopeLabel?: string,
): string {
    if (stats.totalCalls === 0 && stats.totalTokens === 0) return '';

    const day = (ts: string) => (ts ? ts.slice(0, 10) : '—');

    // stats.totalCalls counts raw entries, with no rollup awareness — for a
    // provider with an account facet, that is the same "175" lie the account
    // row below exists to suppress, just one level up (measured on the real
    // ledger: the Claude header would otherwise read "175 calls" for six
    // months of work, once the rollup archive is the only Claude data
    // present). Whenever a facet exists, show account count instead of a
    // call count the header cannot honestly total — the account rows below
    // are where an honest, per-row call count (or its absence) belongs.
    // Antigravity has no facet and no rollup risk, so its header keeps the
    // real call count.
    const headline = facet.length > 0
        ? `<span class="up-provider-calls">${facet.length.toLocaleString()} account${facet.length === 1 ? '' : 's'}</span>`
        : `<span class="up-provider-calls">${stats.totalCalls.toLocaleString()} calls</span>`;

    let html = `<div class="up-provider">`;
    html += `<div class="up-provider-head">`;
    html += `<span class="up-provider-name">${escHtml(title)}</span>`;
    if (scopeLabel) html += `<span class="up-provider-scope">${escHtml(scopeLabel)}</span>`;
    html += `<span class="up-provider-tokens">${fmtBig(stats.totalTokens)}</span>`;
    html += headline;
    html += `</div>`;

    for (const row of facet) {
        // A rollup row has no honest call count. Render an em dash, never a number.
        // escAttr, not escHtml: these two go inside title="…", where a `"`
        // escHtml leaves alone would close the attribute (see escAttr's own
        // doc comment). row.note is a module constant today; the escaping is
        // not conditional on that staying true.
        const calls = row.calls === null
            ? `<span class="up-acct-calls up-muted" title="${escAttr(row.note ?? '')}">—</span>`
            : `<span class="up-acct-calls">${row.calls.toLocaleString()} calls</span>`;
        const warn = row.note
            ? ` <span class="up-warn" title="${escAttr(row.note)}">⚠</span>`
            : '';
        html += `<div class="up-acct">`;
        html += `<span class="up-acct-label">${escHtml(row.label)}</span>`;
        html += `<span class="up-acct-tokens">${fmtBig(row.tokens)}</span>`;
        html += calls;
        html += `<span class="up-acct-range">${day(row.from)} – ${day(row.to)}</span>${warn}`;
        html += `</div>`;
    }

    return html + `</div>`;
}

/** Shown in place of the sections when the split arrived without its ledger. */
const LEDGER_UNAVAILABLE_NOTE =
    'The raw usage ledger was not available on this render, so usage could not be '
    + 'split by provider. The cards below are unaffected.';

/**
 * The panel's entire provider region — both sections, plus the guarantee that
 * it is never empty while there is usage to describe.
 *
 * That guarantee is the point of this wrapper. `claude`/`antigravity` come from
 * aggregateByProvider over a ledger the caller supplies, and a caller that
 * hands over an empty ledger gets two all-zero stats objects, which
 * renderProviderSection correctly renders as ''. Concatenating those two
 * directly (as the panel used to) silently erased the panel's whole headline
 * while `stats` itself still carried billions of tokens — measured at 0 bytes
 * rendered. This renders a named, honest fallback in that case instead.
 *
 * The fallback deliberately carries NO number. `stats` is the combined total
 * across both providers, and a summed cross-provider headline is exactly what
 * this region exists to avoid — on the real ledger it is 96.7% Claude and
 * describes neither tool. So the fallback says the breakdown is missing rather
 * than substituting a total that would mislead.
 */
/**
 * Named once, here, and passed to both sections: this region is always
 * all-time by construction (the panel aggregates it with an empty date
 * filter), while the range bar directly beneath it filters every other card
 * on the dashboard. Selecting "24h" must not leave an unlabelled lifetime
 * total at the top of a one-day dashboard.
 */
const PROVIDER_SCOPE_LABEL = 'all time';

export function renderProviderRegion(
    stats: DeepUsageStats,
    claude: DeepUsageStats,
    antigravity: DeepUsageStats,
    claudeFacet: AccountFacetRow[],
): string {
    const sections = renderProviderSection('Claude Code', claude, claudeFacet, PROVIDER_SCOPE_LABEL)
        + renderProviderSection('Antigravity', antigravity, [], PROVIDER_SCOPE_LABEL);
    if (sections) return sections;

    // Genuinely nothing to show — an empty ledger AND empty stats. Rendering
    // nothing is correct here; the dashboard's own empty states take over.
    if (stats.totalCalls === 0 && stats.totalTokens === 0) return '';

    return `<div class="up-provider up-provider-fallback"><div class="up-provider-head">`
        + `<span class="up-provider-name">Provider breakdown</span>`
        + `<span class="up-provider-calls up-muted" title="${escAttr(LEDGER_UNAVAILABLE_NOTE)}">`
        + `unavailable for this refresh</span>`
        + `</div></div>`;
}
