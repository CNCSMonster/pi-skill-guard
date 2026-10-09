# pi-skill-guard 极简设计规范

- **定位**: Pi Coding Agent 的极简提示词裁剪插件
- **核心原则**: 只做一件事：在开局按白名单静默裁剪技能，做对、做干净、不搞多余微操

---

## 1. 解决什么问题

### 1.1 痛点
Pi Coding Agent 启动时，默认会把用户全局目录（`~/.agents/skills/` 等）下所有已安装的技能声明全量塞入系统提示词的 `<available_skills>` 块中。

这在项目开发中带来两个纯粹的痛点：
1. **Token 浪费**：即使当前项目只需要 2 个技能，全局几十个技能依然每轮对话消耗数百至上千 Token；
2. **注意力分散与幻觉**：无关技能暴露给模型，增加了模型产生幻觉或误触发无关能力的概率。

### 1.2 目标与非目标
- **目标**：在提示词组装阶段（`before_agent_start`），按项目白名单静默裁剪 `skills` 数组，只保留当前项目需要的技能；
- **非目标（明确不做）**：
  - ❌ **不做运行时工具调用拦截**：不挂载 `tool_call` 去拦截底层的 `read` 或 `bash` 调用，不给模型设羁绊；
  - ❌ **不做输入命令拦截**：不挂载 `input` 拦截用户的 `/skill:*` 命令，尊重开发者的显式指令；
  - ❌ **不做尾部负向约束**：坚决不在上下文末尾注入“禁止调用 X、不要想 Y”的负向提示词，彻底避免“粉色大象效应”污染模型推理思维链；
  - ❌ **不在会话中途做复杂的“注销/减能力”**：中途减能力坚决走 Handoff 范式在新会话中纯净重开。

---

## 2. 核心工作机制

整个插件的核心运行链路极其简单直接：

```
[ 开发者输入 Prompt ]
         │
         ▼
[ 唯一核心：before_agent_start 提示词静默裁剪 ]
  1. 读取当前项目的配置（白名单）
  2. 原地过滤 event.systemPromptOptions.skills 数组
  3. 未在白名单中的全局技能物理剔除（不进入 <available_skills>）
         │
         ▼
[ LLM 正常推理与规划 ]
         │
         ▼
[ 本地原生工具正常执行（read / bash / edit 自由调用，零拦截） ]
```

### 2.1 原地修改与数组安全性保证
- **直接操作引用**：直接修改 `event.systemPromptOptions.skills` 数组引用，使用 `skills.splice(0, skills.length, ...filtered)` 清空并填入过滤项；
- **Freeze 防御降级**：若检测到 `skills` 数组被 `Object.freeze` 冻结，安全回退至替换整个属性引用 `event.systemPromptOptions.skills = filtered`，杜绝运行时异常；
- **结果**：未在白名单中的技能完全不进入系统提示词，模型看不见就不会调用，Token 也不会浪费。

---

## 3. 技能增减操作指引

### 3.1 开局白名单配置
在项目的 `.pi/settings.json` 中配置白名单（**白名单是唯一合法模式，无多余 mode 字段**）：
```json
{
  "skillGuard": {
    "enabled": true,
    "allow": ["ccm-*", "archify"]
  }
}
```

#### 匹配规则说明（大小写不敏感）：
- `"archify"`：精确匹配技能名 `archify`（或 `Archify`）；
- `"ccm-*"`：前缀通配，匹配 `ccm-boss`、`ccm-note`，但不匹配 `arch-ccm`；
- `"*search*"`：包含通配，匹配任意包含 search 的技能名。

### 3.2 中途加能力（TUI 填入输入框）
若会话进行到一半，开发者突然需要用到某个未放行的全局技能：
1. 通过 Pi 注册的原生命令 `/skill-guard` 呼出 TUI 菜单，选择需要临时使用的技能；
2. 选中回车后，系统自动将正向能力声明模板**直接填入终端输入框（Editor/Input Box）**：
   ```text
   [能力挂载] 本次任务已解锁以下技能，请按需调用：
   - archify: Create polished architecture diagrams (location: ~/.agents/skills/archify)
   ```
3. 开发者可直观核对或微调，敲回车发送。消息以标准用户消息追加（Append-Only）入历史，100% 保护历史 KV Cache。

### 3.3 中途减能力（Clean Handoff 范式）
如果任务中途发现需要剥离某些技能：
1. **不在当前会话里做负向注销**（避免负向消息污染后续推理）；
2. **标准流程**：
   - 让 Agent 输出阶段性工作总结（`/summary` 或生成 `handoff.md`）；
   - 在 `.pi/settings.json` 的 `allow` 中移除目标技能；
   - 开启全新会话，载入交接文档继续工作；
   - 旧会话作为真实历史只读归档，新会话从零享受仅包含过滤后技能的纯净上下文。

---

## 4. 边界处理与容错

插件保持最轻量的边界容错，不做过度复杂的变更审计：

| 场景 | 处理策略 |
|---|---|
| 白名单正常命中 | 仅保留匹配项，其余技能静默剔除 |
| 白名单为空数组 `[]` | 剔除所有技能（符合开发者完全不暴露技能的预期） |
| `enabled: false` | 不做任何裁剪，原样放行 |
| 配置缺失或 JSON 格式异常 | 打一条 warning 日志，不执行裁剪（Fail-Open 保持系统可用不崩溃） |

---

## 5. 目录结构

```
extensions/
├── matcher.ts         # 技能名通配符匹配与大小写归一化
└── skill-guard.ts     # 插件入口：before_agent_start 提示词裁剪与 TUI 输入框注入

tests/
├── matcher.test.ts    # 匹配规则单元测试
└── skill-guard.test.ts# 提示词物理裁剪与白名单行为测试
```
