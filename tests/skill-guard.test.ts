import test from "node:test";
import assert from "node:assert/strict";
import skillGuard, { resolveConfig } from "../extensions/skill-guard.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Mock Pi ExtensionAPI
function createMockPi(mockSettings: Record<string, unknown> = {}) {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const commands: Record<string, any> = {};
  const sentMessages: any[] = [];

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
    sendMessage(msg: any) {
      sentMessages.push(msg);
    },
  };

  return {
    pi: mockPi as ExtensionAPI,
    handlers,
    commands,
    sentMessages,
  };
}

test("resolveConfig reads config correctly from getSettings", () => {
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
});

test("before_agent_start filters skills in allowlist mode", async () => {
  const mock = createMockPi({
    skillGuard: {
      enabled: true,
      mode: "allowlist",
      allow: ["ponytail", "ccm-*"],
    },
  });
  skillGuard(mock.pi);

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
      skills: [
        { name: "ponytail", description: "Minimal dev", filePath: "/path/1" },
        { name: "ccm-note-verify", description: "Audit", filePath: "/path/2" },
        { name: "tavily-search", description: "Search", filePath: "/path/3" },
        { name: "boss-recruitment", description: "Jobs", filePath: "/path/4" },
      ],
    },
  };

  await mock.handlers["before_agent_start"][0](event);

  const remaining = event.systemPromptOptions.skills.map((s) => s.name);
  assert.deepEqual(remaining, ["ponytail", "ccm-note-verify"]);
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

  // Blocked skill read
  const blockedResult = await hook({
    type: "tool_call",
    toolName: "read",
    toolCallId: "call_1",
    input: { path: "/home/user/.agents/skills/forbidden-skill/SKILL.md" },
  });
  assert.equal(blockedResult?.block, true);
  assert.match(blockedResult?.reason, /forbidden-skill.*未被授权/);

  // Allowed skill read
  const allowedResult = await hook({
    type: "tool_call",
    toolName: "read",
    toolCallId: "call_2",
    input: { path: "/home/user/.agents/skills/allowed-skill/SKILL.md" },
  });
  assert.equal(allowedResult, undefined);

  // Normal project file read
  const fileResult = await hook({
    type: "tool_call",
    toolName: "read",
    toolCallId: "call_3",
    input: { path: "/home/user/my-repo/src/index.ts" },
  });
  assert.equal(fileResult, undefined);
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
  let notified = "";
  const mockCtx = {
    notify: (msg: string) => {
      notified = msg;
    },
  } as unknown as ExtensionContext;

  // Block forbidden skill invocation
  const res1 = await hook({ text: "/skill:forbidden-skill args" }, mockCtx);
  assert.deepEqual(res1, { action: "handled" });
  assert.match(notified, /命令已阻断：技能 "forbidden-skill"/);

  // Allow whitelisted skill invocation
  const res2 = await hook({ text: "/skill:allowed-skill" }, mockCtx);
  assert.equal(res2, undefined);

  // Normal chat input
  const res3 = await hook({ text: "what is typescript?" }, mockCtx);
  assert.equal(res3, undefined);
});

test("registerCommand registers /skill-guard", async () => {
  const mock = createMockPi();
  skillGuard(mock.pi);

  assert.ok(mock.commands["skill-guard"]);
  assert.equal(mock.commands["skill-guard"].description.includes("Skill Guard"), true);

  let notifiedText = "";
  const mockCtx = {
    notify: (text: string) => {
      notifiedText = text;
    },
  } as unknown as ExtensionContext;

  await mock.commands["skill-guard"].handler("", mockCtx);
  assert.match(notifiedText, /pi-skill-guard 状态报告/);
});
