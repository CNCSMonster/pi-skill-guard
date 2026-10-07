# pi-skill-guard

**English** | [简体中文](./README.zh-CN.md)

Project-level declarative skill boundary defense and prompt pruning extension for [Pi Coding Agent](https://pi.dev).

---

## 🎯 Why pi-skill-guard?

As developers accumulate dozens of global Agent Skills (web crawlers, financial scrapers, recruitment tools, cloud ops), working inside specialized repositories (such as documentation monorepos or sensitive codebases) introduces distinct pain points:

1. **Token Waste & Context Pollution**: Pi injects all installed skill names and descriptions into `<available_skills>` every turn, wasting thousands of context tokens.
2. **Intent Drift & Accidental Invocations**: Models frequently misidentify skill keywords and execute foreign skills unrelated to the current task.
3. **Core Configuration Scoping Limits**: Pi's standard project-level `settings.json` resource filters cannot cross scope boundaries to filter global `~/.agents/skills`.

`pi-skill-guard` delivers **dual-layer mechanical isolation** with zero runtime dependencies.

---

## 🛡️ Dual-Layer Defense Architecture

```
User Prompt
     │
     ▼
[ Layer 1: Prompt Pruning (before_agent_start) ]
  Intercepts systemPromptOptions.skills
  Filters non-whitelisted skills ──▶ Only authorized skills injected into <available_skills>
     │                               (0 token waste, source-level hallucination block)
     ▼
Model generates tool_call
     │
     ▼
[ Layer 2: Runtime Tool Interception (tool_call) ]
  Monitors whether 'read' attempts to access unauthorized skill directories
  If violated ──▶ Physically blocked (block: true) with actionable diagnostic message
```

---

## 📦 Installation

### Option A: Direct Git Install (Recommended)

Run in any terminal:

```bash
pi install git:github.com/CNCSMonster/pi-skill-guard
```

### Option B: Local Project Reference

Clone locally and reference in your project's `.pi/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-skill-guard"
  ]
}
```

---

## ⚙️ Configuration

Add a `skillGuard` section inside `.pi/settings.json` (or `~/.pi/agent/settings.json`):

### 1. Allowlist Mode (Recommended - Principle of Least Privilege)

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
| `enabled` | boolean | `true` | Enable or disable the skill guard |
| `mode` | `"allowlist"` \| `"blocklist"` | `"allowlist"` | Guard mode: allowlist or blocklist |
| `allow` | string[] | `[]` | Allowed skills or wildcard patterns (`*`, `?`) |
| `block` | string[] | `[]` | Blocked skills or wildcard patterns (`*`, `?`) |
| `blockReadTool` | boolean | `true` | Intercept `read` tool calls to unauthorized skill directories |
| `blockSkillCommand` | boolean | `true` | Intercept `/skill:<name>` commands for unauthorized skills |
| `notifyOnFilter` | boolean | `false` | Show brief toast/message on prompt filtering |

---

## 💡 Slash Command

Inside Pi session:

```text
/skill-guard
```

Displays active guard status, mode, and current rule definitions.

---

## 🧪 Testing

Zero external runtime dependencies. Runs directly on Node.js native test runner:

```bash
npm test
```

---

## 📄 License

[MIT License](./LICENSE) © 2026 CNCSMonster
