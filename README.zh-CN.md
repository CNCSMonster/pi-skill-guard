# pi-skill-guard

[English](./README.md) | **简体中文** | [完整用户指南](./docs/user-guide.zh-CN.md) | [架构总规范](./docs/architecture-spec.md)

面向 [Pi Coding Agent](https://pi.dev) 的**项目级声明式 Skill 边界防御与 Prompt 瘦身扩展**。

---

## 🎯 为什么需要 pi-skill-guard？

在日常使用中，开发者的本机通常会积累大量全局 Agent Skills（例如股票分析、网络爬虫、招聘检索、云平台运维等）。然而在特定垂直代码仓（例如纯文档知识库、特定微服务模块）中，全局 Skill 会带来严重痛点：

1. **Token 浪费与上下文污染**：Pi 默认将所有全局 Skill 的描述全量注入每轮对话的 `<available_skills>` 块，每轮对话白白消耗数千 Token。
2. **模型意图漂移与幻觉误调**：模型经常因相似语义关键词误触发与当前项目无关的全局技能，甚至调用外部工具产生破坏。
3. **Pi 核心配置的分层局限**：Pi 官方的 `settings.json` 规则在项目级别无法跨界过滤用户全局的 `~/.pi/agent/skills` 或 `~/.agents/skills`。

`pi-skill-guard` 提供了**双层物理硬隔离**，以声明式配置彻底解决上述痛点。

---

## 🛡️ 双层物理防御架构

```
用户输入 Prompt
       │
       ▼
[ Layer 1: Prompt 物理裁剪 (before_agent_start) ]
  原地裁剪 event.systemPromptOptions.skills
  剔除所有未授权 Skill ──▶ 仅将白名单技能注入 <available_skills>
       │                   (0 Token 浪费，源头杜绝幻觉)
       ▼
模型生成工具调用 (tool_call)
       │
       ▼
[ Layer 2: 运行时底层阻断 (tool_call) ]
  双路比对逻辑与真实物理路径，拦截 read 工具越权读取未授权 Skill 目录
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
    "block": [
      "*-dangerous"
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
| `block` | string[] | `[]` | **最高优先级**：禁止的技能名称或通配符（Deny-First，命中必封禁） |
| `blockReadTool` | boolean | `true` | 是否物理拦截针对未授权技能目录的 `read` 操作 |
| `blockSkillCommand` | boolean | `true` | 是否拦截针对未授权技能的 `/skill:<name>` 命令 |
| `notifyOnFilter` | boolean | `false` | 每轮执行过滤后是否在会话中提示过滤统计 |

---

## ⚠️ 核心安全设计与重大变更说明

1. **Deny-First 铁律（Breaking Change）**：无论系统处于 `allowlist` 还是 `blocklist` 模式，只要技能名称命中 `block` 规则，一律执行最高优先级硬性阻断。
2. **废弃独立文件读取（Breaking Change）**：基于 Pi 核心 Trust 沙箱安全原则，彻底废弃读取未受信任目录下的 `.pi/skill-guard.json`，配置唯一权威来源于受信任的 `.pi/settings.json` 的 `skillGuard` 字段。
3. **严格 Fail-Closed**：若配置的 `block` 或 `allow` 数组非法或包含全脏数据，系统将自动注入 Fail-Closed 哨兵阻断访问，杜绝静默全放行。
4. **纯内存增量覆盖**：运行时覆盖绝不触碰磁盘，完全隔离在当前会话生命周期内。
5. **前缀不可变与尾部约束注入（KV Cache 保护）**：在多轮对话中途禁用/新增技能时，严禁物理回溯修改第 0 轮 System Prompt，避免长上下文 KV Cache 全量击穿（TTFT 暴增）与模型思维链（Thinking）自相矛盾；系统自动在当前轮次尾部通过 `context` 内存投影注入 `<active_skill_constraints>` 结构化约束，配合 `read` 与 `bash` 双通道工具拦截实现纵深防御。

---

## 💡 交互式管理与命令说明

### 1. 呼出交互式 TUI 菜单

在交互终端中直接输入：

```text
/skill-guard
```

将弹出自解释动态菜单，可直观进行以下操作：
- 🛡️ 启用 / 🔘 停用守卫
- 🔄 切换白名单 / 黑名单模式
- ➕ 添加临时允许规则（`allow`）
- 🚫 添加临时封禁规则（`block`）
- ➖ 撤销临时允许规则（`unallow`）
- 🔓 解除临时封禁规则（`unblock`）
- ♻️ 重置本会话所有临时覆盖（`reset`）
- 📋 查看完整生效规则与状态报告

### 2. 命令行快捷指令

支持直接带参数快速执行：

```bash
/skill-guard status                # 查看当前状态与完整规则报告
/skill-guard enable                # 启用守卫
/skill-guard disable               # 停用守卫（需确认）
/skill-guard mode allowlist        # 切换为白名单模式
/skill-guard mode blocklist        # 切换为黑名单模式（需确认）
/skill-guard allow <pattern>       # 临时放行技能或通配符
/skill-guard block <pattern>       # 临时封禁技能或通配符
/skill-guard unallow <pattern>     # 撤销本会话的临时放行规则
/skill-guard unblock <pattern>     # 解除本会话的临时封禁规则（需确认）
/skill-guard reset                 # 清空本会话所有临时内存覆盖
```

> **放权审查门禁**：任何导致技能放行范围扩大的操作（如停用守卫、切换黑名单、解除封禁、退化全放行等），在 TUI 模式下必须经过二次弹窗确认；在无界面的 Headless 模式下一律 **Fail-Closed 拒绝**。

---

## 🧪 自动化测试

本项目严守**零第三方运行时依赖**规范，使用 Node.js 原生测试套件：

```bash
npm test
```

---

## 📄 开源许可证

[MIT License](./LICENSE) © 2026 CNCSMonster
