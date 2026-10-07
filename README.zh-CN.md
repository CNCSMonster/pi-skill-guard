# pi-skill-guard

[English](./README.md) | **简体中文**

面向 [Pi Coding Agent](https://pi.dev) 的**项目级声明式 Skill 边界防御与 Prompt 瘦身扩展**。

---

## 🎯 为什么需要 pi-skill-guard？

在日常使用中，开发者的本机通常会积累大量全局 Agent Skills（例如股票分析、网络爬虫、招聘检索、云平台运维等）。然而在特定垂直代码仓（例如纯文档知识库、特定微服务模块）中，全局 Skill 会带来严重痛点：

1. **Token 浪费与上下文污染**：Pi 默认将所有全局 Skill 的描述全量注入每轮对话的 `<available_skills>` 块，每轮对话白白消耗数千 Token。
2. **模型意图漂移与幻觉误调**：模型经常因相似语义关键词误触发与当前项目无关的全局技能，甚至调用外部工具产生破坏。
3. **Pi 核心配置的分层局限**：Pi 官方的 `settings.json` 规则在项目级别无法跨界过滤用户全局的 `~/.agents/skills`。

`pi-skill-guard` 提供了**双层物理硬隔离**，以声明式配置彻底解决上述痛点。

---

## 🛡️ 双层物理防御架构

```
用户输入 Prompt
       │
       ▼
[ Layer 1: Prompt 物理裁剪 (before_agent_start) ]
  截获 systemPromptOptions.skills
  剔除所有未授权 Skill ──▶ 仅将白名单技能注入 <available_skills>
       │                   (0 Token 浪费，源头杜绝幻觉)
       ▼
模型生成工具调用 (tool_call)
       │
       ▼
[ Layer 2: 运行时底层阻断 (tool_call) ]
  检测 read 工具是否尝试读取未授权 Skill 目录
  若违规 ──▶ 物理阻断 (block: true) 并返回拦截告警
```

---

## 📦 安装方法

### 方式 A：通过 Git 一键安装（推荐）

在任何终端运行：

```bash
pi install git:github.com/CNCSMonster/pi-skill-guard
```

### 方式 B：本地项目级引用

将本仓库克隆至本地，并在项目的 `.pi/settings.json` 中配置：

```json
{
  "packages": [
    "/path/to/pi-skill-guard"
  ]
}
```

---

## ⚙️ 配置说明

在项目的 `.pi/settings.json`（或全局 `~/.pi/agent/settings.json`）中添加 `skillGuard` 配置段：

### 1. 白名单模式（推荐，最小权限法则）

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

### 2. 黑名单模式

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

### 配置项参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用技能守卫 |
| `mode` | `"allowlist"` \| `"blocklist"` | `"allowlist"` | 隔离模式：白名单模式或黑名单模式 |
| `allow` | string[] | `[]` | 允许的技能名称或通配符（支持 `*` 和 `?`） |
| `block` | string[] | `[]` | 禁止的技能名称或通配符（支持 `*` 和 `?`） |
| `blockReadTool` | boolean | `true` | 是否物理拦截针对未授权技能目录的 `read` 操作 |
| `blockSkillCommand` | boolean | `true` | 是否拦截针对未授权技能的 `/skill:<name>` 命令 |
| `notifyOnFilter` | boolean | `false` | 每轮执行过滤后是否在会话中打印过滤统计 |

---

## 💡 交互命令

在 Pi 交互界面中输入：

```text
/skill-guard
```

随时查看当前项目生效的隔离状态、工作模式及受控规则清单。

---

## 🧪 自动化测试

本项目严守**零第三方运行时依赖**规范，使用 Node.js 原生测试套件：

```bash
npm test
```

---

## 📄 开源许可证

[MIT License](./LICENSE) © 2026 CNCSMonster
