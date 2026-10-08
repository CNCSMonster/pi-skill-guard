import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let buildSystemPrompt: any;
try {
  const mod = await import("@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
  buildSystemPrompt = mod.buildSystemPrompt;
} catch {
  const mod = await import("/home/ccm/.local/share/mise/installs/node/24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
  buildSystemPrompt = mod.buildSystemPrompt;
}
import skillGuard, {
  resolveConfig,
  extractSkillNamesFromPath,
  registerSkillLocations,
  resetRegisteredSkillLocations,
  isStructurallyRelaxing,
  applyAction,
  withSessionLock,
  getEffectiveConfig,
  clearSessionDelta,
  clearSessionSkillState,
  getSessionSkillState,
  renderActiveConstraintsXml,
  stripExistingConstraints,
  formatBlockGuidance,
  matchBlockedSkillInBashCommand,
  skillPathMap,
  CONSTRAINT_TAG_START,
  CONSTRAINT_TAG_END,
  type SessionSkillState,
} from "../extensions/skill-guard.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Mock Pi ExtensionAPI
function createMockPi(mockSettings: Record<string, unknown> = {}) {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const commands: Record<string, any> = {};

  const mockPi: Partial<ExtensionAPI> = {
    on(event: string, handler: any) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
      return () => {};
    },
    registerCommand(name: string, options: any) {
      commands[name] = options;
    },
    getSettings() {
      return mockSettings as any;
    },
  };

  return {
    pi: mockPi as ExtensionAPI,
    handlers,
    commands,
  };
}

// Mock ExtensionContext
function createMockContext(options: {
  sessionId?: string;
  hasUI?: boolean;
  cwd?: string;
  confirmResult?: boolean;
} = {}) {
  const notifications: Array<{ msg: string; type?: string }> = [];
  const statusCalls: Array<{ key: string; text?: string }> = [];
  const sessionId = options.sessionId ?? "test-session-123";
  const cwd = options.cwd ?? "/workspace";

  const ctx: Partial<ExtensionContext> = {
    hasUI: options.hasUI ?? false,
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    } as any,
    ui: {
      notify: (msg: string, type?: string) => {
        notifications.push({ msg, type });
      },
      setStatus: (key: string, text?: string) => {
        statusCalls.push({ key, text });
      },
      confirm: async () => options.confirmResult ?? true,
      select: async () => undefined,
      input: async () => undefined,
    } as any,
  };

  return {
    ctx: ctx as ExtensionContext,
    notifications,
    statusCalls,
  };
}

test("resolveConfig reads config correctly and performs deep clone", () => {
  const mock = createMockPi({
    skillGuard: {
      mode: "allowlist",
      allow: ["ccm-*"],
    },
  });
  const config = resolveConfig(mock.pi);
  assert.equal(config.mode, "allowlist");
  assert.deepEqual(config.allow, ["ccm-*"]);
  assert.equal(config.blockReadTool, true);

  // 保证深拷贝，下游修改不污染
  config.allow.push("malicious");
  const config2 = resolveConfig(mock.pi);
  assert.deepEqual(config2.allow, ["ccm-*"]);
});

test("resolveConfig对称 Fail-Closed 校验与脏数据过滤", () => {
  // 1. 全部非法规则 -> 注入 Fail-Closed 哨兵
  const mock1 = createMockPi({
    skillGuard: {
      allow: [123 as any, null as any],
      block: [false as any],
    },
  });
  const c1 = resolveConfig(mock1.pi);
  assert.deepEqual(c1.allow, ["\0__invalid_config_block_all__"]);
  assert.deepEqual(c1.block, ["*"]);

  // 2. 非法 mode 安全回退并告警
  const mock2 = createMockPi({
    skillGuard: {
      mode: "blacklist" as any,
    },
  });
  const c2 = resolveConfig(mock2.pi);
  assert.equal(c2.mode, "allowlist");
});

test("extractSkillNamesFromPath handles static directories and Pi real paths", () => {
  // Pi 全局 agent 技能目录
  const names1 = extractSkillNamesFromPath("/home/user/.pi/agent/skills/tavily-search/SKILL.md");
  assert.deepEqual(names1, ["tavily-search"]);

  // 标准 .agents 隐藏目录
  const names2 = extractSkillNamesFromPath("/home/user/.agents/skills/ccm-audit/sub/doc.md");
  assert.deepEqual(names2, ["ccm-audit"]);

  // 工作区项目内部 ./skills/ 目录
  const names3 = extractSkillNamesFromPath("/workspace/skills/local-tool/SKILL.md", "/workspace");
  assert.deepEqual(names3, ["local-tool"]);

  // 非技能目录返回空
  const names4 = extractSkillNamesFromPath("/workspace/src/app.ts", "/workspace");
  assert.deepEqual(names4, []);
});

