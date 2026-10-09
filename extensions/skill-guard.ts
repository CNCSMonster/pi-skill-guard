/**
 * pi-skill-guard - 极简声明式技能守卫扩展
 *
 * 核心职责：
 * 1. 开局在 before_agent_start 静默修剪 skills 数组，未授权技能物理剔除，0 Token 浪费
 * 2. 状态栏与启动感知指示器
 * 3. 中途加能力：/skill-guard mount TUI 多选直接将正向能力提示词填入输入框（Editor）
 * 4. 零工具拦截，零输入拦截，零尾部负向提示词注入（彻底避免粉色大象效应）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  isSkillAllowed,
  matchesAnyPattern,
  type SkillGuardConfig,
} from "./matcher.ts";

export interface SkillItem {
  name: string;
  description?: string;
  filePath?: string;
  baseDir?: string;
  location?: string;
}

// 缓存全局技能原始列表，便于 /skill-guard mount 检索未放行项
const knownGlobalSkills: SkillItem[] = [];

export function updateKnownSkills(skills: SkillItem[]): void {
  for (const s of skills) {
    if (!s?.name) continue;
    const exists = knownGlobalSkills.some(
      (item) => item.name.toLowerCase() === s.name.toLowerCase()
    );
    if (!exists) {
      knownGlobalSkills.push({ ...s });
    }
  }
}

export function getKnownSkills(): SkillItem[] {
  return [...knownGlobalSkills];
}

export function clearKnownSkills(): void {
  knownGlobalSkills.length = 0;
}

// 会话级临时放行/封禁覆盖（会话重启时重置）
const sessionExtraAllow = new Map<string, string[]>();
const sessionExtraBlock = new Map<string, string[]>();

export function clearAllSessionDeltas(): void {
  sessionExtraAllow.clear();
  sessionExtraBlock.clear();
}

function resolveSessionId(ctx?: ExtensionContext): string | undefined {
  if (!ctx) return undefined;
  return ctx.sessionManager?.getSessionId?.() || "default-session";
}

/**
 * 安全解析配置，带有容错保护
 */
export function resolveConfig(pi: ExtensionAPI): Required<SkillGuardConfig> {
  const raw = (pi.getSettings?.("skillGuard") || {}) as Record<string, unknown>;

  const config: Required<SkillGuardConfig> = {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    mode: raw.mode === "blocklist" || raw.mode === "allowlist" ? raw.mode : DEFAULT_CONFIG.mode,
    allow: Array.isArray(raw.allow) ? raw.allow.filter((i): i is string => typeof i === "string") : [],
    block: Array.isArray(raw.block) ? raw.block.filter((i): i is string => typeof i === "string") : [],
    notifyOnFilter: typeof raw.notifyOnFilter === "boolean" ? raw.notifyOnFilter : DEFAULT_CONFIG.notifyOnFilter,
    notifyOnStartup: typeof raw.notifyOnStartup === "boolean" ? raw.notifyOnStartup : DEFAULT_CONFIG.notifyOnStartup,
  };

  return config;
}

/**
 * 计算会话最终生效配置（基础配置 + 临时覆盖）
 */
export function getEffectiveConfig(
  base: Required<SkillGuardConfig>,
  sessionId?: string
): { config: Required<SkillGuardConfig>; isOverridden: boolean; extraAllow: string[]; extraBlock: string[] } {
  if (!sessionId) {
    return { config: { ...base }, isOverridden: false, extraAllow: [], extraBlock: [] };
  }

  const extraAllow = sessionExtraAllow.get(sessionId) || [];
  const extraBlock = sessionExtraBlock.get(sessionId) || [];
  const isOverridden = extraAllow.length > 0 || extraBlock.length > 0;

  const mergedAllow = Array.from(new Set([...base.allow, ...extraAllow]));
  const mergedBlock = Array.from(new Set([...base.block, ...extraBlock]));

  return {
    config: {
      ...base,
      allow: mergedAllow,
      block: mergedBlock,
    },
    isOverridden,
    extraAllow,
    extraBlock,
  };
}

