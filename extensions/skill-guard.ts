import { existsSync, realpathSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  isSkillAllowed,
  matchesAnyPattern,
  type SkillGuardConfig,
} from "./matcher.ts";

// 静态兜底特征（已补齐 Pi 全局 Agent 真实目录）
const KNOWN_SKILL_ROOT_PATTERNS = [
  "/.pi/agent/skills/",
  "/.pi/skills/",
  "/.agents/skills/",
  "/.claude/skills/",
];

// 动态注册的技能目录前缀表（由 before_agent_start 填充）
const dynamicSkillDirPrefixes = new Map<string, string>();
const warnedLegacyCwds = new Set<string>();

/**
 * 已知 Skill 根目录与文件路径反查映射表 (normalizedPath -> skillName)
 */
export const skillPathMap = new Map<string, string>();

export function resetRegisteredSkillLocations(): void {
  dynamicSkillDirPrefixes.clear();
  skillPathMap.clear();
}

/**
 * 注册已知技能的物理与逻辑真实目录
 */
export function registerSkillLocations(skills: Array<{ name: string; baseDir?: string; filePath?: string; description?: string }>): void {
  for (const s of skills) {
    if (!s?.name) continue;
    const name = s.name.trim().toLowerCase();
    const dirs: string[] = [];

    if (s.baseDir) {
      dirs.push(s.baseDir);
      const normBase = posix.normalize(resolve(s.baseDir).replace(/\\/g, "/"));
      skillPathMap.set(normBase, name);
      try {
        const realBase = posix.normalize(realpathSync(normBase).replace(/\\/g, "/"));
        skillPathMap.set(realBase, name);
      } catch {}
    }

    if (s.filePath) {
      dirs.push(posix.dirname(s.filePath.replace(/\\/g, "/")));
      const normFile = posix.normalize(resolve(s.filePath).replace(/\\/g, "/"));
      skillPathMap.set(normFile, name);
      try {
        const realFile = posix.normalize(realpathSync(normFile).replace(/\\/g, "/"));
        skillPathMap.set(realFile, name);
      } catch {}
    }

    for (const d of dirs) {
      const norm = posix.normalize(resolve(d).replace(/\\/g, "/"));
      dynamicSkillDirPrefixes.set(norm.endsWith("/") ? norm : `${norm}/`, name);
      try {
        const real = posix.normalize(realpathSync(norm).replace(/\\/g, "/"));
        dynamicSkillDirPrefixes.set(real.endsWith("/") ? real : `${real}/`, name);
      } catch {
        // 忽略不存在路径的 realpath 失败
      }
    }
  }
}

function matchSkillInPath(pathNormalized: string, cwdNormalized: string): string[] {
  const matched: string[] = [];
  const lower = pathNormalized.toLowerCase();
  // 必改 A：尾斜杠规整化，支持直接读取目录本身（read <dir>）
  const withSlash = pathNormalized.endsWith("/") ? pathNormalized : `${pathNormalized}/`;
  const withSlashLower = withSlash.toLowerCase();

  // 1. 动态已注册真实前缀精确匹配（高优先级）
  for (const [prefix, skillName] of dynamicSkillDirPrefixes.entries()) {
    if (withSlash.startsWith(prefix) || withSlashLower.startsWith(prefix.toLowerCase())) {
      matched.push(skillName);
    }
  }

  // 2. 静态特征根兜底匹配
  for (const marker of KNOWN_SKILL_ROOT_PATTERNS) {
    let searchIdx = 0;
    while (true) {
      const idx = lower.indexOf(marker, searchIdx);
      if (idx === -1) break;
      const rest = pathNormalized.slice(idx + marker.length);
      const firstSlash = rest.indexOf("/");
      const candidate = (firstSlash === -1 ? rest : rest.slice(0, firstSlash)).trim();
      const candLower = candidate.toLowerCase();
      if (candLower && candLower !== "skill.md" && candLower !== "." && candLower !== "..") {
        matched.push(candLower);
      }
      searchIdx = idx + marker.length;
    }
  }

  // 3. 当前工作区内 ./skills/ 目录兜底（严格锚定 cwd 前缀）
  const projectSkillsPrefix = `${cwdNormalized.toLowerCase()}/skills/`;
  if (lower.startsWith(projectSkillsPrefix)) {
    const rest = pathNormalized.slice(projectSkillsPrefix.length);
    const firstSlash = rest.indexOf("/");
    const candidate = (firstSlash === -1 ? rest : rest.slice(0, firstSlash)).trim();
    const candLower = candidate.toLowerCase();
    if (candLower && candLower !== "skill.md" && candLower !== "." && candLower !== "..") {
      matched.push(candLower);
    }
  }

  return matched;
}

/**
 * 从路径中双路提取可能涉及的技能名称
 */