test("必改 A 落地：动态注册外部技能并支持目录直读（read <dir>）", () => {
  resetRegisteredSkillLocations();

  registerSkillLocations([
    {
      name: "custom-opt-skill",
      baseDir: "/opt/external/skills/custom-opt-skill",
      filePath: "/opt/external/skills/custom-opt-skill/SKILL.md",
    },
  ]);

  // 1. 读取目录内文件
  const r1 = extractSkillNamesFromPath("/opt/external/skills/custom-opt-skill/tools/run.py");
  assert.ok(r1.includes("custom-opt-skill"));

  // 2. 必改 A：直接读取目录本身（带或不带尾斜杠）
  const r2 = extractSkillNamesFromPath("/opt/external/skills/custom-opt-skill");
  assert.ok(r2.includes("custom-opt-skill"));

  const r3 = extractSkillNamesFromPath("/opt/external/skills/custom-opt-skill/");
  assert.ok(r3.includes("custom-opt-skill"));
});

test("软链接双路提取：防指入与指出逃逸", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-skill-guard-symlink-"));
  try {
    const realSkillDir = join(tempDir, "real-skill");
    mkdirSync(realSkillDir, { recursive: true });
    writeFileSync(join(realSkillDir, "SKILL.md"), "# Secret");

    const linkDir = join(tempDir, ".pi", "agent", "skills", "symlink-skill");
    mkdirSync(join(tempDir, ".pi", "agent", "skills"), { recursive: true });
    symlinkSync(realSkillDir, linkDir);

    // 通过软链接路径读取，物理路径指向 realSkillDir
    // 逻辑路径含 /.pi/agent/skills/，双路比对必须成功提取出 symlink-skill
    const names = extractSkillNamesFromPath(join(linkDir, "SKILL.md"), tempDir);
    assert.ok(names.includes("symlink-skill"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("必改 B 落地：before_agent_start 原地修改并过滤 skills 数组", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["allowed-skill"],
    },
  });
  skillGuard(mock.pi);

  const skillsArray = [
    { name: "allowed-skill", description: "Good", filePath: "/path/1" },
    { name: "blocked-skill", description: "Bad", filePath: "/path/2" },
  ];

  const event = {
    type: "before_agent_start" as const,
    prompt: "hello",
    systemPrompt: "",
    systemPromptOptions: {
      cwd: "/repo",
      selectedTools: ["read"],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills: skillsArray,
    },
  };

  const { ctx } = createMockContext();
  await mock.handlers["before_agent_start"][0](event, ctx);

  // 原地修改保证：引用不变，内容已被物理裁剪
  assert.equal(event.systemPromptOptions.skills, skillsArray);
  assert.equal(skillsArray.length, 1);
  assert.equal(skillsArray[0].name, "allowed-skill");
});

test("端到端门禁：过滤后技能绝不出现在 Pi 最终渲染的 System Prompt 字符串中", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["allowed-skill"],
    },
  });
  skillGuard(mock.pi);

  const skills = [
    { name: "allowed-skill", description: "Safe operations", filePath: "/path/allowed" },
    { name: "blocked-danger-skill", description: "Dangerous exploits", filePath: "/path/danger" },
  ];

  const event = {
    type: "before_agent_start" as const,
    prompt: "run something",
    systemPrompt: "",
    systemPromptOptions: {
      cwd: "/repo",
      selectedTools: ["read"],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills,
    },
  };

  const { ctx } = createMockContext();
  await mock.handlers["before_agent_start"][0](event, ctx);

  // 用 Pi 官方 buildSystemPrompt 真实渲染系统提示词
  const renderedPrompt = buildSystemPrompt(event.systemPromptOptions as any);

  // 断言：被允许的技能必须在 Prompt 中，被封禁的技能绝对不可存在
  assert.match(renderedPrompt, /allowed-skill/);
  assert.doesNotMatch(renderedPrompt, /blocked-danger-skill/);
});

