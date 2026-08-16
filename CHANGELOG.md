# Changelog

All notable changes to **AG Multi-Account Switchboard** are documented here.

## [3.3.1] — 2026-08-16

### Fixed
- **Models show their real names instead of `Placeholder M187`.** Antigravity's protocol ships blank `MODEL_PLACEHOLDER_M<n>` slots so unreleased model names never appear in the client binary, and the extension had static guesses for only six of them — none covering the Gemini 3.5, 3.6, and 3.7 families that the command-line client actually runs on. The server hands out the real label for every model an account may use, in a response the extension already fetches for quota, so those labels are now harvested from it at no extra cost. On the development machine this named 85% of all recorded calls, up from roughly 15%.
- Labels are **remembered once seen**, so a model still renders its name after being withdrawn from the catalogue. Switching accounts learns the most, since another tier exposes models the current one never lists.

### Notes
- A handful of enums stay `Placeholder M<n>` — no account currently offers them and the stored records contain no model name, only the enum, so naming them would mean guessing. They will resolve on their own if the model reappears on any signed-in account.
- Learned labels never override a model that already has a known rate, so date-aware pricing is unaffected.

## [3.3.0] — 2026-08-15

Usage is now read from Antigravity's conversation store instead of from the language server.

### Why this release exists

The language server can only answer for conversations that existed **when its process started**. Anything the `agy` command-line client created afterwards was invisible to it — permanently, for the life of that process. A conversation created 35 seconds after the server booted was already unreachable. For anyone working command-line-first, entire days reported zero while the data sat intact on disk.

A second defect made the loss permanent: a fetch that returned nothing still recorded a freshness marker, so once a session stopped writing, its conversation was frozen at zero forever.

### Your numbers will change, for five separate reasons

Historical figures are **restated**, not just changed going forward. All five apply at once, which is why totals move in more than one direction:

1. **Recovered sessions.** Days that reported zero now report their real usage. On the development machine: two days went from 0 to 184 and 64 calls, and four more became visible for the first time.
2. **Sub-agent runs are counted.** When a session spawns helper agents, each has its own record. The language server refused to serve them, so they had never been counted once — about 3% of all calls.
3. **Days are bucketed by local date.** They were bucketed by UTC while weekday charts and the activity grid used local dates, so the two disagreed. Late-evening sessions landed on the previous day.
4. **Duplicates are removed globally.** Deduplication was per-conversation, so a call recorded by two conversations counted twice.
5. **Live pricing actually applies.** The dynamic pricing catalogue was queried with a humanised display name while it is keyed by model id, so no lookup had ever matched and every cost figure came from a keyword guesser. One model was under-priced 3.3×.

### Added
- **Data health card** in the full dashboard — where numbers came from, how many conversations were read, how many were unreadable, which models had no known rate and were excluded from cost, and whether a cross-check ran.
- **Cross-check against the language server.** For any conversation it can still serve, the store decode is compared field by field. The reasoning-token field, previously matched against a single sample, is now confirmed across 125 real calls with no divergence.
- **Honest empty states.** A range with no activity says so and names the last session, instead of rendering zeros indistinguishable from a malfunction — which is how the original bug hid for days.
- **`ag-switchboard.usageSource`** — set to `server` to restore the previous behaviour. Temporary, and intended for removal.

### Fixed
- **All three Antigravity install locations are scanned.** Only one was, so on any machine where the command-line client and the IDE keep separate directories, every command-line conversation was invisible.
- **The activity grid keyed its cells in UTC** while walking local dates, so in any positive-offset timezone every cell sat one day off its true weekday — a Monday's usage rendered in the Tuesday column. The tooltip printed the key rather than the slot, which is why it looked correct.
- **Unrecognised models are excluded from cost** rather than silently billed at Sonnet rates.
- **The native database module now loads on macOS.** The search path listed one application directory that does not contain it, so every read spawned a command-line process instead — roughly 9 ms against under 1 ms.
- **Reads no longer mark conversations as changed.** Freshness counted a sidecar file that readers create, so the first read of any conversation made it look modified forever after and refresh degenerated into a full rescan.
- **Monthly cost, the model breakdown and the cost card no longer disagree** about the same month.

### Notes
- Existing usage history is preserved. Conversations with no file on disk — including any synthetic import — are never reconciled away.
- Cache-write tokens are not decoded; that field's identifier was never determined, so it reports zero. The cross-check will flag it if a future build starts emitting them.