export function extractSkillNamesFromPath(filePath: string, cwd?: string): string[] {
  if (!filePath || typeof filePath !== "string") return [];

  const base = cwd ?? process.cwd();
  const logical = posix.normalize(resolve(base, filePath).replace(/\\/g, "/"));
  const pathCandidates = new Set<string>([logical]);

  try {
    const real = posix.normalize(realpathSync(logical).replace(/\\/g, "/"));
    pathCandidates.add(real);
  } catch {
    // 文件不存在时，解析最近一级存在的父目录
    try {
      const parent = posix.dirname(logical);
      const realParent = posix.normalize(realpathSync(parent).replace(/\\/g, "/"));
      pathCandidates.add(posix.join(realParent, posix.basename(logical)));
    } catch {
      // 忽略父目录解析失败
    }
  }

  const baseLogical = posix.normalize(resolve(base).replace(/\\/g, "/"));
  const cwdVariants = new Set<string>([baseLogical]);
  try {
    const cwdReal = posix.normalize(realpathSync(baseLogical).replace(/\\/g, "/"));
    cwdVariants.add(cwdReal);
  } catch {
    // 忽略 cwd realpath 失败
  }

  const detectedNames = new Set<string>();
  for (const p of pathCandidates) {
    // 优先借助规范化绝对路径映射表精准反查
    const directMatch = skillPathMap.get(p) || skillPathMap.get(p.endsWith("/") ? p.slice(0, -1) : `${p}/`);
    if (directMatch) {
      detectedNames.add(directMatch);
    }

    for (const c of cwdVariants) {
      const names = matchSkillInPath(p, c);
      for (const name of names) {
        detectedNames.add(name);
      }
    }
  }

  return Array.from(detectedNames);
}

/**
 * 校验并提醒废弃的 .pi/skill-guard.json
 */
export function checkLegacyConfigWarning(ctx?: ExtensionContext): void {
  const cwd = ctx?.cwd || process.cwd();
  if (warnedLegacyCwds.has(cwd)) return;

  try {
    const legacyPath = join(cwd, ".pi", "skill-guard.json");
    if (existsSync(legacyPath)) {
      warnedLegacyCwds.add(cwd);
      if (ctx?.hasUI) {
        ctx.ui.notify(
          "⚠️ [skill-guard] 检测到废弃的 .pi/skill-guard.json。出于 Trust 安全边界隔离，该文件不再生效。请将配置迁移至受信任的 .pi/settings.json 的 skillGuard 字段。",
          "warning"
        );
      } else {
        console.warn("[skill-guard] 警告: 检测到废弃的 .pi/skill-guard.json，该文件不再生效。");
      }
    }
  } catch {
    // 忽略检查异常
  }
}

/**
 * 解析并加载 SkillGuard 的配置
 * 唯一权威来源：pi.getSettings().skillGuard
 */
export function resolveConfig(pi?: ExtensionAPI): Required<SkillGuardConfig> {
  let effective: Partial<SkillGuardConfig> | undefined;

  try {
    const settings = pi?.getSettings?.() as Record<string, unknown> | undefined;
    if (settings?.skillGuard && typeof settings.skillGuard === "object") {
      effective = settings.skillGuard as Partial<SkillGuardConfig>;
    }
  } catch (err) {
    console.warn("[skill-guard] 获取 settings.skillGuard 异常，安全降级至默认配置:", err);
  }

  if (!effective) {
    return structuredClone(DEFAULT_CONFIG);
  }

  const enabled = typeof effective.enabled === "boolean" ? effective.enabled : DEFAULT_CONFIG.enabled;

  let mode: "allowlist" | "blocklist" = DEFAULT_CONFIG.mode;
  if (typeof effective.mode === "string") {
    const rawMode = effective.mode.trim().toLowerCase();
    if (rawMode === "blocklist" || rawMode === "allowlist") {
      mode = rawMode;
    } else {
      console.warn(`[skill-guard] 配置警告: 非法 mode "${effective.mode}"，安全回退至 allowlist。`);
      mode = "allowlist";
    }
  } else if (effective.mode !== undefined) {
    console.warn(`[skill-guard] 配置警告: mode 必须为字符串，安全回退至 allowlist。`);
    mode = "allowlist";
  }

  // 对称 Schema 校验 helper
  const sanitizeList = (raw: unknown, fieldName: string, failClosedSentinel: string[]): string[] => {
    if (raw === undefined) {
      return fieldName === "allow" ? structuredClone(DEFAULT_CONFIG.allow) : structuredClone(DEFAULT_CONFIG.block);
    }
    if (Array.isArray(raw)) {
      const valid: string[] = [];
      let hasInvalid = false;
      for (const item of raw) {
        if (typeof item === "string" && item.trim().length > 0) {
          valid.push(item.trim().toLowerCase());
        } else {
          hasInvalid = true;
        }
      }
      if (hasInvalid) {
        console.warn(`[skill-guard] 配置警告: ${fieldName} 数组包含非法项已过滤。`);
      }
      if (raw.length > 0 && valid.length === 0) {
        console.warn(`[skill-guard] 配置错误: ${fieldName} 规则全部非法，触发 Fail-Closed 硬拦截。`);
        return failClosedSentinel;
      }
      return valid;
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      console.warn(`[skill-guard] 配置提示: ${fieldName} 应为数组，已自动转为单规则。`);
      return [raw.trim().toLowerCase()];
    }
    console.warn(`[skill-guard] 配置错误: ${fieldName} 类型非法，触发 Fail-Closed 硬拦截。`);
    return failClosedSentinel;
  };

  const allow = sanitizeList(effective.allow, "allow", ["\0__invalid_config_block_all__"]);
  const block = sanitizeList(effective.block, "block", ["*"]);

  const blockReadTool = typeof effective.blockReadTool === "boolean" ? effective.blockReadTool : DEFAULT_CONFIG.blockReadTool;
  const blockSkillCommand = typeof effective.blockSkillCommand === "boolean" ? effective.blockSkillCommand : DEFAULT_CONFIG.blockSkillCommand;
  const notifyOnFilter = typeof effective.notifyOnFilter === "boolean" ? effective.notifyOnFilter : DEFAULT_CONFIG.notifyOnFilter;

  return {
    enabled,
    mode,
    allow,
    block,
    blockReadTool,
    blockSkillCommand,
    notifyOnFilter,
  };
}