test("tool_call blocks read calls to unallowed skill directories", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["allowed-skill"],
      blockReadTool: true,
    },
  });
  skillGuard(mock.pi);

  const hook = mock.handlers["tool_call"][0];
  const { ctx } = createMockContext();

  // Blocked read
  const blockedResult = await hook(
    {
      type: "tool_call",
      toolName: "read",
      toolCallId: "call_1",
      input: { path: "/home/user/.agents/skills/forbidden-skill/SKILL.md" },
    },
    ctx
  );
  assert.equal(blockedResult?.block, true);
  assert.match(blockedResult?.reason, /\[Skill Guard Blocked\]: Access to skill "forbidden-skill"/);
  assert.match(blockedResult?.reason, /Operational guidance:/);

  // Allowed read
  const allowedResult = await hook(
    {
      type: "tool_call",
      toolName: "read",
      toolCallId: "call_2",
      input: { path: "/home/user/.agents/skills/allowed-skill/SKILL.md" },
    },
    ctx
  );
  assert.equal(allowedResult, undefined);
});

test("input blocks forbidden /skill:xxx commands", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["allowed-skill"],
      blockSkillCommand: true,
    },
  });
  skillGuard(mock.pi);

  const hook = mock.handlers["input"][0];
  const { ctx, notifications } = createMockContext({ hasUI: true });

  const handled = await hook({ text: "/skill:forbidden-skill arg" }, ctx);
  assert.deepEqual(handled, { action: "handled" });
  assert.ok(notifications.some((n) => n.msg.includes("forbidden-skill") && n.type === "error"));

  const passed = await hook({ text: "/skill:allowed-skill arg" }, ctx);
  assert.equal(passed, undefined);
});

test("结构化放权判定：isStructurallyRelaxing 覆盖所有放权维度", () => {
  const baseConfig = {
    enabled: true,
    mode: "allowlist" as const,
    allow: ["skill-a"],
    block: ["skill-b"],
    blockReadTool: true,
    blockSkillCommand: true,
    notifyOnFilter: false,
  };

  // 1. 守卫停用 -> 放权
  const r1 = isStructurallyRelaxing(baseConfig, { ...baseConfig, enabled: false });
  assert.equal(r1.relaxing, true);
  assert.equal(r1.signature, "disable_guard");

  // 2. 模式切换为 blocklist -> 放权
  const r2 = isStructurallyRelaxing(baseConfig, { ...baseConfig, mode: "blocklist" });
  assert.equal(r2.relaxing, true);
  assert.equal(r2.signature, "mode_to_blocklist");

  // 3. block 规则集合缩小 -> 放权
  const r3 = isStructurallyRelaxing(baseConfig, { ...baseConfig, block: [] });
  assert.equal(r3.relaxing, true);
  assert.ok(r3.signature.startsWith("remove_blocks:"));

  // 4. allowlist 模式下 allow 清空（退化为全放行） -> 放权
  const r4 = isStructurallyRelaxing(baseConfig, { ...baseConfig, allow: [] });
  assert.equal(r4.relaxing, true);
  assert.equal(r4.signature, "clear_allow_rules");

  // 5. allowlist 模式下新增 allow -> 放权
  const r5 = isStructurallyRelaxing(baseConfig, { ...baseConfig, allow: ["skill-a", "skill-c"] });
  assert.equal(r5.relaxing, true);
  assert.ok(r5.signature.startsWith("add_allows:"));

  // 6. 收紧操作：增加 block 规则 -> 非放权
  const r6 = isStructurallyRelaxing(baseConfig, { ...baseConfig, block: ["skill-b", "skill-c"] });
  assert.equal(r6.relaxing, false);
});

test("applyAction 在 Headless 模式下阻断一切放权操作（Fail-Closed）", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["skill-1"],
      block: [],
    },
  });

  const { ctx } = createMockContext({ hasUI: false, sessionId: "headless-sess" });

  // 试图放权：新增 allow
  const ok = await applyAction({ type: "allow", pattern: "skill-2" }, ctx, mock.pi);
  assert.equal(ok, false); // Headless 下无 UI 无法确认，Fail-Closed 拒绝
});

test("applyAction UX 冲突检查：Deny-First 铁律阻断放行已封禁项", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: [],
      block: ["danger-tool"],
    },
  });

  const { ctx, notifications } = createMockContext({ hasUI: true, sessionId: "conflict-sess" });

  // 试图放行已被基线 block 的项目
  const ok = await applyAction({ type: "allow", pattern: "danger-tool" }, ctx, mock.pi);
  assert.equal(ok, false);
  assert.ok(notifications.some((n) => n.msg.includes("命中了黑名单封禁规则") && n.type === "error"));
});

