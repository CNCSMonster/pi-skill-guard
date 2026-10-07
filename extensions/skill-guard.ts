import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  extractSkillNameFromPath,
  isSkillAllowed,
  type SkillGuardConfig,
} from "./matcher.ts";

/**
 * 解析并加载 SkillGuard 的配置
 * 优先级：
 * 1. pi.getSettings().skillGuard
 * 2. ./.pi/settings.json 中的 skillGuard 字段
 * 3. ./.pi/skill-guard.json 独立配置文件
 * 4. 默认配置 DEFAULT_CONFIG
 */
export function resolveConfig(pi?: ExtensionAPI): Required<SkillGuardConfig> {
  // 1. 从 Pi 运行态设置获取
  try {
    const effective = (pi?.getSettings?.() as Record<string, unknown> | undefined)?.skillGuard;
    if (effective && typeof effective === "object") {
      return { ...DEFAULT_CONFIG, ...(effective as Partial<SkillGuardConfig>) };
    }
  } catch {
    // 忽略异常，降级到文件读取
  }

  // 2. 从项目级 .pi/settings.json 获取
  try {
    const projectSettingsPath = join(process.cwd(), ".pi", "settings.json");
    if (existsSync(projectSettingsPath)) {
      const parsed = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
      if (parsed.skillGuard && typeof parsed.skillGuard === "object") {
        return { ...DEFAULT_CONFIG, ...parsed.skillGuard };
      }
    }
  } catch {
    // 忽略异常
  }

  // 3. 从独立文件 .pi/skill-guard.json 获取
  try {
    const dedicatedPath = join(process.cwd(), ".pi", "skill-guard.json");
    if (existsSync(dedicatedPath)) {
      const parsed = JSON.parse(readFileSync(dedicatedPath, "utf-8"));
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // 忽略异常
  }

  return DEFAULT_CONFIG;
}

export default function skillGuard(pi: ExtensionAPI): void {
  // 1. 系统提示词物理裁剪：在模型收到 Prompt 前剔除非白名单 Skill
  pi.on("before_agent_start", (event) => {
    const config = resolveConfig(pi);
    if (!config.enabled) return;

    if (event.systemPromptOptions?.skills) {
      const originalCount = event.systemPromptOptions.skills.length;
      event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) =>
        isSkillAllowed(skill.name, config)
      );
      const filteredCount = originalCount - event.systemPromptOptions.skills.length;

      if (config.notifyOnFilter && filteredCount > 0) {
        pi.sendMessage({
          customType: "skill_guard_info",
          content: `🛡️ [skill-guard] 已为您过滤 ${filteredCount} 个非授权 Skill，当前生效 ${event.systemPromptOptions.skills.length} 个。`,
          display: true,
        });
      }
    }
  });

  // 2. 运行时底层阻断：防止模型通过 read 工具直接读取未授权 Skill 目录
  pi.on("tool_call", (event) => {
    const config = resolveConfig(pi);
    if (!config.enabled || !config.blockReadTool) return;

    if (event.toolName === "read") {
      const targetPath = (event.input as { path?: string })?.path || "";
      const skillName = extractSkillNameFromPath(targetPath);
      if (skillName && !isSkillAllowed(skillName, config)) {
        return {
          block: true,
          reason: `[skill-guard] 技能 "${skillName}" 在当前项目中未被授权（模式: ${config.mode}）。`,
        };
      }
    }
  });

  // 3. 命令层拦截：防止手动或通过输入触发已封禁的 /skill:xxx 命令
  pi.on("input", (event, ctx: ExtensionContext) => {
    const config = resolveConfig(pi);
    if (!config.enabled || !config.blockSkillCommand) return;

    const trimmed = event.text.trim();
    if (trimmed.startsWith("/skill:")) {
      const spaceIdx = trimmed.indexOf(" ");
      const skillName = spaceIdx === -1 ? trimmed.slice(7) : trimmed.slice(7, spaceIdx);
      if (skillName && !isSkillAllowed(skillName, config)) {
        ctx.notify(
          `🛡️ [skill-guard] 命令已阻断：技能 "${skillName}" 在当前项目中未被授权。`,
          "error"
        );
        return { action: "handled" };
      }
    }
  });

  // 4. 用户交互命令：/skill-guard 查看状态与受控清单
  pi.registerCommand("skill-guard", {
    description: "查看当前项目的 Skill Guard 隔离配置与受控状态",
    handler: async (args: string, ctx: ExtensionContext) => {
      const config = resolveConfig(pi);
      const statusIcon = config.enabled ? "🛡️ [已启用]" : "⚪ [已停用]";

      const rules =
        config.mode === "allowlist"
          ? (config.allow.length > 0 ? config.allow.map((r) => `  - ✅ ${r}`).join("\n") : "  (未设置允许规则，全部放行)")
          : (config.block.length > 0 ? config.block.map((r) => `  - 🚫 ${r}`).join("\n") : "  (未设置黑名单规则)");

      const details = [
        `${statusIcon} pi-skill-guard 状态报告`,
        `工作模式: ${config.mode.toUpperCase()}`,
        `工具阻断: ${config.blockReadTool ? "启用" : "停用"} | 命令阻断: ${config.blockSkillCommand ? "启用" : "停用"}`,
        `规则列表:\n${rules}`,
      ].join("\n");

      ctx.notify(details, "info");
    },
  });
}