// ==========================================
// 会话级统一状态机 (Unified SSOT) 与串行并发锁
// ==========================================

export interface SessionSkillState {
  /** 启用/停用覆盖 */
  enabledOverride?: boolean;
  /** 模式覆盖 */
  modeOverride?: "allowlist" | "blocklist";
  /** 动态追加的白名单规则集合 */
  extraAllow: Set<string>;
  /** 动态追加的黑名单规则集合（被禁用的技能） */
  extraBlock: Set<string>;
  /** 当前会话中已被实际读取/调用的 Skill 集合（小写） */
  invokedSkills: Set<string>;
  /** 会话中动态新挂载的技能声明集合 (skillName -> { description, location }) */
  mountedSkills: Map<string, { description: string; location: string }>;
  /** 标记会话是否已完成首轮交互（INV-1 不可变前缀保护） */
  hasStarted?: boolean;
}

// 保持向后兼容类型别名
export type RuntimeDelta = SessionSkillState;

const sessionStates = new Map<string, SessionSkillState>();
const sessionLocks = new Map<string, Promise<void>>();
const knownSkills = new Set<string>();

export function updateKnownSkills(skills: Array<{ name: string; baseDir?: string; filePath?: string }>): void {
  for (const s of skills) {
    if (s?.name) knownSkills.add(s.name.trim().toLowerCase());
  }
}

export function resolveSessionId(ctx?: ExtensionContext | any): string | null {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim().length > 0) {
      return id.trim();
    }
  } catch {
    // 忽略异常
  }
  return null;
}

export function getSessionSkillState(sessionId: string): SessionSkillState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      extraAllow: new Set(),
      extraBlock: new Set(),
      invokedSkills: new Set(),
      mountedSkills: new Map(),
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

export function clearSessionSkillState(sessionId: string): void {
  sessionStates.delete(sessionId);
}

export function clearSessionDelta(sessionId: string): void {
  clearSessionSkillState(sessionId);
}

export function clearAllSessionDeltas(): void {
  sessionStates.clear();
}

/**
 * 获取会话互斥串行锁
 */
export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = sessionLocks.get(sessionId) || Promise.resolve();
  let release: () => void;
  const newLock = new Promise<void>((r) => { release = r; });
  sessionLocks.set(sessionId, currentLock.then(() => newLock));

  await currentLock;
  try {
    return await fn();
  } finally {
    release!();
  }
}

/**
 * 叠加计算指定会话的生效配置
 */
export function getEffectiveConfig(baseConfig: Required<SkillGuardConfig>, sessionId: string | null): {
  config: Required<SkillGuardConfig>;
  isOverridden: boolean;
  extraAllow: string[];
  extraBlock: string[];
} {
  if (!sessionId) {
    return { config: baseConfig, isOverridden: false, extraAllow: [], extraBlock: [] };
  }

  const state = sessionStates.get(sessionId);
  if (!state) {
    return { config: baseConfig, isOverridden: false, extraAllow: [], extraBlock: [] };
  }

  const enabled = state.enabledOverride !== undefined ? state.enabledOverride : baseConfig.enabled;
  const mode = state.modeOverride !== undefined ? state.modeOverride : baseConfig.mode;

  const allow = Array.from(new Set([...baseConfig.allow, ...state.extraAllow]));
  const block = Array.from(new Set([...baseConfig.block, ...state.extraBlock]));

  const isOverridden =
    enabled !== baseConfig.enabled ||
    mode !== baseConfig.mode ||
    state.extraAllow.size > 0 ||
    state.extraBlock.size > 0;

  return {
    config: {
      ...baseConfig,
      enabled,
      mode,
      allow,
      block,
    },
    isOverridden,
    extraAllow: Array.from(state.extraAllow),
    extraBlock: Array.from(state.extraBlock),
  };
}

export type GuardAction =
  | { type: "enable" }
  | { type: "disable" }
  | { type: "mode"; mode: "allowlist" | "blocklist" }
  | { type: "allow"; pattern: string }
  | { type: "block"; pattern: string }
  | { type: "unallow"; pattern: string }
  | { type: "unblock"; pattern: string }
  | { type: "reset" };

export interface RelaxationReport {
  relaxing: boolean;
  signature: string; // 结构化特征签名
  reason: string;
}

/**
 * 结构化判断操作是否导致放行集合扩大（放权）
 */
