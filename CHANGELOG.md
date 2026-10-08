# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-08

### Breaking Changes
- **Deny-First Priority Rule**: Block rules now unconditionally override allowlist rules in all modes. If a skill name matches any `block` pattern, it is strictly forbidden regardless of `allow` matches.
- **Standalone File Deprecation**: Deprecated file reading of `.pi/skill-guard.json`. To prevent Trust boundary bypasses, all declarative rules must reside in `.pi/settings.json` under the `skillGuard` field.
- **Fail-Closed Malformed Handling**: Malformed or unparseable configurations now safely fail-closed (injecting hard blocking sentinels) instead of failing open.
- **Prefix Immutability Invariant**: To protect prompt caching and causal reasoning continuity, the initial Turn 0 System Prompt is strictly frozen after conversation start. Mid-session skill toggling is managed strictly through tail-constraint projection and tool gateways.

### Added
- **Temporal Consistency & Tail Constraint Projection (ISSUE-0004)**: Dynamic skill disabling/mounting mid-session injects structured `<active_skill_constraints>` at the tail of the last `user` message via memory projection (`pi.on("context")`), preserving 99%+ of the prefill KV Cache and preventing context fractures in model thinking traces.
- **Dual-Channel Defense-in-Depth for Tool Gateways**: Added robust interception for `bash` tool executions targeting restricted skill directories, scripts, or symlinks, with support for hex/escape obfuscation decoding, alongside existing `read` interception.
- **Deterministic XML Serialization & Idempotent Agentic Loops**: Guaranteed deterministic ASCII alphabetical sorting for active constraint lists, with idempotency stripping for multi-tool loop invocations.
- **Interactive `/skill-guard` Command (ISSUE-0003)**: Dynamic self-explanatory TUI menu and CLI shortcuts (`status`, `enable`, `disable`, `mode`, `allow`, `block`, `unallow`, `unblock`, `reset`) for safe in-memory session overrides.
- **Formal Permission Relaxation Gate**: Pure structural transition algorithm to prevent implicit permission expansion. Expansion requests require interactive confirmation in TUI mode and are hard-blocked in headless environments.
- **Symlink Escape Defense**: Dual-path verification evaluating both logical paths and physical `realpath`s with trailing slash directory normalization.
- **In-Place Prompt Pruning**: Direct in-place mutation of `systemPromptOptions.skills` guaranteeing zero token waste and hallucination defense across all transcript rendering lifecycles.
- **Comprehensive User Guides**: Added complete bilingual user manuals (`docs/user-guide.md` and `docs/user-guide.zh-CN.md`).

### Fixed
- Fixed directory direct reading bypass (`read <external-skill-dir>`).
- Fixed cross-session state contamination by isolating overrides to active session IDs via serialized `withSessionLock` mutex queues.
- Fixed case sensitivity mismatch by strictly normalizing skill identifiers to lowercase.

## [0.1.0] - 2026-10-08

### Added
- Initial release of `pi-skill-guard`.
- Dual-layer declarative skill boundary defense (system prompt pruning and `read` tool execution interceptor).
- Pattern matching supporting exact strings and wildcards (`*`, `?`).
- Allowlist and blocklist operation modes.