## [3.2.5] — 2026-08-06

### Fixed
- **Day strip scrolled the sidebar sideways** — `.gh-strip-wrap` lacked the overflow containment `.gh-grid-wrap` has, so an over-wide child (the legend + peak footer, which needs ~225px) escaped the card and scrolled the whole tab. The wrapper now contains its own overflow, and the footer wraps to a second line instead of being pushed off the edge.

## [3.2.4] — 2026-08-06

### Changed
- **Activity grid follows the selected range** — `7d` and `30d` drew a full calendar year of squares, so ~52 of the 53 week-columns were guaranteed empty and the visible data was a single lit column. Short ranges now render a day strip spanning exactly the period: 7 squares for `7d`, 30 for `30d`, month-to-date for `Month`. Colour intensity scales to the window's own peak, so a quiet week shows contrast instead of washing out against an all-time maximum. `All Time` keeps the year grid and its year selector — the only range where a calendar year is worth drawing.
- **`24h` and `Today` show the hourly heatmap** in the full dashboard, matching the sidebar. A day grid for a sub-day range was one square.
- **`7d` / `30d` are now whole calendar days** — they were rolling instants (`now − 7×24h`), which straddled 8 calendar days and made the grid off-by-one against its own label. They now cover the last 7 / 30 calendar days including today, so the squares drawn and the totals counted describe the same window. Totals for these two ranges shift slightly as a result.

### Fixed
- **30d windows spanning a year boundary lost half their data** — the grid dropped any day whose date did not start with the selected year. Period-scoped windows have no year to filter by.

## [3.2.3] — 2026-08-03

### Fixed
- **Usage Stats missed agy CLI sessions** — Conversations created by the `agy` CLI stopped being counted. The language server only *lists* trajectories it has loaded, so `GetAllCascadeTrajectories` never reports CLI sessions and their `stepCount` stays `0` — the stepCount-delta gate therefore never marked them dirty. Each CLI conversation got exactly one fetch, at creation, while its store was still empty, then sat at zero entries forever. Re-fetch now also triggers on disk mtime (`brain/<id>`, `conversations/<id>.db`), which sees every session regardless of who wrote it. Conversations already stuck at zero entries are retried automatically on the next refresh; ones that already have data are not re-read.
- **Usage Stats delta offsets skipped recoverable rows** — A conversation with zero cached entries is now re-read from offset `0` instead of resuming past metadata/step rows that were fetched but never kept.

## [3.2.1] — 2026-05-04

> First 3.2.x marketplace release. Includes the 3.2.0 Conversation Guard release plus the Usage Stats accuracy fixes below.