test("withSessionLock 确保会话操作并发串行执行", async () => {
  const sessionId = "lock-sess";
  const executionOrder: number[] = [];

  const p1 = withSessionLock(sessionId, async () => {
    await new Promise((r) => setTimeout(r, 20));
    executionOrder.push(1);
  });

  const p2 = withSessionLock(sessionId, async () => {
    executionOrder.push(2);
  });

  await Promise.all([p1, p2]);
  assert.deepEqual(executionOrder, [1, 2]);
});

test("ISSUE-0004: renderActiveConstraintsXml performs deterministic sorting to protect KV Cache", () => {
  const state: SessionSkillState = {
    extraAllow: new Set(),
    extraBlock: new Set(["zeta-skill", "alpha-skill", "beta-skill"]),
    invokedSkills: new Set(),
    mountedSkills: new Map([
      ["omega-skill", { description: "Omega", location: "/path/omega/SKILL.md" }],
      ["delta-skill", { description: "Delta", location: "/path/delta/SKILL.md" }],
    ]),
  };

  const xml = renderActiveConstraintsXml(state);
  assert.ok(xml);
  assert.ok(xml.includes(CONSTRAINT_TAG_START));
  assert.ok(xml.includes(CONSTRAINT_TAG_END));

  // 验证字母升序排序：alpha -> beta -> zeta
  const alphaIdx = xml.indexOf('"alpha-skill"');
  const betaIdx = xml.indexOf('"beta-skill"');
  const zetaIdx = xml.indexOf('"zeta-skill"');
  assert.ok(alphaIdx < betaIdx && betaIdx < zetaIdx, "extraBlock 必须严格按字母序升序排列");

  // 验证新挂载 Skill 字母升序排序：delta -> omega
  const deltaIdx = xml.indexOf('"delta-skill"');
  const omegaIdx = xml.indexOf('"omega-skill"');
  assert.ok(deltaIdx < omegaIdx, "mountedSkills 必须严格按字母序升序排列");
});

test("ISSUE-0004: stripExistingConstraints guarantees idempotency across multiple tool calls in Agentic Loop", () => {
  const original = "用户原始输入：请帮我分析数据。";
  const state: SessionSkillState = {
    extraAllow: new Set(),
    extraBlock: new Set(["restricted-skill"]),
    invokedSkills: new Set(),
    mountedSkills: new Map(),
  };

  const xml = renderActiveConstraintsXml(state)!;
  const combinedOnce = `${original}\n\n${xml}`;
  const strippedOnce = stripExistingConstraints(combinedOnce);
  assert.equal(strippedOnce, original);

  // 模拟多次工具自循环后可能残留的多重标签
  const combinedTwice = `${original}\n\n${xml}\n\n${xml}`;
  const strippedTwice = stripExistingConstraints(combinedTwice);
  assert.equal(strippedTwice, original);
});

test("ISSUE-0004: pi.on('context') projects constraints to the last user message in memory without mutating session log", async () => {
  const mock = createMockPi();
  skillGuard(mock.pi);

  const sessionId = "session-context-test-123";
  const { ctx } = createMockContext({ sessionId });

  const state = getSessionSkillState(sessionId);
  state.extraBlock.add("forbidden-analytics");

  const contextHook = mock.handlers["context"]?.[0];
  assert.ok(contextHook, "context hook 必须已注册");

  const initialMessages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "用户第 1 轮提问" },
    { role: "assistant", content: [{ type: "text", text: "模型回答 1" }] },
    {
      role: "user",
      content: [{ type: "text", text: "用户第 2 轮提问：请继续。" }],
    },
  ];

  // 第一次进入 context
  const res1 = await contextHook({ messages: initialMessages }, ctx);
  assert.ok(res1?.messages);
  assert.equal(res1.messages.length, 4, "严禁追加独立的 user 节点（INV-2 角色交替合规）");

  const lastUserMsg1 = res1.messages[3];
  assert.equal(lastUserMsg1.role, "user");
  assert.ok(Array.isArray(lastUserMsg1.content));
  const textBlocks1 = lastUserMsg1.content.filter((b: any) => b.type === "text");
  assert.ok(textBlocks1.some((b: any) => b.text.includes(CONSTRAINT_TAG_START)));
  assert.ok(textBlocks1.some((b: any) => b.text.includes('"forbidden-analytics"')));

  // 第二次进入 context（模拟同回合第 2 次 tool 调用，验证幂等性）
  const res2 = await contextHook({ messages: res1.messages }, ctx);
  assert.ok(res2?.messages);
  const lastUserMsg2 = res2.messages[3];
  const constraintsCount = lastUserMsg2.content.filter(
    (b: any) => b.type === "text" && b.text.includes(CONSTRAINT_TAG_START)
  ).length;
  assert.equal(constraintsCount, 1, "Agentic Loop 中重复触发时同一消息中必须仅保留一份最新约束（INV-6 幂等性）");
});