export function isStructurallyRelaxing(
  cur: Required<SkillGuardConfig>,
  next: Required<SkillGuardConfig>
): RelaxationReport {
  // 1. 守卫由启用变停用
  if (cur.enabled && !next.enabled) {
    return { relaxing: true, signature: "disable_guard", reason: "停用守卫将完全开放所有技能" };
  }

  // 2. 模式由白名单变为黑名单
  if (cur.mode === "allowlist" && next.mode === "blocklist") {
    return { relaxing: true, signature: "mode_to_blocklist", reason: "切换为黑名单模式将放开所有非显式封禁技能" };
  }

  // 3. 黑名单规则集合缩小（解封某些技能）
  const removedBlocks = cur.block.filter((b) => !next.block.includes(b)).sort();
  if (removedBlocks.length > 0) {
    return {
      relaxing: true,
      signature: `remove_blocks:${removedBlocks.join(",")}`,
      reason: `移除了黑名单封禁规则: [${removedBlocks.join(", ")}]`,
    };
  }

  // 4. 白名单模式下的规则放宽
  if (next.mode === "allowlist" && next.enabled) {
    // 4a. 原白名单有约束，新白名单变空（退化为全放行）
    if (cur.allow.length > 0 && next.allow.length === 0) {
      return { relaxing: true, signature: "clear_allow_rules", reason: "清空白名单规则将导致系统退化为全放行" };
    }
    // 4b. 白名单范围扩大
    const addedAllows = next.allow.filter((a) => !cur.allow.includes(a)).sort();
    if (cur.allow.length > 0 && addedAllows.length > 0) {
      return {
        relaxing: true,
        signature: `add_allows:${addedAllows.join(",")}`,
        reason: `新增了白名单放行规则: [${addedAllows.join(", ")}]`,
      };
    }
  }

  // 5. 辅助检测：已发现的具体技能是否有被放行
  for (const skill of knownSkills) {
    if (!isSkillAllowed(skill, cur) && isSkillAllowed(skill, next)) {
      return {
        relaxing: true,
        signature: `release_skill:${skill}`,
        reason: `放行了此前被阻断的具体技能: "${skill}"`,
      };
    }
  }

  return { relaxing: false, signature: "none", reason: "" };
}

function calculateNextConfig(
  base: Required<SkillGuardConfig>,
  currentState: SessionSkillState | undefined,
  action: GuardAction
): { nextState: SessionSkillState | null; nextConfig: Required<SkillGuardConfig> } {
  if (action.type === "reset") {
    return { nextState: null, nextConfig: base };
  }

  const nextState: SessionSkillState = currentState
    ? {
        enabledOverride: currentState.enabledOverride,
        modeOverride: currentState.modeOverride,
        extraAllow: new Set(currentState.extraAllow),
        extraBlock: new Set(currentState.extraBlock),
        invokedSkills: new Set(currentState.invokedSkills),
        mountedSkills: new Map(currentState.mountedSkills),
        hasStarted: currentState.hasStarted,
      }
    : {
        extraAllow: new Set(),
        extraBlock: new Set(),
        invokedSkills: new Set(),
        mountedSkills: new Map(),
      };

  switch (action.type) {
    case "enable": nextState.enabledOverride = true; break;
    case "disable": nextState.enabledOverride = false; break;
    case "mode": nextState.modeOverride = action.mode; break;
    case "allow": nextState.extraAllow.add(action.pattern); break;
    case "block": nextState.extraBlock.add(action.pattern); break;
    case "unallow": nextState.extraAllow.delete(action.pattern); break;
    case "unblock": nextState.extraBlock.delete(action.pattern); break;
  }

  const enabled = nextState.enabledOverride !== undefined ? nextState.enabledOverride : base.enabled;
  const mode = nextState.modeOverride !== undefined ? nextState.modeOverride : base.mode;
  const allow = Array.from(new Set([...base.allow, ...nextState.extraAllow]));
  const block = Array.from(new Set([...base.block, ...nextState.extraBlock]));

  return { nextState, nextConfig: { ...base, enabled, mode, allow, block } };
}

/**
 * 统一动作执行网关（CLI 与菜单统一入口）
 */
