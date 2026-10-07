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
}

export const DEFAULT_CONFIG: Required<SkillGuardConfig> = {
  enabled: true,
  mode: "allowlist",
  allow: [],
  block: [],
  blockReadTool: true,
  blockSkillCommand: true,
  notifyOnFilter: false,
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
  for (const pattern of patterns) {
    if (!pattern || typeof pattern !== "string") continue;
    const trimmed = pattern.trim();
    if (!trimmed) continue;

    if (trimmed.includes("*") || trimmed.includes("?")) {
      if (globToRegex(trimmed).test(skillName)) {
        return true;
      }
    } else {
      if (trimmed.toLowerCase() === skillName.toLowerCase()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 根据配置判断指定 Skill 是否允许使用
 */
export function isSkillAllowed(skillName: string, userConfig?: Partial<SkillGuardConfig>): boolean {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  if (!config.enabled) return true;

  if (config.mode === "blocklist") {
    // 黑名单模式：命中 block 即拒绝，否则放行
    const isBlocked = matchesAnyPattern(skillName, config.block);
    return !isBlocked;
  }

  // 白名单模式（默认）：命中 allow 放行，未命中则拒绝
  // 如果白名单为空，默认允许所有（防止未配置时意外清空技能）
  if (!config.allow || config.allow.length === 0) {
    return true;
  }

  return matchesAnyPattern(skillName, config.allow);
}

/**
 * 从文件路径中提取其归属的技能名称
 *
 * 匹配模式如：
 * - .../.agents/skills/<skill-name>/...
 * - .../.pi/skills/<skill-name>/...
 * - .../skills/<skill-name>/SKILL.md
 */
export function extractSkillNameFromPath(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;

  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)(?:\.agents\/skills|\.pi\/skills|\.claude\/skills|skills)\/([^/]+)(?:\/|$)/);

  if (match && match[1]) {
    // 忽略自身就是 "skills" 文件夹的情况
    const candidate = match[1].trim();
    if (candidate && candidate !== "SKILL.md") {
      return candidate;
    }
  }

  return null;
}