test("ISSUE-0004: tool_call blocks bash commands invoking restricted skills (INV-5 Defense-in-Depth)", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "blocklist",
      block: ["restricted-scraper"],
      blockReadTool: true,
    },
  });
  skillGuard(mock.pi);

  const sessionId = "bash-intercept-session";
  const { ctx } = createMockContext({
    sessionId,
    cwd: "/workspace/project",
  });

  const toolHook = mock.handlers["tool_call"]?.[0];
  assert.ok(toolHook);

  // 1. 尝试直接执行技能目录下的脚本
  const bashCall1 = await toolHook(
    {
      toolName: "bash",
      input: { command: "python3 ~/.agents/skills/restricted-scraper/run.py" },
    },
    ctx
  );
  assert.equal(bashCall1?.block, true);
  assert.match(bashCall1?.reason, /\[Skill Guard Blocked\]: Access to skill "restricted-scraper"/);
  assert.match(bashCall1?.reason, /Operational guidance: Please adhere to <active_skill_constraints>/);

  // 2. 尝试执行工作区 skills 路径脚本
  const bashCall2 = await toolHook(
    {
      toolName: "bash",
      input: { command: "bash ./skills/restricted-scraper/extract.sh" },
    },
    ctx
  );
  assert.equal(bashCall2?.block, true);
  assert.match(bashCall2?.reason, /\[Skill Guard Blocked\]: Access to skill "restricted-scraper"/);

  // 2b. 尝试通过 Hex 转义隐藏路径
  const bashCallHex = await toolHook(
    {
      toolName: "bash",
      input: { command: "python3 \\x2fhome\\x2fuser\\x2f.agents\\x2fskills\\x2frestricted-scraper\\x2frun.py" },
    },
    ctx
  );
  assert.equal(bashCallHex?.block, true);
  assert.match(bashCallHex?.reason, /\[Skill Guard Blocked\]: Access to skill "restricted-scraper"/);

  // 3. 正常不相关的通用 bash 命令放行
  const bashCallSafe = await toolHook(
    {
      toolName: "bash",
      input: { command: "ls -la src/ && git status" },
    },
    ctx
  );
  assert.equal(bashCallSafe, undefined);
});

test("ISSUE-0004: INV-1 Prefix Immutability protects initial System Prompt from mid-session mutations", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["skill-a", "skill-b"],
    },
  });
  skillGuard(mock.pi);

  const sessionId = "prefix-immutability-session";
  const { ctx } = createMockContext({ sessionId });

  const beforeAgentHook = mock.handlers["before_agent_start"]?.[0];
  const contextHook = mock.handlers["context"]?.[0];
  assert.ok(beforeAgentHook && contextHook);

  // 首轮交互注入 System Prompt
  const initialSkills = [
    { name: "skill-a", description: "Skill A" },
    { name: "skill-b", description: "Skill B" },
  ];
  const event1 = { systemPromptOptions: { skills: [...initialSkills] } };
  await beforeAgentHook(event1, ctx);
  assert.equal(event1.systemPromptOptions.skills.length, 2, "首轮放行 2 个技能");

  // 模拟首轮交互发生，触发 context 钩子设置 hasStarted = true
  await contextHook(
    { messages: [{ role: "user", content: "第一轮用户输入" }] },
    ctx
  );

  // 在中途用户动态禁用了 skill-b
  const state = getSessionSkillState(sessionId);
  state.extraBlock.add("skill-b");

  // 后续轮次的 before_agent_start 再次触发
  const event2 = { systemPromptOptions: { skills: [...initialSkills] } };
  await beforeAgentHook(event2, ctx);

  // INV-1 验证：开局声明绝对不可变！不得回溯剔除 skill-b，保护 KV Cache！
  assert.equal(
    event2.systemPromptOptions.skills.length,
    2,
    "会话开启后，before_agent_start 不得再回溯修改第 0 轮 System Prompt（INV-1 严格不可变）"
  );
});