/**
 * 更新底部状态栏指示器
 */
export function updateStatusBar(ctx: ExtensionContext, config: Required<SkillGuardConfig>): void {
  if (!ctx?.hasUI || !ctx.ui?.setStatusBar) return;

  if (!config.enabled) {
    ctx.ui.setStatusBar(undefined);
    return;
  }

  const label = config.mode === "allowlist" ? `allow:${config.allow.length}` : `block:${config.block.length}`;
  ctx.ui.setStatusBar(`🛡️ SG [${label}]`);
}

/**
 * 生成正向能力提示词模板，供直接填入输入框
 */
export function generateSkillMountPrompt(skills: SkillItem[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const loc = s.location || s.baseDir || s.filePath || "";
    const locDesc = loc ? ` (路径: ${loc})` : "";
    const desc = s.description ? `: ${s.description}` : "";
    return `- ${s.name}${desc}${locDesc}`;
  });

  return `[能力挂载] 本次任务已解锁以下技能，请按需查阅并调用：\n${lines.join("\n")}\n`;
}

/**
 * 处理 TUI /skill-guard mount 交互
 */
export async function handleMountCommand(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const base = resolveConfig(pi);
  const sessionId = resolveSessionId(ctx);
  const { config } = getEffectiveConfig(base, sessionId);

  const allSkills = getKnownSkills();
  // 找出当前未被放行的技能
  const unmountedSkills = allSkills.filter((s) => !isSkillAllowed(s.name, config));

  if (unmountedSkills.length === 0) {
    const msg = "当前所有全局技能已处于放行状态，无需挂载。";
    if (ctx.hasUI) ctx.ui.notify(msg, "info");
    else console.log(msg);
    return;
  }

  if (!ctx.hasUI) {
    console.log("未放行技能列表:\n" + unmountedSkills.map((s) => `  - ${s.name}`).join("\n"));
    return;
  }

  const items = unmountedSkills.map((s) => `${s.name} - ${s.description || "无描述"}`);
  const selected = await ctx.ui.select("选择要挂载到当前会话输入框的技能 (选中后将填入输入框):", items);
  if (!selected) return;

  const chosenName = selected.split(" - ")[0].trim();
  const chosenSkill = unmountedSkills.find((s) => s.name.toLowerCase() === chosenName.toLowerCase());
  if (!chosenSkill) return;

  const mountPrompt = generateSkillMountPrompt([chosenSkill]);

  if (ctx.ui.setEditorText) {
    ctx.ui.setEditorText(mountPrompt);
    ctx.ui.notify(`✅ 已将技能 [${chosenSkill.name}] 挂载声明填入输入框，请核对后回车发送。`, "info");
  } else {
    ctx.ui.notify(`无法获取输入框引用，提示词如下:\n${mountPrompt}`, "warning");
  }
}

/**
 * 主命令处理
 */
export async function handleSkillGuardCommand(
  args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  const trimmed = args.trim();
  const base = resolveConfig(pi);
  const sessionId = resolveSessionId(ctx);
  const { config, isOverridden, extraAllow, extraBlock } = getEffectiveConfig(base, sessionId);

  if (trimmed === "mount") {
    await handleMountCommand(ctx, pi);
    return;
  }

  if (!trimmed && ctx.hasUI) {
    const statusLabel = config.enabled ? "已启用" : "已停用";
    const modeLabel = config.mode.toUpperCase();
    const options = [
      "⚡ 挂载未放行技能到输入框 (mount)",
      "📋 查看完整生效规则与状态报告",
      config.enabled ? "🔘 停用守卫" : "🛡️ 启用守卫",
    ];

    const choice = await ctx.ui.select(`Skill Guard 管理 [${statusLabel} | ${modeLabel}]`, options);
    if (!choice) return;

    if (choice.startsWith("⚡ 挂载")) {
      await handleMountCommand(ctx, pi);
    } else if (choice.startsWith("📋 查看")) {
      printStatusReport(config, isOverridden, extraAllow, extraBlock, ctx);
    } else if (choice.includes("停用") || choice.includes("启用")) {
      // 切换状态提示
      ctx.ui.notify("请在 .pi/settings.json 中修改 enabled 配置项以实现持久化控制。", "info");
    }
    return;
  }

  // CLI 快捷子命令
  if (trimmed === "" || trimmed === "status") {
    printStatusReport(config, isOverridden, extraAllow, extraBlock, ctx);
  } else {
    const msg = `未知子命令: "${trimmed}"。可用指令: mount, status`;
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    else console.warn(msg);
  }
}

