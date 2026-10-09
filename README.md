# pi-skill-guard

**English** | [简体中文](./README.zh-CN.md) | [User Guide](./docs/user-guide.md) | [Architecture Spec](./docs/architecture-spec.md)

Project-level declarative Skill boundary defense and prompt pruning extension for [Pi Coding Agent](https://pi.dev).

---

## 🎯 Why pi-skill-guard?

Developers often accumulate a large collection of global Agent Skills (e.g., stock scrapers, job recruiters, cloud devops, etc.). However, in domain-specific repositories (such as documentation knowledge bases or core backend microservices), unconstrained global skills create severe issues:

1. **Token Waste & Context Pollution**: Pi injects all loaded global skills into the system prompt's `<available_skills>` section on every turn, consuming thousands of tokens unnecessarily.
2. **Model Intent Drift & Hallucinations**: Semantic similarities often lead models to invoke irrelevant or dangerous global tools.
3. **Core Configuration Boundaries**: Pi's project-level `settings.json` cannot natively filter global skills located in `~/.pi/agent/skills` or `~/.agents/skills`.

`pi-skill-guard` solves these pain points through **dual-layer physical isolation**.

---

## 🛡️ Dual-Layer Architecture

### 🌟 Core Philosophy: Embracing Modern Agent Golden Rules

Unlike traditional guardrails that attempt to micromanage models mid-flight with repetitive negative constraints (*"Do NOT use X, NEVER think of Y"*), `pi-skill-guard` strictly aligns with Transformer attention mechanisms and append-only context causality:

1. **Quiet Startup Pruning (Positive Filtering)**:
   - In-place pruning of skill declarations in `before_agent_start`. Unauthorized skills physically disappear, ensuring **0 token waste** and root-cause hallucination defense;
   - **Eliminating the Pink Elephant Problem**: If the model never sees a skill, it will never think of it, keeping reasoning traces (Thinking) completely unpolluted.
2. **Positive Capability Mounting (Append-Only Editor Insertion)**:
   - Avoid manual prompt writing: conveniently select from unmounted global skills via TUI;
   - Selecting a skill automatically **inserts positive capability prompts into the current input Editor** for explicit user review and sending, strictly preserving historical KV Cache.
3. **Capability Reduction via Handoff (Context Hygiene & Clean New Session)**:
   - Strongly discourages destructive mid-session skill revocation (which fractures memory and reasoning consistency);
   - Standard handoff paradigm: summarize task state (`/summary` or `handoff.md`) ➔ update configuration ➔ **continue in a clean new session**. Old history remains immutable while the new session operates with 100% clean context.
4. **Deterministic Tool Gateway Defense**:
   - Deterministically blocks unauthorized physical `read` and `bash` execution paths with constructive guidance.

```
User Prompt
     │
     ▼
[ Layer 1: Physical Prompt Pruning (before_agent_start) ]
  In-place mutation of event.systemPromptOptions.skills
  Filters unauthorized skills ──▶ Only authorized skills enter <available_skills>
     │                             (Zero token waste, source-level hallucination defense)
     ▼
Model Tool Execution (tool_call)
     │
     ▼
[ Layer 2: Runtime Sandbox Defense (tool_call) ]
  Dual-path verification (logical & realpath) for `read` tool accesses
  Violations ──▶ Physically blocked (`block: true`) with security warning
```

---

## 📦 Installation

### Method A: One-Command Git Install (Recommended)

Run in any terminal:

```bash
pi install git:github.com/CNCSMonster/pi-skill-guard
```

### Method B: Local Project Reference

Clone this repository and reference it in `.pi/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-skill-guard"
  ]
}
```

---

## ⚙️ Configuration

Add the `skillGuard` configuration block to `.pi/settings.json` (or global `~/.pi/agent/settings.json`):

### 1. Allowlist Mode (Recommended, Principle of Least Privilege)

```json
{
  "skillGuard": {
    "enabled": true,
    "mode": "allowlist",
    "allow": [
      "ponytail",
      "ccm-*",
      "tavily-*",
      "cloudflare",
      "workers-best-practices"
    ],
    "block": [
      "*-dangerous"
    ],
    "blockReadTool": true,
    "blockSkillCommand": true
  }
}
```

### 2. Blocklist Mode

```json
{
  "skillGuard": {
    "enabled": true,
    "mode": "blocklist",
    "block": [
      "*-dangerous",
      "crypto-*",
      "boss-recruitment"
    ]
  }
}
```

### Configuration Options

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

## ⚠️ Security Invariants & Breaking Changes

1. **Deny-First Priority (Breaking Change)**: Block rules unconditionally override allowlist rules in all modes.
2. **Standalone File Deprecation (Breaking Change)**: In accordance with Pi Trust security invariants, reading unverified `.pi/skill-guard.json` is deprecated. All settings must reside in trusted `.pi/settings.json`.
3. **Strict Fail-Closed**: Malformed rules or invalid configurations automatically trigger fail-closed sentinels rather than falling open.
4. **Pure In-Memory Session Overrides**: Runtime adjustments never touch the disk and are isolated to the active session lifecycle.
5. **Prefix Immutability & Tail Constraints (KV Cache Preservation)**: Disabling or mounting skills mid-session never mutates the initial System Prompt. This eliminates context-fracturing contradictions with previous reasoning (`thinking` blocks) and preserves 99%+ of the prefill KV Cache. Active constraints are dynamically projected into the tail of the context via `<active_skill_constraints>` alongside dual-channel (`read` + `bash`) tool gates.

---

## 💡 Commands & Interactive Management

### 1. Interactive TUI Menu

Type directly in interactive mode:

```text
/skill-guard
```

Presents a dynamic self-explanatory management menu:
- 🛡️ Enable / 🔘 Disable guard
- 🔄 Switch between allowlist and blocklist
- ➕ Add temporary allow rule (`allow`)
- 🚫 Add temporary block rule (`block`)
- ➖ Revoke temporary allow rule (`unallow`)
- 🔓 Release temporary block rule (`unblock`)
- ♻️ Reset all session overrides (`reset`)
- 📋 Show full configuration and active status report

### 2. Command Line Shortcuts

```bash
/skill-guard status                # Display status report
/skill-guard enable                # Enable guard
/skill-guard disable               # Disable guard (requires confirmation)
/skill-guard mode allowlist        # Switch to allowlist mode
/skill-guard mode blocklist        # Switch to blocklist mode (requires confirmation)
/skill-guard allow <pattern>       # Temporarily allow skill/pattern
/skill-guard block <pattern>       # Temporarily block skill/pattern
/skill-guard unallow <pattern>     # Revoke session allow rule
/skill-guard unblock <pattern>     # Release session block rule (requires confirmation)
/skill-guard reset                 # Clear all session overrides
```

> **Permission Relaxation Gate**: Any operation expanding accessible skills requires explicit confirmation in TUI mode and is **rejected (Fail-Closed)** in headless (`!ctx.hasUI`) mode.

### 3. Session Observability & Status Bar Indicator

- **Startup Notification**: Displays a lightweight toast `🛡️ Skill Guard active [${mode}]` on `session_start` confirming defense readiness (opt-out via `notifyOnStartup: false`).
- **Footer Status Bar**: Continuously displays `🛡️ guard:${mode}` in the terminal footer, synchronizing dynamically with commands/toggles, and clearing when disabled.

---

## 🧪 Testing

Zero third-party runtime dependencies. Executed via native Node.js test runner:

```bash
npm test
```

---

## 📄 License

[MIT License](./LICENSE) © 2026 CNCSMonster
