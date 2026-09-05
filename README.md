# 🎛️ AG Multi-Account Switchboard

<p align="center">
  <b>The Mission Control Panel for Antigravity IDE & the <code>agy</code> CLI</b><br/>
  <i>Switch Google AI accounts instantly, monitor real-time model quotas, dissect active context tokens, and unlock deep offline conversation analytics.</i>
</p>

<p align="center">
  <a href="https://github.com/wellthewell/ag-multi-account-switchboard/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/wellthewell/ag-multi-account-switchboard?color=00c853&label=Release&logo=github"/></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?logo=apple"/>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-purple.svg"/></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white"/>
  <img alt="Antigravity" src="https://img.shields.io/badge/Antigravity-IDE%20%26%20CLI-FF6D00"/>
</p>

---

<table align="center">
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/wellthewell/ag-multi-account-switchboard/main/assets/preview.png" alt="Accounts Panel" width="380"/><br/><sub><b>Live Quotas & Accounts</b></sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/wellthewell/ag-multi-account-switchboard/main/assets/token-budget.png" alt="Token Budget" width="180"/><br/><sub><b>Active Context Window</b></sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/wellthewell/ag-multi-account-switchboard/main/assets/usage-sidebar.png" alt="Usage Stats" width="180"/><br/><sub><b>Usage Stats Heatmap</b></sub></td>
  </tr>
  <tr>
    <td align="center" colspan="1"><img src="https://raw.githubusercontent.com/wellthewell/ag-multi-account-switchboard/main/assets/context-detail.png" alt="Context Detail" width="380"/><br/><sub><b>Deep Context X-Ray Inspection</b></sub></td>
    <td align="center" colspan="2"><img src="https://raw.githubusercontent.com/wellthewell/ag-multi-account-switchboard/main/assets/usage-panel-1.png" alt="Analytics Dashboard" width="380"/><br/><sub><b>Full Historical Usage & Cost Analytics</b></sub></td>
  </tr>
</table>

---

## ⚡ Why AG Switchboard?

Antigravity gives you cutting-edge AI orchestration, but managing multiple quotas, unmasking cryptic models, and tracking token burn across both IDE and CLI sessions can feel like flying blind.

**AG Switchboard** solves this with a unified, high-performance cockpit:
- 🔄 **Frictionless Multi-Account Switching** — Switch active accounts in 1 click without messing with web logins or credential files.
- ⏱️ **Live Quota HUD & Reset Timers** — Track rate limits across every model tier with host-managed precision intervals (30s, 1m, 2m, 5m).
- 🧠 **Context Window Intelligence** — See exactly what consumes your active token window (System Prompt, MCP Tools, Skills, Rules, User Input).
- 📊 **Offline SQLite Conversation Store Analytics (v3.3+)** — Directly decodes Antigravity's local conversation store (`conversations/*.db`). Covers both the IDE and the `agy` command-line client, sub-agent runs, true model names, and live LiteLLM pricing.
- 🛡️ **Conversation Guard** — Detects SQLite index desyncs and protects against losing chat history during crashes.

---

## ✨ Features

### 1. 📊 Accounts — Live Quota Command Center

Monitor all your AI model quotas at a glance with zero lag:

* **Unlimited Google Accounts:** Track multiple Google accounts simultaneously with color-coded status badges and reset countdowns.
* **Instant 1-Click Switching:** Switch your active IDE account directly from the sidebar.
* **Model Pinning:** Star (★) your primary model to keep it permanently visible in the collapsed header.
* **Status Bar Integration:** Toggle (●) individual model quotas directly into the VS Code status bar.
* **Proactive Token Renewal:** Automatically refreshes OAuth tokens before expiration, preventing disruptive 401s mid-session.
* **Reliable Polling (v3.3.4):** Polling timers run in the extension host, ensuring rate choices (`30s`, `1m`, `2m`, `5m`) persist across restarts and stay active even when the sidebar panel is collapsed.

---

### 2. 🔑 Token Budget & Context Window X-Ray

Stop wondering why you hit context boundaries. Inspect token consumption in real time:

* **Category Donut & Stacked Bars:** Real-time breakdown of System Prompts, Tools, MCP Tools, User Inputs, Model Responses, and File Reads.
* **🔥 Heavy Consumer Flags:** Highlights tools, rules, and conversation turns consuming disproportionate amounts of context.
* **Workspace Extensions (.agent/):** Live view of loaded skills, workflows, and custom rules with estimated token footprints.
* **Full Context Editor Panel ("See All →"):** Dedicated multi-column editor tab with collapsible syntax tree, step-by-step previews, and 1-click Markdown export.

