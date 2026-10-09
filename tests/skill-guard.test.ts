import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import skillGuard, {
  resolveConfig,
  getEffectiveConfig,
  updateKnownSkills,
  getKnownSkills,
  clearKnownSkills,
  generateSkillMountPrompt,
  handleMountCommand,
  updateStatusBar,
} from "../extensions/skill-guard.ts";
import { DEFAULT_CONFIG } from "../extensions/matcher.ts";

describe("pi-skill-guard 极简核心行为测试", () => {
  beforeEach(() => {
    clearKnownSkills();
  });

  it("resolveConfig 读取合法配置与默认值", () => {
    const mockPi = {
      getSettings: () => ({
        enabled: true,
        mode: "blocklist",
        allow: ["skill-a"],
        block: ["skill-b"],
      }),
    } as any;

    const config = resolveConfig(mockPi);
    assert.equal(config.enabled, true);
    assert.equal(config.mode, "blocklist");
    assert.deepEqual(config.allow, ["skill-a"]);
    assert.deepEqual(config.block, ["skill-b"]);
    assert.equal(config.notifyOnStartup, true);
  });

  it("before_agent_start 原地修剪 skills 数组 (allowlist 模式)", () => {
    let beforeAgentStartHandler: any;
    const mockPi = {
      on: (event: string, handler: any) => {
        if (event === "before_agent_start") beforeAgentStartHandler = handler;
      },
      registerCommand: () => {},
      getSettings: () => ({
        enabled: true,
        mode: "allowlist",
        allow: ["skill-1", "skill-3"],
      }),
    } as any;

    skillGuard(mockPi);
    assert.ok(beforeAgentStartHandler);

    const skills = [
      { name: "skill-1", description: "first" },
      { name: "skill-2", description: "second" },
      { name: "skill-3", description: "third" },
    ];
    const event = { systemPromptOptions: { skills } };
    const ctx = { hasUI: false, sessionManager: { getSessionId: () => "sess-1" } } as any;

    beforeAgentStartHandler(event, ctx);

    // 验证原地修改：skill-2 被物理剔除，只剩 1 和 3
    assert.equal(skills.length, 2);
    assert.deepEqual(skills.map((s) => s.name), ["skill-1", "skill-3"]);
  });

  it("before_agent_start 原地修剪 skills 数组 (blocklist 模式)", () => {
    let beforeAgentStartHandler: any;
    const mockPi = {
      on: (event: string, handler: any) => {
        if (event === "before_agent_start") beforeAgentStartHandler = handler;
      },
      registerCommand: () => {},
      getSettings: () => ({
        enabled: true,
        mode: "blocklist",
        block: ["danger-*"],
      }),
    } as any;

    skillGuard(mockPi);

    const skills = [
      { name: "safe-tool", description: "safe" },
      { name: "danger-eval", description: "dangerous" },
      { name: "danger-rm", description: "dangerous" },
    ];
    const event = { systemPromptOptions: { skills } };
    const ctx = { hasUI: false } as any;

    beforeAgentStartHandler(event, ctx);

    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "safe-tool");
  });

  it("before_agent_start 当 enabled 为 false 时原样放行全部技能", () => {
    let beforeAgentStartHandler: any;
    const mockPi = {
      on: (event: string, handler: any) => {
        if (event === "before_agent_start") beforeAgentStartHandler = handler;
      },
      registerCommand: () => {},
      getSettings: () => ({
        enabled: false,
        allow: ["only-one"],
      }),
    } as any;

    skillGuard(mockPi);

    const skills = [{ name: "skill-1" }, { name: "skill-2" }];
    const event = { systemPromptOptions: { skills } };
    beforeAgentStartHandler(event, { hasUI: false } as any);

    assert.equal(skills.length, 2);
  });

  it("generateSkillMountPrompt 生成标准正向能力追加声明", () => {
    const prompt = generateSkillMountPrompt([
      { name: "archify", description: "架构图工具", location: "/home/user/.agents/skills/archify" },
    ]);

    assert.match(prompt, /\[能力挂载\] 本次任务已解锁以下技能/);
    assert.match(prompt, /- archify: 架构图工具 \(路径: \/home\/user\/\.agents\/skills\/archify\)/);
  });

  it("handleMountCommand 通过 TUI 将正向能力填入当前输入框 (setEditorText)", async () => {
    updateKnownSkills([
      { name: "allowed-skill", description: "已放行" },
      { name: "unmounted-skill", description: "未放行工具", location: "/path/to/skill" },
    ]);

    let editorText = "";
    let notifiedMsg = "";
    const mockCtx = {
      hasUI: true,
      ui: {
        select: async () => "unmounted-skill - 未放行工具",
        setEditorText: (text: string) => {
          editorText = text;
        },
        notify: (msg: string) => {
          notifiedMsg = msg;
        },
      },
      sessionManager: { getSessionId: () => "sess-1" },
    } as any;

    const mockPi = {
      getSettings: () => ({
        enabled: true,
        mode: "allowlist",
        allow: ["allowed-skill"],
      }),
    } as any;

    await handleMountCommand(mockCtx, mockPi);

    assert.ok(editorText.includes("[能力挂载]"));
    assert.ok(editorText.includes("unmounted-skill"));
    assert.ok(notifiedMsg.includes("已将技能 [unmounted-skill] 挂载声明填入输入框"));
  });

  it("session_start 状态感知与状态栏更新", () => {
    let sessionStartHandler: any;
    const mockPi = {
      on: (event: string, handler: any) => {
        if (event === "session_start") sessionStartHandler = handler;
      },
      registerCommand: () => {},
      getSettings: () => ({
        enabled: true,
        mode: "allowlist",
        allow: ["skill-a", "skill-b"],
        notifyOnStartup: true,
      }),
    } as any;

    let statusBarText = "";
    let notifyText = "";
    const mockCtx = {
      hasUI: true,
      ui: {
        setStatusBar: (text: string) => {
          statusBarText = text;
        },
        notify: (msg: string) => {
          notifyText = msg;
        },
      },
      sessionManager: { getSessionId: () => "sess-1" },
    } as any;

    skillGuard(mockPi);
    sessionStartHandler({}, mockCtx);

    assert.equal(statusBarText, "🛡️ SG [allow:2]");
    assert.equal(notifyText, "🛡️ Skill Guard active [allowlist]");
  });

  it("当 enabled 为 false 时，状态栏清空", () => {
    let statusBarText: string | undefined = "init";
    const mockCtx = {
      hasUI: true,
      ui: {
        setStatusBar: (text?: string) => {
          statusBarText = text;
        },
      },
    } as any;

    updateStatusBar(mockCtx, {
      ...DEFAULT_CONFIG,
      enabled: false,
    });

    assert.equal(statusBarText, undefined);
  });
});
