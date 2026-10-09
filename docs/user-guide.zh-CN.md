# pi-skill-guard 用户指南（中文）

[English](./user-guide.md) | 简体中文

> **pi-skill-guard** 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的项目级 Skill 隔离与会话级时序治理扩展的**完整用户使用手册**。
> 快速概览与核心配置表见 [README](../README.zh-CN.md)。

---

## 1. 快速上手

### 1.1 为什么需要 pi-skill-guard？

Pi 默认会在每轮对话开始时，将当前环境中安装的全部 Skill 声明全量注入到系统提示词（System Prompt）的 `<available_skills>` 块中。这在大型项目开发中会带来严重问题：
1. **Token 浪费与上下文膨胀**：即使当前项目只需要 2 个技能，系统仍会将全局数十个无关技能全量塞入，每轮白白消耗数千 Token；
2. **模型注意力分散与越界幻觉**：无关技能的存在会误导大模型（例如在写纯后端代码时，模型尝试调用爬虫或画图技能）；
3. **长会话生命周期失控**：如果在对话中途中断或调整技能，粗暴篡改初始提示词会导致前序数百轮的 KV Cache 全量击穿，且引发模型“记忆撕裂”。

`pi-skill-guard` 提供了**0 运行时依赖、毫秒级响应、双层深度防御**的治理方案。

### 1.2 安装与启用

扩展遵循 Pi 原生扩展规范，无需编译或安装任何 npm 包：

```bash
pi install git:github.com/CNCSMonster/pi-skill-guard
```

安装后扩展默认启用。

### 1.3 核心配置（`.pi/settings.json`）

在项目工作区的受信任配置文件 `.pi/settings.json` 中添加 `skillGuard` 字段：

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

配置项完整说明：
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用技能守卫 |
| `mode` | `"allowlist"` \| `"blocklist"` | `"allowlist"` | 隔离模式：白名单模式或黑名单模式 |
| `allow` | string[] | `[]` | 允许的技能名称或通配符（支持 `*` 和 `?`） |
| `block` | string[] | `[]` | **最高优先级**：禁止的技能名称或通配符（Deny-First，命中必封禁） |
| `blockReadTool` | boolean | `true` | 是否物理拦截针对未授权技能目录的 `read` 操作 |
| `blockSkillCommand` | boolean | `true` | 是否拦截针对未授权技能的 `/skill:<name>` 命令 |
| `notifyOnFilter` | boolean | `false` | 每轮执行过滤后是否在会话中提示过滤统计 |
| `notifyOnStartup` | boolean | `true` | 会话启动时是否弹出瞬态通知提示防护就绪 |

---

## 2. 隔离模式与核心规则

### 2.1 隔离模式（Mode）

| 模式 | 配置值 | 行为特性 | 推荐场景 |
|---|---|---|---|
| **白名单模式** | `"allowlist"`（默认） | 仅显式匹配 `allow` 规则的技能可被模型感知和调用；未列出的技能在开局提示词与工具层双重隐身。 | 生产项目、垂直领域开发（严控模型能力边界） |
| **黑名单模式** | `"blocklist"` | 默认放行所有技能，仅对命中 `block` 规则的技能进行阻断与屏蔽。 | 通用探索、仅需临时禁用少数特定高危技能时 |

### 2.2 Deny-First 刚性铁律（最高优先级）

**无论系统处于何种模式，只要技能名称命中 `block` 规则，一律执行绝对硬性封禁！**
- 即使在 `allowlist` 模式下将某个技能同时写入了 `allow` 和 `block`，`block` 拥有绝对优先权，该技能必定被阻断；
- 在交互式命令中尝试放行已封禁项时，系统会立即执行前置冲突检查并坚决拒绝。

### 2.3 通配符匹配规则

规则支持标准 Glob 通配符：
- `*`：匹配任意长度的字符（例如 `ccm-*` 匹配所有以 `ccm-` 开头的技能）；
- `?`：匹配单个字符（例如 `tool-?` 匹配 `tool-1`、`tool-a`）；
- 规则匹配严格**大小写不敏感（Case-Insensitive）**并自动去除首尾空白字符。

