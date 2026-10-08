import test from "node:test";
import assert from "node:assert/strict";
import {
  globToRegex,
  matchesAnyPattern,
  isSkillAllowed,
} from "../extensions/matcher.ts";

test("globToRegex converts wildcards correctly", () => {
  const reg1 = globToRegex("tavily-*");
  assert.equal(reg1.test("tavily-search"), true);
  assert.equal(reg1.test("tavily-crawl"), true);
  assert.equal(reg1.test("cloudflare"), false);

  const reg2 = globToRegex("*search*");
  assert.equal(reg2.test("tavily-search"), true);
  assert.equal(reg2.test("search-engine"), true);
  assert.equal(reg2.test("my-search-tool"), true);
  assert.equal(reg2.test("grep"), false);

  const reg3 = globToRegex("test-?");
  assert.equal(reg3.test("test-1"), true);
  assert.equal(reg3.test("test-a"), true);
  assert.equal(reg3.test("test-12"), false);
});

test("matchesAnyPattern matches exact and wildcards", () => {
  const patterns = ["cloudflare", "tavily-*", "ccm-note-?"];
  assert.equal(matchesAnyPattern("cloudflare", patterns), true);
  assert.equal(matchesAnyPattern("CLOUDFLARE", patterns), true); // case-insensitive
  assert.equal(matchesAnyPattern("tavily-extract", patterns), true);
  assert.equal(matchesAnyPattern("ccm-note-1", patterns), true);
  assert.equal(matchesAnyPattern("ccm-note-write", patterns), false);
  assert.equal(matchesAnyPattern("unrelated", patterns), false);
  assert.equal(matchesAnyPattern("  cloudflare  ", patterns), true); // trim
});

test("isSkillAllowed in allowlist mode", () => {
  const config = {
    mode: "allowlist" as const,
    allow: ["ponytail", "ccm-*", "tavily-*"],
  };

  assert.equal(isSkillAllowed("ponytail", config), true);
  assert.equal(isSkillAllowed("ccm-note-verify", config), true);
  assert.equal(isSkillAllowed("tavily-search", config), true);
  assert.equal(isSkillAllowed("cloudflare", config), false);
  assert.equal(isSkillAllowed("boss-recruitment", config), false);
});

test("isSkillAllowed with empty allowlist defaults to permissive", () => {
  const config = {
    mode: "allowlist" as const,
    allow: [],
  };
  assert.equal(isSkillAllowed("any-skill", config), true);
});

test("isSkillAllowed in blocklist mode", () => {
  const config = {
    mode: "blocklist" as const,
    block: ["*-dangerous", "crypto-*"],
  };

  assert.equal(isSkillAllowed("normal-skill", config), true);
  assert.equal(isSkillAllowed("run-dangerous", config), false);
  assert.equal(isSkillAllowed("crypto-mining", config), false);
});

test("isSkillAllowed enforces Deny-First invariant (block overrides allow)", () => {
  const config = {
    mode: "allowlist" as const,
    allow: ["danger-skill", "safe-*"],
    block: ["danger-skill", "safe-evil"],
  };

  // 即使在 allow 中，命中 block 也必须强制阻断
  assert.equal(isSkillAllowed("danger-skill", config), false);
  assert.equal(isSkillAllowed("safe-evil", config), false);
  assert.equal(isSkillAllowed("safe-good", config), true);
});

test("isSkillAllowed when disabled", () => {
  const config = {
    enabled: false,
    mode: "allowlist" as const,
    allow: ["only-this"],
    block: ["anything"],
  };
  assert.equal(isSkillAllowed("anything", config), true);
});

test("isSkillAllowed normalizes case and whitespace", () => {
  const config = {
    mode: "allowlist" as const,
    allow: ["my-skill"],
  };
  assert.equal(isSkillAllowed("  MY-SKILL  ", config), true);
});