### Fixed
- **Usage Stats duplicate counting** — Deduplicates model responses by stable `responseId` when Antigravity exposes the same usage telemetry through both generator metadata and trajectory steps.
- **Usage Stats total token semantics** — Total Tokens now consistently includes input, cache read, cache write, output, and reasoning tokens across sidebar KPIs, full dashboard cards, model totals, and conversation totals.
- **Usage Stats cache rebuild** — Bumped the disk cache schema to v2 so old fingerprint-based caches are discarded and rebuilt with response-aware entries.
- **Usage Stats refresh lifecycle** — The full Usage Statistics editor panel now receives refresh pushes from quota refreshes instead of staying stale until reopened.
- **Usage Stats monthly filters** — Monthly summaries use bounded date filtering and pure aggregation so switching ranges does not mutate cached totals.
- **Footer build number placement** — Build tags render in the footer build badge instead of drifting into the updated timestamp.
- **Quota 100% display bug** — Restored `projectId` parameter in `retrieveUserQuota` API call. Without it, Google returned generic empty buckets showing 100% for all models. (via [#3](https://github.com/erennyuksell/ag-multi-account-switchboard/pull/3) by [@ameenalasady](https://github.com/ameenalasady))

### Changed
- **Usage Stats entry preference** — When the same response appears in multiple local sources, generator metadata is preferred over step snapshots because it carries the canonical token accounting.
- **Model whitelist removed** — All models returned by the API are now displayed, not just hardcoded ones. Unknown model IDs are auto-humanized (`gemini-3.1-pro-high` → `Gemini 3.1 Pro (High)`). The old `MODEL_WHITELIST` is now `MODEL_DISPLAY_NAMES` — a cosmetic override map, not a filter.

## [3.2.0] — 2026-05-01

### Added
- **Conversation Guard** — Detects conversations that exist on disk (`.pb` files) but are missing from the sidebar index. Shows an expandable warning banner with conversation titles and dates, with a one-click fix that rebuilds the index.
- **Detached fix worker** — Index rebuild runs as a standalone Node.js process after AG quits, then auto-relaunches the IDE with the same workspace. Handles WAL checkpoint, backup, and cross-platform app discovery (macOS, Linux, Windows).
- **Protobuf codec** — Pure TypeScript varint encoder/decoder, field stripper, and entry builder. Shared between extension host and detached worker with zero external dependencies.
- **Title resolver** — Multi-source title extraction (LS trajectory → brain markdown → transcript log → date-based fallback). Filters generic auto-titles like "New Conversation".
- **Cross-platform path SSOT** — `agPaths.ts` centralizes all platform-specific filesystem paths (state DB, conversations dir, cert paths, LS binary name) for macOS/Linux/Windows.
- **`ag.fixConversations` command** — Command palette entry + footer wrench button for manual fix trigger.

### Changed
- **Constants refactor** — Platform paths and process detection patterns moved from `constants.ts` to `shared/agPaths.ts` (vscode-free, worker-safe).

## [3.1.1] — 2026-04-28

### Fixed
- **Cross-window state contamination** — Multiple IDE windows no longer overwrite each other's active conversation. Each window uses `workspaceState` for per-workspace cascade persistence.
- **Focus-gain listener bug** — Removed listener that could pick up stale cascade IDs from other windows' USS entries on alt-tab.
- **Disposable leak** — `topic.onDidChange()` subscriptions are now properly registered for disposal.
- **Boot poll snapshot inconsistency** — Boot polling now uses `readCascadeDiff()` to keep the internal snapshot in sync with runtime.
- **trajectorySummaries fallback persistence** — Fallback cascade assignment now writes to `workspaceState`.
- **Log severity** — Error conditions upgraded from `log.info()` to `log.warn()`.

### Changed
- **Quota API endpoint** — Migrated to `retrieveUserQuota` gRPC-transcoded endpoint with strict model whitelist.
- **USS event gating** — `onDidChange` events are only processed when `vscode.window.state.focused` is true.

## [3.1.0] — 2026-04-24

### Added
- **Cross-source pin matching** — Pinned models persist correctly across local/tracked accounts via host-side label map.
- **Host-managed quota polling** — Quota refresh via `setInterval`, ensuring data stays fresh regardless of sidebar visibility.
- **Cost per token in daily grid** — Heatmap cells show estimated cost alongside token counts.
- **Diagnostic logging harness** — DIAG-level logging with file sink for field debugging.
- **Build tag tracking** — Footer shows incremental build identifiers.

### Changed
- **Account card builder refactor** — Pure-function card builder module with zero side effects.
- **Anti-magic constants** — All UI thresholds, timeouts, and API URLs extracted to named constants.

## [3.0.0] — 2026-04-14

### Added
- **Context Window Detail** — Full editor panel with raw token breakdown.
- **Active Context sidebar** — Donut chart with category-colored stacked bar.
- **Export Markdown** — One-click conversation export.
- **LiveStream Watcher** — Real-time context window updates during model execution.
- **RPC Direct Client** — JSON-over-HTTP calls to local LS.
- **Reasoning tokens** — Tracks reasoning tokens alongside input/cache/output.
- **Monthly cost breakdown**, **Weekly pattern**, **Top conversations**.
- **Dual-LS Architecture** — Automatic discovery of Workspace LS + Global LS.
- **Server Discovery rewrite** — PID-based process scanning with `lsof` port resolution.
- **Account Switch Hardening** — LS Readiness Gate, Gate-Once-Pass-Down endpoint reuse.
- **Proactive Token Renewal** — Automatic access_token refresh before expiry.

## [2.3.0] — 2026-03-20

### Added
- **Usage Stats Dashboard** with sidebar compact view + full editor tab.
- 9 KPI cards, estimated cost per model, smart model merging.
- PostMessage architecture for detail panel DOM patching.

## [2.2.0] — 2026-03-10

### Added
- **Deep usage stats** — All-time token usage analytics with disk caching.
- **Bento grid layout**, **GitHub contribution grid**, **Progressive loading**.

## [2.1.0] — 2026-02-28

### Added
- **Branded init screen** with radar pulse animation.
- **Sticky layout** — Header and footer pinned.
- **Modular webview architecture** with esbuild bundling.

### Fixed
- Race condition in pending refresh queue.