---

## 3. 交互式会话治理（`/skill-guard`）

用户在日常对话中常有临时调整需求（例如：“本会话临时放行绘图技能”、“排查某个被阻断的技能”）。扩展提供会话级管理能力。

### 3.1 呼出交互式 TUI 菜单

在交互终端中直接输入：

```text
/skill-guard
```

将弹出自解释动态菜单：
- 🛡️ **启用 / 🔘 停用守卫**：即时切换守卫状态；
- 🔄 **切换模式**：在白名单与黑名单模式间自由切换；
- ➕ **临时允许（`allow`）**：输入技能名或通配符，临时追加放行；
- 🚫 **临时封禁（`block`）**：输入技能名或通配符，临时追加封禁；
- ➖ **撤销允许（`unallow`）** / 🔓 **解除封禁（`unblock`）**：撤回临时规则；
- ♻️ **重置覆盖（`reset`）**：一键清除当前会话的所有临时改动，恢复至磁盘基线；
- 📋 **查看状态（`status`）**：打印详细的状态诊断报告。

### 3.2 命令行快捷直达

除菜单外，高级用户可直接携带参数调用：

```bash
/skill-guard status                 # 查看当前生效配置与受限技能清单
/skill-guard allow ccm-boss-*       # 临时放行指定模式
/skill-guard block boss-recruitment # 临时封禁指定技能
/skill-guard unallow ccm-boss-*     # 撤销临时放行
/skill-guard unblock boss-recruitment# 解除临时封禁
/skill-guard mode blocklist         # 切换为黑名单模式
/skill-guard reset                  # 重置当前会话为默认状态
```

### 3.3 安全门禁与能力生命周期规范

1. **纯内存隔离与 Append-Only 注入**：会话级操作绝不破坏磁盘上的 `.pi/settings.json`，会话结束或切换后自动清理；
2. **中途增援能力（TUI 正向追加）**：
   - 当中途需要调用受保护的全局技能时，可通过 TUI 多选命令勾选目标技能；
   - 确认后系统自动将技能声明正向**填入当前终端输入框（Editor）**，用户敲击回车即以正向消息形式追加（Append-Only）入会话历史，历史 KV Cache 100% 命中；
3. **中途减能力黄金范式（Handoff & 纯净新会话）**：
   - **设计理念**：坚决避免在同一个会话中向模型灌输“禁止调用 X”等负向提示词（防止引发“粉色大象效应”与思维链污染）；
   - **推荐操作流程**：
     1. 命令 Agent 生成当前任务阶段性交接总结文档（或执行 `/summary`）；
     2. 在 `.pi/settings.json` 的 `allow` 白名单中剔除目标技能；
     3. 开启全新会话并传入交接文档，模型将在最新裁剪的极简上下文中继续高效工作；
     4. 旧会话作为真实历史记录安全封存，历史上下文绝不被纂改。

### 3.4 会话可观测性与底部状态栏指示（Status Bar & Notifications）

为彻底消除会话开局 `Loaded Resources` 物理全量显示带来的困惑，扩展提供了透明的状态感知机制：
1. **启动就绪提示**：会话启动 (`session_start`) 时，若守卫已启用且未被静音（`notifyOnStartup: true`），自动弹出 `🛡️ Skill Guard active [${mode}]` 瞬态气泡，明确告知用户目录级防护已生效。
2. **常驻状态栏指示器**：在 TUI 底部状态栏持久显示标签 `🛡️ guard:${mode}`（例如 `🛡️ guard:allowlist`）。若守卫被停用，状态栏标签自动清除。
3. **动态命令强一致联动**：当通过 `/skill-guard` 命令行或交互菜单切换模式、启用或停用守卫时，底部状态栏标签实时同步更新。

---

## 4. 长会话时序一致性与 KV Cache 保护（深层机制）

在长时间的多轮复杂 Agent 交互中，中途启用或禁用技能常会引发系统级崩溃，`pi-skill-guard` 采用专有架构彻底解决这一痛点：