---

### 3. 📈 Deep Usage Analytics Engine *(v3.3 Architecture)*

Unlike standard stats that rely on the language server's transient memory, AG Switchboard v3.3+ reads directly from Antigravity's local SQLite database store:

* **Complete `agy` CLI & IDE Coverage:** Captures every session on disk, including background `agy` runs and autonomous sub-agent helper trajectories previously hidden from telemetry.
* **Real Model Names (v3.3.1):** Dynamically resolves cryptic `MODEL_PLACEHOLDER_M<n>` protobuf enums into true vendor names (e.g. Gemini 3.5, 3.6, 3.7 Pro/Flash) by harvesting live quota descriptors.
* **Accurate Date-Sensitive Pricing:** Integrates live LiteLLM pricing keyed by API model IDs rather than loose display labels, eliminating guessing fallbacks.
* **Native SQLite Performance:** Native `@vscode/sqlite3` loading drops disk decode overhead from ~9ms to <1ms.
* **Period-Scoped Heatmaps:** View your activity via GitHub-style contribution heatmaps or hourly distributions, perfectly bucketed to your local calendar timezone.
* **Data Health Monitor:** Transparent dashboard card reporting conversations scanned, unreadable items, unpriced models, and verified language server cross-checks.

---

### 4. 🛡️ Conversation Guard

Antigravity stores sessions as SQLite `.db` databases. If an unexpected crash or multi-window conflict desyncs the sidebar index, Conversation Guard detects the orphaned files:

* **Auto-Discovery:** Compares disk storage against the sidebar index automatically.
* **Safe Rebuilds:** Indexes orphaned sessions with full title resolution while creating safety backups (`trajectorySummaries_backup.txt`).
* **Shared-Store Aware (v3.3.2):** Intelligently recognizes symlinked shared stores between CLI and IDE environments without throwing false alarms.

---

## 🚀 Installation

### Option A: Install from Release VSIX (Recommended)

1. Download the latest **`ag-multi-account-switchboard-3.3.4.vsix`** from [GitHub Releases](https://github.com/wellthewell/ag-multi-account-switchboard/releases/latest).
2. Install via terminal:
   ```bash
   code --install-extension ag-multi-account-switchboard-3.3.4.vsix
   ```
   *Or in Antigravity IDE:* Open the Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`) → click `...` in the top right → **Install from VSIX...**.

### Option B: Build from Source

```bash
git clone https://github.com/wellthewell/ag-multi-account-switchboard.git
cd ag-multi-account-switchboard
npm install
npm run compile
npm run package
```

---

## 📋 Panel Controls & Shortcuts

| Action / Button | Description |
| :--- | :--- |
| **`+`** | Add Google account via OAuth |
| **`🔑`** | Add account by pasting a refresh token |
| **★ / ☆** | Pin / Unpin model in the collapsed header |
| **●** | Toggle model quota display in the IDE status bar |
| **30s / 1m / 2m / 5m** | Configure persistent host quota refresh intervals |
| **Open Full Dashboard →** | Open the full-width usage analytics and cost reporting tab |
| **See All →** | Open the deep Context Window X-Ray inspection panel |

---

## 🔒 Privacy & Local Execution

* **Zero Cloud Telemetry:** No tracking, no external analytic beacons, and no proprietary servers.
* **Local Keychain:** OAuth credentials are stored exclusively in VS Code's encrypted `SecretStorage` (macOS Keychain, Linux libsecret, Windows Credential Vault).
* **Direct Local I/O:** All conversation analysis and context budgeting happens on your local machine.

---

## 📜 Lineage & Attribution

This project is actively maintained and evolved by **[Well](https://github.com/wellthewell)**.

It originated as a fork of the excellent [`ag-multi-account-switchboard`](https://github.com/erennyuksell/ag-multi-account-switchboard) created by **[Eren Yüksel](https://github.com/erennyuksell)**. 

Major evolutions in this edition include:
- Complete migration from language server querying to direct Antigravity SQLite store decoding (`conversations/*.db`).
- Comprehensive telemetry tracking for `agy` CLI sessions and sub-agent helper tasks.
- Dynamic model label learning from live server quota responses.
- Persistent extension-host timer architecture.
- Full local timezone alignment and global deduplication.

---

## 📄 License

Distributed under the [MIT License](LICENSE).  
Copyright © 2026 Well ([@wellthewell](https://github.com/wellthewell)) & original contributors.