test("ISSUE-0005: resolveConfig parses notifyOnStartup with safe defaults and fallback", () => {
  // 1. 默认值断言
  const mockDefault = createMockPi();
  const cfgDefault = resolveConfig(mockDefault.pi);
  assert.equal(cfgDefault.notifyOnStartup, true);

  // 2. 显式设为 false
  const mockFalse = createMockPi({
    skillGuard: {
      notifyOnStartup: false,
    },
  });
  const cfgFalse = resolveConfig(mockFalse.pi);
  assert.equal(cfgFalse.notifyOnStartup, false);

  // 3. 非 boolean 脏数据安全降级
  const mockInvalid = createMockPi({
    skillGuard: {
      notifyOnStartup: "invalid" as any,
    },
  });
  const cfgInvalid = resolveConfig(mockInvalid.pi);
  assert.equal(cfgInvalid.notifyOnStartup, true);
});

test("ISSUE-0005: session_start triggers startup notification and sets status bar when UI is present", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      notifyOnStartup: true,
    },
  });
  skillGuard(mock.pi);

  const sessionStartHook = mock.handlers["session_start"]?.[0];
  assert.ok(sessionStartHook);

  const { ctx, notifications, statusCalls } = createMockContext({
    hasUI: true,
    sessionId: "startup-ui-session",
  });

  await sessionStartHook({}, ctx);

  // 断言瞬态通知
  assert.ok(
    notifications.some((n) => n.msg === "🛡️ Skill Guard active [allowlist]" && n.type === "info"),
    "必须触发瞬态启动通知"
  );

  // 断言状态栏指示器
  assert.deepEqual(statusCalls, [
    { key: "skill-guard", text: "🛡️ guard:allowlist" },
  ]);
});

test("ISSUE-0005: session_start respects notifyOnStartup false to stay quiet while maintaining status bar", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "blocklist",
      notifyOnStartup: false,
    },
  });
  skillGuard(mock.pi);

  const sessionStartHook = mock.handlers["session_start"]?.[0];
  assert.ok(sessionStartHook);

  const { ctx, notifications, statusCalls } = createMockContext({
    hasUI: true,
    sessionId: "startup-quiet-session",
  });

  await sessionStartHook({}, ctx);

  // 静音断言：不触发通知
  assert.equal(notifications.length, 0, "notifyOnStartup 为 false 时不得触发启动通知");

  // 但常驻状态栏仍需正确设置
  assert.deepEqual(statusCalls, [
    { key: "skill-guard", text: "🛡️ guard:blocklist" },
  ]);
});

test("ISSUE-0005: session_start clears status bar and suppresses notification when disabled", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: false,
      mode: "allowlist",
    },
  });
  skillGuard(mock.pi);

  const sessionStartHook = mock.handlers["session_start"]?.[0];
  assert.ok(sessionStartHook);

  const { ctx, notifications, statusCalls } = createMockContext({
    hasUI: true,
    sessionId: "startup-disabled-session",
  });

  await sessionStartHook({}, ctx);

  assert.equal(notifications.length, 0, "禁用状态下不得触发通知");
  assert.deepEqual(statusCalls, [
    { key: "skill-guard", text: undefined },
  ], "禁用状态下必须清除状态栏");
});

test("ISSUE-0005: applyAction dynamically synchronizes status bar indicator upon state mutations", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
    },
  });
  skillGuard(mock.pi);

  const sessionId = "action-sync-session";
  const { ctx, statusCalls } = createMockContext({
    hasUI: true,
    sessionId,
  });

  // 1. 切换到 blocklist 模式
  const modeRes = await applyAction({ type: "mode", mode: "blocklist" }, ctx, mock.pi);
  assert.equal(modeRes, true);
  assert.equal(statusCalls[statusCalls.length - 1]?.text, "🛡️ guard:blocklist");

  // 2. 动态停用守卫 (disable)
  const disableRes = await applyAction({ type: "disable" }, ctx, mock.pi);
  assert.equal(disableRes, true);
  assert.equal(statusCalls[statusCalls.length - 1]?.text, undefined, "停用后状态栏指示器应被清除");

  // 3. 重新启用守卫 (enable)
  const enableRes = await applyAction({ type: "enable" }, ctx, mock.pi);
  assert.equal(enableRes, true);
  assert.equal(statusCalls[statusCalls.length - 1]?.text, "🛡️ guard:blocklist");
});
