/**
 * pi-skill-guard - 模式匹配与配置解析器
 */

export interface SkillGuardConfig {
  enabled?: boolean;
  mode?: "allowlist" | "blocklist";
  allow?: string[];
  block?: string[];
  blockReadTool?: boolean;
  blockSkillCommand?: boolean;
  notifyOnFilter?: boolean;
  notifyOnStartup?: boolean;
}

export const DEFAULT_CONFIG: Required<SkillGuardConfig> = {
  enabled: true,
  mode: "allowlist",
  allow: [],
  block: [],
  blockReadTool: true,
  blockSkillCommand: true,
  notifyOnFilter: false,
  notifyOnStartup: true,
};

/**
 * 将包含通配符（* 和 ?）的 glob 表达式转换为等效的正则表达式
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * 检查给定 skillName 是否匹配 patterns 列表中的任意一项
 */
export function matchesAnyPattern(skillName: string, patterns: string[]): boolean {
  if (!skillName || typeof skillName !== "string") return false;
  const target = skillName.trim().toLowerCase();

  for (const pattern of patterns) {
    if (!pattern || typeof pattern !== "string") continue;
    const trimmed = pattern.trim().toLowerCase();
    if (!trimmed) continue;

    if (trimmed.includes("*") || trimmed.includes("?")) {
      if (globToRegex(trimmed).test(target)) {
        return true;
      }
    } else {
      if (trimmed === target) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 根据配置判断指定 Skill 是否允许使用
 * 严格执行 Deny-First 原则：命中 block 必封禁
 */
export function isSkillAllowed(skillName: string, userConfig?: Partial<SkillGuardConfig>): boolean {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  if (!config.enabled) return true;
  if (!skillName || typeof skillName !== "string") return false;

  const normalizedSkill = skillName.trim().toLowerCase();

  // 1. 最高优先级：黑名单硬拦截（无论处于 allowlist 还是 blocklist）
  if (config.block && config.block.length > 0) {
    if (matchesAnyPattern(normalizedSkill, config.block)) {
      return false; // 硬性封禁
    }
  }

  // 2. 黑名单模式：未被 block 拦截即可放行
  if (config.mode === "blocklist") {
    return true;
  }

  // 3. 白名单模式：白名单为空则全放行，否则必须命中 allow
  if (!config.allow || config.allow.length === 0) {
    return true;
  }

  return matchesAnyPattern(normalizedSkill, config.allow);
}