export async function applyAction(
  rawAction: GuardAction,
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<boolean> {
  const sessionId = resolveSessionId(ctx);
  if (!sessionId) {
    const msg = "🛡️ [skill-guard] 无法识别当前会话 ID，禁止执行会话级覆盖操作（Fail-Closed）。";
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return false;
  }

  // 1. 不原地修改传入对象，深拷贝并规范化
  const action: GuardAction = { ...rawAction };
  if ("pattern" in action) {
    const trimmed = action.pattern.trim().toLowerCase();
    if (trimmed.length === 0) {
      const msg = "🛡️ [skill-guard] 规则模式不能为空。";
      if (ctx.hasUI) ctx.ui.notify(msg, "error");
      else console.error(msg);
      return false;
    }
    action.pattern = trimmed;
  }

  // 2. 加串行锁执行操作，消除并发竞态
  return await withSessionLock(sessionId, async () => {
    const base = resolveConfig(pi);
    const state = sessionStates.get(sessionId);
    const current = getEffectiveConfig(base, sessionId);

    // 2a. 前置 UX 冲突检查
    if (action.type === "allow") {
      if (matchesAnyPattern(action.pattern, base.block) || (state && matchesAnyPattern(action.pattern, Array.from(state.extraBlock)))) {
        const msg = `🛡️ [skill-guard] 拒绝放行：模式 "${action.pattern}" 命中了黑名单封禁规则。依据 Deny-First 铁律，临时 allow 不能推翻 block。`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
        return false;
      }
    }

    if (action.type === "unblock") {
      if (!state || !state.extraBlock.has(action.pattern)) {
        if (matchesAnyPattern(action.pattern, base.block)) {
          const msg = `🛡️ [skill-guard] 无法解除："${action.pattern}" 属于基线配置规则，会话中无法移除。`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else console.error(msg);
          return false;
        }
        const msg = `未找到名为 "${action.pattern}" 的临时封禁规则。`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        return false;
      }
    }

    // 2b. 结构化放权判定
    const initialComputed = calculateNextConfig(base, state, action);
    const check = isStructurallyRelaxing(current.config, initialComputed.nextConfig);

    if (check.relaxing) {
      if (!ctx.hasUI) {
        console.error(`[skill-guard] 拒绝执行：该操作判定为放权行为 (${check.reason})，在无交互界面模式下禁止放权（Fail-Closed）。`);
        return false;
      }
      const confirmed = await ctx.ui.confirm(
        "确认放宽技能安全权限？",
        `此操作将扩大技能访问范围: ${check.reason}，仅在当前会话有效。`
      );
      if (!confirmed) {
        ctx.ui.notify("操作已取消。", "info");
        return false;
      }

      // 2c. 弹窗返回后重新核算（防止弹窗期间 settings 或外部状态发生变迁）
      const recheckedBase = resolveConfig(pi);
      const recheckedState = sessionStates.get(sessionId);
      const recheckedCurrent = getEffectiveConfig(recheckedBase, sessionId);
      const recomputed = calculateNextConfig(recheckedBase, recheckedState, action);
      const recheck = isStructurallyRelaxing(recheckedCurrent.config, recomputed.nextConfig);

      // 比对结构化签名是否发生漂移
      if (recheck.relaxing && recheck.signature !== check.signature) {
        ctx.ui.notify("会话配置在此期间发生并发变动，为保证安全已取消执行，请重新操作。", "warning");
        return false;
      }

      // 原子落地：使用最新核算出的 recomputed.nextState
      if (action.type === "reset") {
        clearSessionSkillState(sessionId);
      } else if (recomputed.nextState) {
        sessionStates.set(sessionId, recomputed.nextState);
      }
    } else {
      // 非放权操作直接落地
      if (action.type === "reset") {
        clearSessionSkillState(sessionId);
      } else if (initialComputed.nextState) {
        sessionStates.set(sessionId, initialComputed.nextState);
      }
    }

    if (ctx.hasUI) {
      ctx.ui.notify("Skill-guard 规则已更新（工具阻断即时生效，Prompt 下轮更新）。", "info");
    }
    return true;
  });
}

// ==========================================
// 尾部约束协议标准与确定性渲染 (INV-4 & INV-6)
// ==========================================

export const CONSTRAINT_TAG_START = "<active_skill_constraints>";
export const CONSTRAINT_TAG_END = "</active_skill_constraints>";

/**
 * 剥离文本中既有的约束标记，实现 Agentic Loop 幂等性
 */
export function stripExistingConstraints(text: string): string {
  if (!text.includes(CONSTRAINT_TAG_START)) return text;
  const regex = new RegExp(`${escapeRegex(CONSTRAINT_TAG_START)}[\\s\\S]*?${escapeRegex(CONSTRAINT_TAG_END)}`, "g");
  return text.replace(regex, "").trimEnd();
}

/**
 * 严格遵循 SPEC 3.2 渲染尾部约束 XML
 * 对受限 Skill 和新挂载 Skill 强制执行字母升序排序，确保确定性与保护 KV Cache
 */
export function renderActiveConstraintsXml(state: SessionSkillState): string | null {
  const hasBlocked = state.extraBlock && state.extraBlock.size > 0;
  const hasMounted = state.mountedSkills && state.mountedSkills.size > 0;

  if (!hasBlocked && !hasMounted) {
    return null;
  }

  const sections: string[] = [];
  let sectionIndex = 1;

  if (hasBlocked) {
    const blockedList = Array.from(state.extraBlock).sort((a, b) => a.localeCompare(b));
    const items = blockedList.map(
      (skill) =>
        `- skill: "${skill}"\n  - reason: "Temporarily disabled by session security policy."\n  - fallback: "Use native tools (read/bash/edit) or alternative approved methods instead."`
    );
    sections.push(
      `${sectionIndex++}. RESTRICTED SKILLS (DO NOT INVOKE):\nThe following skill(s) are strictly restricted starting from this turn. Even though they may exist in prior context or your previous thinking/steps, you MUST CEASE all references, reads, and executions of them:\n${items.join("\n")}`
    );
  }

  if (hasMounted) {
    const mountedList = Array.from(state.mountedSkills.entries()).sort(([a], [b]) => a.localeCompare(b));
    const items = mountedList.map(
      ([skill, info]) =>
        `- skill: "${skill}"\n  - location: "${info.location}"\n  - instruction: "You may now read its SKILL.md and utilize its utilities as needed."`
    );
    sections.push(
      `${sectionIndex++}. NEWLY MOUNTED SKILLS (AVAILABLE NOW):\nThe following skill(s) have been freshly provisioned for subsequent tasks:\n${items.join("\n")}`
    );
  }

  sections.push(
    `${sectionIndex++}. PRECEDENCE RULE:\nThe rules in this block take absolute precedence over earlier system declarations and previous thinking chains.`
  );

  return `${CONSTRAINT_TAG_START}\n[CRITICAL OPERATIONAL UPDATE - EFFECTIVE IMMEDIATELY]\n\n${sections.join("\n\n")}\n${CONSTRAINT_TAG_END}`;
}

/**
 * 格式化带有建设性指引的拦截文案 (INV-5)
 */
export function formatBlockGuidance(targetSkill: string): string {
  return `[Skill Guard Blocked]: Access to skill "${targetSkill}" is restricted in the current session. Operational guidance: Please adhere to <active_skill_constraints> and proceed using native tools (read/bash/edit) or alternative approved approaches without invoking this skill.`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 对 bash 命令行进行轻量反混淆展开 (Hex / ANSI-C quoting 转义处理)
 */
function normalizeBashCommand(command: string): string {
  let normalized = command;
  // 展开 \xHH 形式的十六进制字符
  if (normalized.includes("\\x")) {
    normalized = normalized.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
  // 展开 $'...' 形式的 ANSI-C 字符串引号
  if (normalized.includes("$'")) {
    normalized = normalized.replace(/\$'([^']+)'/g, "$1");
  }
  return normalized;
}

/**
 * 扫描 bash 命令行是否涉及被限制的 Skill (INV-5 深度防御)
 */
export function matchBlockedSkillInBashCommand(
  command: string,
  config: Required<SkillGuardConfig>,
  cwd?: string
): string | null {
  if (!command || typeof command !== "string") return null;

  const normalizedCmd = normalizeBashCommand(command);

  // 收集当前被限制的所有候选技能集合
  const candidateSkills = new Set<string>();
  for (const b of config.block) {
    if (b && !b.includes("*") && !b.includes("?")) {
      candidateSkills.add(b.toLowerCase());
    }
  }
  for (const s of knownSkills) {
    if (!isSkillAllowed(s, config)) {
      candidateSkills.add(s.toLowerCase());
    }
  }
  for (const s of dynamicSkillDirPrefixes.values()) {
    if (!isSkillAllowed(s, config)) {
      candidateSkills.add(s.toLowerCase());
    }
  }
  for (const s of skillPathMap.values()) {
    if (!isSkillAllowed(s, config)) {
      candidateSkills.add(s.toLowerCase());
    }
  }

  if (candidateSkills.size === 0) {
    // 处理通配符规则，例如 block: ["*"]
    for (const [pathKey, s] of skillPathMap.entries()) {
      if (!isSkillAllowed(s, config) && (normalizedCmd.includes(pathKey) || command.includes(pathKey))) {
        return s;
      }
    }
    return null;
  }

  for (const targetSkill of candidateSkills) {
    // 1. 检查已注册的真实物理路径或文件
    for (const [pathKey, skillName] of skillPathMap.entries()) {
      if (skillName === targetSkill && (normalizedCmd.includes(pathKey) || command.includes(pathKey))) {
        return targetSkill;
      }
    }

    // 2. 检查已注册目录前缀
    for (const [prefix, skillName] of dynamicSkillDirPrefixes.entries()) {
      if (skillName === targetSkill) {
        const withoutSlash = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
        if (normalizedCmd.includes(prefix) || normalizedCmd.includes(withoutSlash) || command.includes(prefix) || command.includes(withoutSlash)) {
          return targetSkill;
        }
      }
    }

    // 3. 检查全局标准技能根特征
    for (const root of KNOWN_SKILL_ROOT_PATTERNS) {
      if (normalizedCmd.includes(`${root}${targetSkill}`) || command.includes(`${root}${targetSkill}`)) {
        return targetSkill;
      }
    }

    // 4. 检查工作区或相对技能路径模式，如 skills/targetSkill
    const skillPathRegex = new RegExp(`(?:^|[\\s"'=\`/])skills\\/${escapeRegex(targetSkill)}(?:[/\\s"'=\`;]|$)`, "i");
    if (skillPathRegex.test(normalizedCmd) || skillPathRegex.test(command)) {
      return targetSkill;
    }

    // 5. 检查针对该 skill 目录下的特征脚本或描述文件引用
    const scriptRegex = new RegExp(`(?:^|[\\s"'=\`/])${escapeRegex(targetSkill)}\\/(?:SKILL\\.md|run\\.(?:sh|py|js|ts)|scripts?\\/|[a-zA-Z0-9_.-]+\\.(?:py|sh|js|ts|rb|bash))`, "i");
    if (scriptRegex.test(normalizedCmd) || scriptRegex.test(command)) {
      return targetSkill;
    }
  }

  return null;
}

/**
 * 处理 /skill-guard 命令
 */
export async function handleSkillGuardCommand(
  args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  const trimmed = args.trim();
  const sessionId = resolveSessionId(ctx);
  const base = resolveConfig(pi);
  const { config, isOverridden, extraAllow, extraBlock } = getEffectiveConfig(base, sessionId);

  // 1. 无参数且有 UI：呼出动态交互菜单
  if (!trimmed && ctx.hasUI) {
    const statusLabel = config.enabled ? "已启用" : "已停用";
    const modeLabel = config.mode.toUpperCase();
    const overrideLabel = isOverridden ? " (包含临时覆盖)" : "";

    const toggleEnableOpt = config.enabled ? "🔘 停用守卫 (当前: 已启用)" : "🛡️ 启用守卫 (当前: 已停用)";
    const toggleModeOpt = config.mode === "allowlist" ? "🔄 切换为黑名单模式 (当前: ALLOWLIST)" : "🔄 切换为白名单模式 (当前: BLOCKLIST)";

    const options = [
      toggleEnableOpt,
      toggleModeOpt,
      "➕ 添加允许规则 (allow)",
      "🚫 添加封禁规则 (block)",
      "📋 查看完整生效规则与状态报告",
    ];

    if (extraAllow.length > 0) {
      options.push("➖ 撤销临时允许规则 (unallow)");
    }
    if (extraBlock.length > 0) {
      options.push("🔓 解除临时封禁规则 (unblock)");
    }
    if (isOverridden) {
      options.push("♻️ 重置本会话所有临时覆盖 (reset)");
    }

    const choice = await ctx.ui.select(`Skill Guard 管理 [${statusLabel} | ${modeLabel}${overrideLabel}]`, options);
    if (!choice) return;

    if (choice === toggleEnableOpt) {
      await applyAction(config.enabled ? { type: "disable" } : { type: "enable" }, ctx, pi);
    } else if (choice === toggleModeOpt) {
      await applyAction({ type: "mode", mode: config.mode === "allowlist" ? "blocklist" : "allowlist" }, ctx, pi);
    } else if (choice === "➕ 添加允许规则 (allow)") {
      const pattern = await ctx.ui.input("输入要放行的技能名称或通配符 (例如: my-skill 或 *-tool)");
      if (pattern) {
        await applyAction({ type: "allow", pattern }, ctx, pi);
      }
    } else if (choice === "🚫 添加封禁规则 (block)") {
      const pattern = await ctx.ui.input("输入要封禁的技能名称或通配符 (例如: danger-* 或 eval)");
      if (pattern) {
        await applyAction({ type: "block", pattern }, ctx, pi);
      }
    } else if (choice === "➖ 撤销临时允许规则 (unallow)") {
      const target = await ctx.ui.select("选择要撤销的临时允许规则", extraAllow);
      if (target) {
        await applyAction({ type: "unallow", pattern: target }, ctx, pi);
      }
    } else if (choice === "🔓 解除临时封禁规则 (unblock)") {
      const target = await ctx.ui.select("选择要解除的临时封禁规则", extraBlock);
      if (target) {
        await applyAction({ type: "unblock", pattern: target }, ctx, pi);
      }
    } else if (choice === "♻️ 重置本会话所有临时覆盖 (reset)") {
      await applyAction({ type: "reset" }, ctx, pi);
    } else if (choice === "📋 查看完整生效规则与状态报告") {
      printStatusReport(config, isOverridden, extraAllow, extraBlock, ctx);
    }
    return;
  }

  // 2. 命令行快捷指令分发
  const parts = trimmed.split(/\s+/);
  const subCmd = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1).join(" ");

  switch (subCmd) {
    case "":
    case "status": {
      printStatusReport(config, isOverridden, extraAllow, extraBlock, ctx);
      break;
    }
    case "enable": {
      await applyAction({ type: "enable" }, ctx, pi);
      break;
    }
    case "disable": {
      await applyAction({ type: "disable" }, ctx, pi);
      break;
    }
    case "mode": {
      const targetMode = rest.toLowerCase();
      if (targetMode === "allowlist" || targetMode === "blocklist") {
        await applyAction({ type: "mode", mode: targetMode }, ctx, pi);
      } else {
        const msg = "用法错误: /skill-guard mode <allowlist|blocklist>";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.warn(msg);
      }
      break;
    }
    case "allow": {
      if (!rest) {
        const msg = "用法错误: /skill-guard allow <pattern>";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.warn(msg);
      } else {
        await applyAction({ type: "allow", pattern: rest }, ctx, pi);
      }
      break;
    }
    case "block": {
      if (!rest) {
        const msg = "用法错误: /skill-guard block <pattern>";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.warn(msg);
      } else {
        await applyAction({ type: "block", pattern: rest }, ctx, pi);
      }
      break;
    }
    case "unallow": {
      if (!rest) {
        const msg = "用法错误: /skill-guard unallow <pattern>";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.warn(msg);
      } else {
        await applyAction({ type: "unallow", pattern: rest }, ctx, pi);
      }
      break;
    }
    case "unblock": {
      if (!rest) {
        const msg = "用法错误: /skill-guard unblock <pattern>";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.warn(msg);
      } else {
        await applyAction({ type: "unblock", pattern: rest }, ctx, pi);
      }
      break;
    }
    case "reset": {
      await applyAction({ type: "reset" }, ctx, pi);
      break;
    }
    default: {
      const msg = `未知子命令: "${subCmd}"。\n可用指令: status, enable, disable, mode <allowlist|blocklist>, allow <p>, block <p>, unallow <p>, unblock <p>, reset`;
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      else console.warn(msg);
      break;
    }
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
  const overrideTag = isOverridden ? " ⚠️ (包含本会话临时内存覆盖)" : "";

  const allowLines = config.allow.length > 0
    ? config.allow.map((r) => `  - ✅ ${r}${extraAllow.includes(r) ? " (临时)" : ""}`).join("\n")
    : "  (未设置允许规则，全部放行)";

  const blockLines = config.block.length > 0
    ? config.block.map((r) => `  - 🚫 ${r}${extraBlock.includes(r) ? " (临时)" : ""}`).join("\n")
    : "  (未设置黑名单规则)";

  const details = [
    `${statusIcon} pi-skill-guard 状态报告${overrideTag}`,
    `工作模式: ${config.mode.toUpperCase()}`,
    `工具阻断: ${config.blockReadTool ? "启用" : "停用"} | 命令阻断: ${config.blockSkillCommand ? "启用" : "停用"}`,
    `白名单规则 (Allow):\n${allowLines}`,
    `黑名单规则 (Block - Deny-First):\n${blockLines}`,
  ].join("\n");

  if (ctx.hasUI) {
    ctx.ui.notify(details, "info");
  } else {
    console.log(details);
  }
}

// ==========================================
// 扩展主体挂载
// ==========================================

export default function skillGuard(pi: ExtensionAPI): void {
  // 1. 生命周期管理：会话切换或关闭时处理临时覆盖
  pi.on("session_start", (_event, ctx) => {
    checkLegacyConfigWarning(ctx);
    const sessionId = resolveSessionId(ctx);
    if (sessionId) {
      clearSessionSkillState(sessionId);
    }
  });

  pi.on("session_shutdown", () => {
    clearAllSessionDeltas();
  });

  // 2. Prompt 技能列表过滤（INV-1: 开局静态基线，会话中途前缀绝对不可变）
  pi.on("before_agent_start", (event, ctx) => {
    if (event.systemPromptOptions?.skills) {
      updateKnownSkills(event.systemPromptOptions.skills);
      registerSkillLocations(event.systemPromptOptions.skills);
    }

    const sessionId = resolveSessionId(ctx);
    const sessionState = sessionId ? sessionStates.get(sessionId) : undefined;

    // INV-1 核心保证：
    // 只要会话已发生过首轮交互，严禁在多轮对话中途物理修改第 0 轮 System Prompt。
    // 避免回溯修改破坏 KV Cache 和时序因果。中途变更完全通过尾部约束与工具网关生效。
    if (sessionState?.hasStarted) {
      return;
    }

    const base = resolveConfig(pi);
    const { config } = getEffectiveConfig(base, sessionId);
    if (!config.enabled) return;

    if (event.systemPromptOptions?.skills) {
      const originalCount = event.systemPromptOptions.skills.length;
      const filtered = event.systemPromptOptions.skills.filter((skill) =>
        isSkillAllowed(skill.name, config)
      );

      // 原地修改（In-Place mutation），确保不论引用方式均 100% 真实生效
      event.systemPromptOptions.skills.length = 0;
      event.systemPromptOptions.skills.push(...filtered);

      const filteredCount = originalCount - event.systemPromptOptions.skills.length;
      if (config.notifyOnFilter && filteredCount > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `🛡️ [skill-guard] 已过滤 ${filteredCount} 个非授权 Skill，当前生效 ${event.systemPromptOptions.skills.length} 个。`,
          "info"
        );
      }
    }
  });

  // 3. 内存投影注入引擎（INV-2, INV-3, INV-4, INV-6）
  pi.on("context", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (!sessionId) return undefined;

    const sessionState = getSessionSkillState(sessionId);
    // 标记当前会话已激活交互，固化开局前缀
    sessionState.hasStarted = true;

    const remainderText = renderActiveConstraintsXml(sessionState);

    const messages = [...(event.messages || [])];
    const lastUserIndex = messages.findLastIndex((m) => m && m.role === "user");
    if (lastUserIndex === -1) {
      return undefined;
    }

    const targetMsg = messages[lastUserIndex];
    const clonedTarget = { ...targetMsg };

    if (typeof clonedTarget.content === "string") {
      const cleanContent = stripExistingConstraints(clonedTarget.content);
      clonedTarget.content = remainderText
        ? (cleanContent.length > 0 ? `${cleanContent}\n\n${remainderText}` : remainderText)
        : cleanContent;
    } else if (Array.isArray(clonedTarget.content)) {
      // 过滤与剥离原有的约束 text block，保障 Agentic Tool Loop 幂等性
      const cleanedBlocks = clonedTarget.content
        .map((b) => {
          if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
            const stripped = stripExistingConstraints(b.text);
            return stripped !== b.text ? { ...b, text: stripped } : b;
          }
          return b;
        })
        .filter((b) => {
          if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
            return b.text.trim().length > 0;
          }
          return true;
        });

      if (remainderText) {
        clonedTarget.content = [
          ...cleanedBlocks,
          { type: "text", text: `\n\n${remainderText}` },
        ];
      } else {
        clonedTarget.content = cleanedBlocks;
      }
    }

    messages[lastUserIndex] = clonedTarget;
    return { messages };
  });

  // 4. 工具网关双通道底层拦截（INV-5: read + bash 深度防御）
  pi.on("tool_call", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const base = resolveConfig(pi);
    const { config } = getEffectiveConfig(base, sessionId);
    if (!config.enabled) return;

    const sessionState = sessionId ? getSessionSkillState(sessionId) : undefined;

    // 通道 1: read 工具拦截
    if (config.blockReadTool && event.toolName === "read") {
      const targetPath = (event.input as { path?: string })?.path || "";
      const skillNames = extractSkillNamesFromPath(targetPath, ctx.cwd);
      for (const skillName of skillNames) {
        if (!isSkillAllowed(skillName, config)) {
          return {
            block: true,
            reason: formatBlockGuidance(skillName),
          };
        } else if (sessionState) {
          sessionState.invokedSkills.add(skillName);
        }
      }
    }

    // 通道 2: bash 工具深度防御拦截
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string })?.command || "";
      if (command && typeof command === "string") {
        const blockedSkill = matchBlockedSkillInBashCommand(command, config, ctx.cwd);
        if (blockedSkill) {
          return {
            block: true,
            reason: formatBlockGuidance(blockedSkill),
          };
        }
      }
    }
  });

  // 5. 命令输入拦截（全拦截面 3）
  pi.on("input", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const base = resolveConfig(pi);
    const { config } = getEffectiveConfig(base, sessionId);
    if (!config.enabled || !config.blockSkillCommand) return;

    const trimmed = event.text.trim();
    if (trimmed.startsWith("/skill:")) {
      const spaceIdx = trimmed.indexOf(" ");
      const rawSkill = spaceIdx === -1 ? trimmed.slice(7) : trimmed.slice(7, spaceIdx);
      if (rawSkill && !isSkillAllowed(rawSkill, config)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `🛡️ [skill-guard] 命令已阻断：技能 "${rawSkill}" 在当前项目中未被授权。`,
            "error"
          );
        }
        return { action: "handled" };
      }
    }
  });

  // 6. 注册统一管理命令
  pi.registerCommand("skill-guard", {
    description: "查看与动态管理 Skill Guard 隔离配置及运行时覆盖",
    handler: (args, ctx) => handleSkillGuardCommand(args, ctx, pi),
  });
}