### 4.1 核心痛点与危害

1. **思维链时序撕裂（Temporal Inconsistency）**：
   若模型在第 1 轮使用了技能 $X$，其思考内容（`thinking`）已详细推导了该技能。若第 2 轮中途关闭技能 $X$ 并粗暴修改第 0 轮 System Prompt，后续轮次中模型会看到自相矛盾的上下文（*“开局声明没有技能 X，但上一轮的我却成功使用了技能 X”*），从而引发严重的逻辑错乱与幻觉。
2. **KV Cache 全量击穿（Cache Invalidation）**：
   大模型前缀缓存（Prefill KV Cache）依赖最长公共前缀匹配。中途修改处于最前端的 System Prompt，会导致历史成千上万 Token 的缓存瞬间全部失效，首字响应时间（TTFT）激增 3~5 秒，成本飙升。

### 4.2 解决方案：前缀绝对不可变 + 尾部约束注入

```
[开局第 0 轮 System Prompt (绝对冻结不可变)] ──▶ [多轮对话历史 (持续命中 KV Cache)] ──▶ [当前输入 + <active_skill_constraints>]
```

1. **开局前缀绝对不可变（INV-1）**：
   会话一旦产生第 1 轮对话，开局 System Prompt 绝对不再做破坏性删除或增补，确保历史长上下文 99%+ 持续命中 KV Cache；
2. **尾部约束纯内存投影（INV-2 ~ INV-4）**：
   中途发生的任何禁用或新增技能，自动通过 Pi 的 `pi.on("context")` 钩子在发给模型前的一瞬间，规整化为 `<active_skill_constraints>` 追加在**最后一个 `user` 消息末尾**。
   - 零写盘：不修改磁盘 `.jsonl` 会话日志；
   - 零显示污染：终端界面保持用户原始输入的纯净；
   - 严格角色交替：不产生多余独立 user 节点，杜绝 API 400 报错；
   - 确定性排序：输出强制按 ASCII 字母升序排列，避免 Cache 抖动。
3. **工具网关双通道深度防御（INV-5）**：
   - 即使模型注意力偶发漂移，尝试通过 `read` 读取技能文件或通过 `bash` 命令行执行技能脚本，工具网关均会执行物理硬阻断；
   - 拦截回执包含建设性自愈文案：
     `[Skill Guard Blocked]: Access to skill "<skill>" is restricted in the current session. Operational guidance: Please adhere to <active_skill_constraints> and proceed using native tools (read/bash/edit) or alternative approved approaches without invoking this skill.`

---

## 5. 常见问题与排查指南（FAQ）

### Q1: 为什么我在 `.pi/settings.json` 里修改了配置，当前会话没有立刻生效？
- **原因**：当前会话中可能存在临时覆盖（Runtime Override），其优先级高于磁盘配置。
- **解决办法**：在会话中执行 `/skill-guard reset`，即可重置为磁盘最新配置。

### Q2: 为什么我执行了 `/skill-guard allow my-tool`，系统提示拒绝并报错？
- **原因**：`my-tool` 命中了基线配置或当前会话的 `block` 黑名单规则。
- **依据**：项目严格执行 Deny-First 铁律，`allow` 绝不能推翻 `block`。如需放行，请先解封（`unblock`）或调整黑名单规则。

### Q3: 以前在 `.pi/skill-guard.json` 中配置的规则为什么不生效了？
- **原因**：为防止绕过 Pi 核心的 Trust 工作区受信任安全边界，独立文件读取已彻底废弃。
- **解决办法**：请将配置迁移至受信任的 `.pi/settings.json` 的 `skillGuard` 字段中。

### Q4: 扩展是否引入了外部 npm 依赖？会不会拖慢 Pi 的启动速度？
- **回答**：`pi-skill-guard` 严守 **0 第三方运行时依赖** 纪律，所有逻辑均基于 Node.js 原生 API 实现，执行开销在毫秒级以内，对冷启动时间几乎零影响。
