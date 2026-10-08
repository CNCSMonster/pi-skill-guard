# pi-skill-guard User Guide

English | [简体中文](./user-guide.zh-CN.md)

> **pi-skill-guard** is the comprehensive user manual for project-level skill isolation and session-level temporal lifecycle governance in [Pi Coding Agent](https://github.com/earendil-works/pi).
> For a high-level summary and brief configuration options, see [README](../README.md).

---

## 1. Quick Start

### 1.1 Why pi-skill-guard?

By default, Pi Coding Agent injects all installed global skills into the system prompt's `<available_skills>` block on every turn. In large projects, this causes critical challenges:
1. **Token Waste & Context Bloat**: Even if a project only needs 2 skills, all global skills are injected, wasting thousands of tokens per turn;
2. **Attention Drift & Hallucination**: Irrelevant skills mislead the LLM (e.g., calling web scrapers while doing backend database work);
3. **Mid-Session Context Fractures**: Toggling skills mid-session by crudely deleting system prompt lines wipes out the entire KV prefill cache for hundreds of prior turns and causes reasoning contradictions.

`pi-skill-guard` solves this with **zero external dependencies, sub-millisecond execution, and defense-in-depth isolation**.

### 1.2 Installation

The extension adheres strictly to native Pi extension protocols:

```bash
pi install git:github.com/CNCSMonster/pi-skill-guard
```

Active out of the box with zero compilation or setup steps.

### 1.3 Baseline Configuration (`.pi/settings.json`)

Configure `skillGuard` within your workspace's trusted `.pi/settings.json`:

```json
{
  "skillGuard": {
    "enabled": true,
    "mode": "allowlist",
    "allow": [
      "ccm-*",
      "tavily-*",
      "cloudflare"
    ],
    "block": [
      "*-dangerous",
      "boss-recruitment"
    ],
    "blockReadTool": true,
    "notifyOnStartup": true
  }
}
```

Full Configuration Reference:
| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable or disable skill guard defense |
| `mode` | `"allowlist"` \| `"blocklist"` | `"allowlist"` | Active mode: allowlist or blocklist |
| `allow` | string[] | `[]` | Allowed skill patterns (supports `*` and `?`) |
| `block` | string[] | `[]` | **Top Priority**: Denied skill patterns (Deny-First rule) |
| `blockReadTool` | boolean | `true` | Intercept `read` calls to unauthorized skill directories |
| `blockSkillCommand` | boolean | `true` | Intercept `/skill:<name>` invocations for unauthorized skills |
| `notifyOnFilter` | boolean | `false` | Display filtering summary notifications in UI |
| `notifyOnStartup` | boolean | `true` | Display defense readiness notification on session startup |

---

## 2. Isolation Modes & Core Invariants

### 2.1 Isolation Modes

| Mode | Config Value | Behavior | Recommended Use Case |
|---|---|---|---|
| **Allowlist Mode** | `"allowlist"` (default) | Only skills matching `allow` patterns are exposed. Non-whitelisted skills are invisible in both prompt and tool gateways. | Production, domain-specific coding (strictly bound model capabilities) |
| **Blocklist Mode** | `"blocklist"` | All skills are permitted by default; only skills matching `block` patterns are blocked. | General exploration, temporarily muting risky skills |

### 2.2 Deny-First Invariant (Highest Priority)

**Regardless of active mode, matching a `block` rule strictly and unconditionally denies access!**
- Even in `allowlist` mode if a skill is listed in both `allow` and `block`, `block` always wins;
- Attempting to allow an actively blocked skill in the interactive TUI triggers an immediate pre-flight conflict error.

### 2.3 Wildcard Matching Rules

Standard glob patterns are fully supported:
- `*`: Matches zero or more characters (e.g. `ccm-*` matches all skills starting with `ccm-`);
- `?`: Matches a single character (e.g. `tool-?` matches `tool-1`, `tool-a`);
- Pattern matching is strictly **case-insensitive** with whitespace automatically trimmed.

---

## 3. Interactive Session Governance (`/skill-guard`)

Users often need runtime flexibility (e.g. "temporarily unblock an architecture sketching skill for this turn", "inspect blocked skills").

### 3.1 Interactive TUI Menu

Run directly in the interactive prompt:

```text
/skill-guard
```

Displays an intuitive self-explanatory menu:
- 🛡️ **Enable / 🔘 Disable Guard**: Toggle overall enforcement;
- 🔄 **Switch Mode**: Toggle between allowlist and blocklist;
- ➕ **Temporary Allow (`allow`)**: Add wildcard patterns in memory;
- 🚫 **Temporary Block (`block`)**: Add blocked patterns in memory;
- ➖ **Revoke Allow (`unallow`)** / 🔓 **Release Block (`unblock`)**: Revoke runtime overrides;
- ♻️ **Reset Overrides (`reset`)**: Clear all runtime overrides and restore workspace settings baseline;
- 📋 **Diagnostic Status (`status`)**: View full status report and affected skills.

### 3.2 Command Line Shortcuts

```bash
/skill-guard status                 # Print active configuration and blocked skill list
/skill-guard allow ccm-boss-*       # Temporarily allow pattern
/skill-guard block boss-recruitment # Temporarily block skill
/skill-guard unallow ccm-boss-*     # Revoke runtime allow rule
/skill-guard unblock boss-recruitment# Release runtime block rule
/skill-guard mode blocklist         # Switch to blocklist mode
/skill-guard reset                  # Restore to disk configuration
```

### 3.3 Security Gates & Lifecycle Isolation

1. **Zero Disk Contamination**: Session operations are strictly in-memory and never touch `.pi/settings.json`. Cleaned up upon session end;
2. **Fail-Closed Relaxation Gate**: Any operation expanding access (disabling guard, switching to blocklist, unblocking rules, expanding allowlist):
   - In TUI mode: triggers a mandatory confirmation modal detailing permission changes;
   - In non-UI mode (CI/CD, Headless): **fails closed immediately**, preventing silent privilege escalation.

### 3.4 Session Observability & Status Bar Indicator

To eliminate confusion caused by Pi's startup `Loaded Resources` panel showing all filesystem skills, the extension provides clear observability:
1. **Startup Readiness Notification**: On `session_start`, if the guard is active and not muted (`notifyOnStartup: true`), an info notification `🛡️ Skill Guard active [${mode}]` is displayed, confirming directory-level defenses are active.
2. **Persistent Status Bar Indicator**: Sets a compact status badge `🛡️ guard:${mode}` (e.g. `🛡️ guard:allowlist`) in the terminal footer. The badge is cleared when disabled.
3. **Dynamic Synchronization**: When toggling modes, enabling, or disabling the guard via `/skill-guard` commands or menu, the status bar indicator updates in real-time.

---

## 4. Temporal Consistency & KV Cache Preservation

In long agent sessions, toggling skills mid-conversation typically breaks reasoning continuity. `pi-skill-guard` solves this with an append-only architecture:

### 4.1 The Core Dilemma

1. **Reasoning Temporal Inconsistency**:
   If the model invoked Skill $X$ in Turn 1, its thinking trace (`thinking` block) contains detailed steps and scripts for Skill $X$. Deleting Skill $X$ from the initial system prompt in Turn 2 causes a self-contradiction (*"Turn 0 says Skill X doesn't exist, but my Turn 1 thinking successfully ran it"*), inducing severe hallucinations.
2. **KV Cache Invalidation (TTFT Spike)**:
   Prompt caching depends on the Longest Common Prefix. Editing the leading system prompt invalidates the cache for all tens of thousands of tokens of conversation history, spiking latency by 3~5 seconds and incurring full prefill charges.

### 4.2 The Solution: Prefix Immutability + Tail Constraints

```
[Turn 0 System Prompt (Permanently Frozen)] ──▶ [Multi-turn Transcript (Hits KV Cache)] ──▶ [Last User Input + <active_skill_constraints>]
```

1. **Prefix Immutability (INV-1)**:
   Once the first user turn begins, the initial system prompt is frozen. Mid-session changes never mutate Turn 0, preserving 99%+ of the prefill KV Cache;
2. **In-Memory Tail Projection (INV-2 ~ INV-4)**:
   Disabling or mounting skills projects dynamic constraints via `pi.on("context")` at the tail of the **last `user` message**:
   - Zero persistence contamination: `.jsonl` session files remain untouched;
   - Zero TUI pollution: user inputs display cleanly in the terminal;
   - Strict role alternation: no consecutive user messages, eliminating API 400 errors;
   - Deterministic sorting: skills are rendered in ASCII alphabetical order, preventing cache jitter.
3. **Dual-Channel Defense-in-Depth (INV-5)**:
   - Tool gateways intercept both `read` calls (file access) and `bash` commands (script execution, including hex/escape obfuscation);
   - Constructive fallback guidance guides the model to adapt gracefully:
     `[Skill Guard Blocked]: Access to skill "<skill>" is restricted in the current session. Operational guidance: Please adhere to <active_skill_constraints> and proceed using native tools (read/bash/edit) or alternative approved approaches without invoking this skill.`

---

## 5. Troubleshooting & FAQ

### Q1: Why didn't my changes to `.pi/settings.json` take effect immediately?
- **Cause**: An active runtime override takes precedence over disk settings.
- **Fix**: Run `/skill-guard reset` to clear overrides and synchronize with disk.

### Q2: Why did `/skill-guard allow my-tool` get rejected?
- **Cause**: `my-tool` matches an active baseline or session `block` rule.
- **Rule**: Deny-First invariant prevents `allow` from overriding `block`. Run `/skill-guard unblock` first or update settings.

### Q3: Why are rules in `.pi/skill-guard.json` ignored?
- **Cause**: Standalone configuration files bypass Pi's workspace trust boundary and are deprecated.
- **Fix**: Migrate settings to the `skillGuard` field inside trusted `.pi/settings.json`.

### Q4: Does pi-skill-guard introduce external npm dependencies?
- **Answer**: `pi-skill-guard` adheres to a strict **0 external dependencies** standard. All functionality runs natively on Node.js with sub-millisecond execution overhead.
