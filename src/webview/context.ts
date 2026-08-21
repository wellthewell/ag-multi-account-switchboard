/**
 * Shared webview context — breaks circular dependencies between modules.
 * All modules import from here; this file imports from nobody.
 */

// ─── API ───
export const vscode = acquireVsCodeApi();
export const wlog = (m: string) => vscode.postMessage({ type: 'weblog', msg: m });

// ─── Shared State ───
export let pinnedModels: Record<string, string> = {};
export let lastRenderArgs: unknown[] = [];
export const setPinnedModels = (m: Record<string, string>) => { pinnedModels = m; };
export const setLastRenderArgs = (a: unknown[]) => { lastRenderArgs = a; };

// ─── Refresh Rate ───
//
// There is no timer here on purpose. Polling is the extension host's job: its
// timer keeps running when the sidebar is collapsed, and a webview timer does
// not — so a rate chosen here used to stop applying the moment the panel closed,
// while the host carried on at its own hardcoded 60s regardless. The picker now
// asks the host to change its rate and reflects whatever the host confirms.