function printStatusReport(
  config: Required<SkillGuardConfig>,
  isOverridden: boolean,
  extraAllow: string[],
  extraBlock: string[],
  ctx: ExtensionContext
): void {
  const statusIcon = config.enabled ? "🛡️ [已启用]" : "⚪ [已停用]";
  const allowLines = config.allow.length > 0
    ? config.allow.map((r) => `  - ✅ ${r}`).join("\n")
    : "  (未设置允许规则)";

  const blockLines = config.block.length > 0
    ? config.block.map((r) => `  - 🚫 ${r}`).join("\n")
    : "  (未设置黑名单规则)";

  const details = [
    `${statusIcon} pi-skill-guard 极简状态报告`,
    `工作模式: ${config.mode.toUpperCase()}`,
    `白名单规则 (Allow):\n${allowLines}`,
    `黑名单规则 (Block):\n${blockLines}`,
    `运行机制: 开局静默物理修剪，零运行时工具拦截，零负向提示词注入`,
  ].join("\n");

  if (ctx.hasUI) {
    ctx.ui.notify(details, "info");
  } else {
    console.log(details);
  }
}

// ==========================================
// 插件主体挂载
// ==========================================

export default function skillGuard(pi: ExtensionAPI): void {
  // 1. 会话启动感知
  pi.on("session_start", (_event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId) {
      sessionExtraAllow.delete(sessionId);
      sessionExtraBlock.delete(sessionId);
    }

    if (ctx.hasUI) {
      const base = resolveConfig(pi);
      const { config } = getEffectiveConfig(base, sessionId);
      if (config.enabled && (config.notifyOnStartup ?? true)) {
        ctx.ui.notify(`🛡️ Skill Guard active [${config.mode}]`, "info");
      }
      updateStatusBar(ctx, config);
    }
  });

  pi.on("session_shutdown", () => {
    clearAllSessionDeltas();
  });

  // 2. 唯一核心机制：开局在 before_agent_start 静默原地修改 skills 数组
  pi.on("before_agent_start", (event, ctx) => {
    if (event.systemPromptOptions?.skills) {
      // 记录全局技能清单，供中途 /skill-guard mount 查阅
      updateKnownSkills(event.systemPromptOptions.skills);
    }

    const base = resolveConfig(pi);
    const sessionId = resolveSessionId(ctx);
    const { config } = getEffectiveConfig(base, sessionId);
    if (!config.enabled) return;

    if (event.systemPromptOptions?.skills) {
      const originalCount = event.systemPromptOptions.skills.length;
      const filtered = event.systemPromptOptions.skills.filter((skill) =>
        isSkillAllowed(skill.name, config)
      );

      // 原地清空并写回，确保不论引用方式均真实生效
      try {
        event.systemPromptOptions.skills.splice(
          0,
          event.systemPromptOptions.skills.length,
          ...filtered
        );
      } catch {
        // 若数组被 freeze 保护，安全回退到直接属性替换
        event.systemPromptOptions.skills = filtered;
      }

      const filteredCount = originalCount - event.systemPromptOptions.skills.length;
      if (config.notifyOnFilter && filteredCount > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `🛡️ [skill-guard] 已静默裁剪 ${filteredCount} 个未授权 Skill，当前生效 ${event.systemPromptOptions.skills.length} 个。`,
          "info"
        );
      }
    }
  });

  // 3. 注册统一管理命令
  pi.registerCommand("skill-guard", {
    description: "查看状态与正向挂载技能到输入框 (/skill-guard mount)",
    handler: (args, ctx) => handleSkillGuardCommand(args, ctx, pi),
  });
}
