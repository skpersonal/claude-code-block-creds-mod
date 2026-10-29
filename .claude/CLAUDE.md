# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It lives in `.claude/` because `claude plugin validate --strict` fails on a `CLAUDE.md` at the plugin root (it is not loaded as plugin context).

## What this is

A Claude Code **mod** (a plugin whose TypeScript hooks run inside Claude Code, v2.1.287+) that redacts or blocks credentials before they reach the LLM. Detection is delegated to the external `betterleaks` binary; this repo has no detection rules of its own and should not grow any (use betterleaks config via `configPath` instead). `README.md` (Japanese) covers user-facing behavior, settings and limitations.

## Commands

```bash
pnpm install                        # once; also enables the husky pre-commit hook (lint-staged, typecheck, test)
pnpm lint                           # biome check; `pnpm format` applies fixes
claude plugin validate . --strict   # (`pnpm validate`) must pass; also lists the hooks and `$` calls static analysis found
claude plugin test                  # all tests (betterleaks is stubbed). It takes a plugin directory, not a test file; no single-test selector was found, and the whole suite runs in a few seconds
pnpm typecheck                      # tsc -p .; type check (no build step; Claude Code loads .ts directly)
claude --plugin-dir . -p "..."      # run the mod for real; --plugin-dir hot-reloads on save
```

`.claude-plugin/types/` is written by Claude Code from the installed version (git-ignored). Since 2.1.312 it is written only when an interactive session loads the folder as a hot-reloaded plugin dir (`claude --plugin-dir .`), not by `claude -p`; the built-in plugin-authoring skill also hands out the same API as one file (`types/claude-code.d.ts`). After a fresh clone or a Claude Code upgrade, load it once that way before `tsc`. The README's 開発 section has the full procedure, including the real-session leak check. Treat it as the API reference (`claude-code/index.d.ts`), and trust it over the web docs. The root `tsconfig.json` exists only to add `allowImportingTsExtensions`.

## Architecture

`hooks/register.ts` is the entry point (`hooks/hooks.json` points to it). It hooks every path it can find to the model and runs each text through the same `judge()` (scan, then redact/block/error verdict):

- `prompt.submit`: user prompt and its extra `context` (`drop` to refuse)
- `tool.call`: `await next(e)` then rewrite the result (`{ result }` to redact, `{ deny }` to block). A `.catch` handler denies, so a failing hook never lets an unchecked result through (a hook that fails after `next` otherwise leaves the original result in place). `prompt.submit` and `prompt.attachment` have the same `.catch`, and `judge()` refuses everything while betterleaks does not run (no `failMode`; always fail closed)
- `prompt.attachment`: `@file`, CLAUDE.md and similar text the engine injects (`{ text: null }` to drop). A real session confirmed the root CLAUDE.md arrives here (HEAD before `prompt.context` was hooked already redacted it)
- `prompt.context` (per block), `prompt.section`, `prompt.compose` (sections no `prompt.section` answer covered; `ctx.checkedTexts` maps a text to what is sent so each is scanned once), `skill.prompt`, `session.receive` (`{ consumed }` to refuse), `session.send` (`{ isDelivered: false }`), `session.compact` (`instructions` only; the conversation was checked on the way in), `command.run` (slash command args; they do not pass `prompt.submit`, verified. `LOCAL_COMMANDS` are not scanned so `/plugin`, `/reload-plugins` and `/block-creds` still work while betterleaks is down), `classic.PostToolUse` (`updatedToolOutput`), `model.complete` / `model.fork` / `model.classify` (other plugins' calls on `$`): the other ways text reaches a model; each has a `.catch` that withholds

`judge()` adds `ruleId: 'known'` findings for values the redactor already handed placeholders for (`findKnown`), since betterleaks misses a bare value out of context. It turns a redact verdict into `block` when a finding is in none of the texts: betterleaks decodes base64 etc. (`--max-decode-depth`, default 5) and reports the decoded value, so `applyText` would replace nothing. `tool.call` restores placeholders only for `RESTORE_TOOLS` (an allow-list of local tools: Bash, PowerShell, Write, Edit, NotebookEdit, Read, Grep, Glob); MCP, WebFetch (its `prompt` goes to a model), WebSearch, Agent, Workflow, Cron and any new tool keep them. `guardResult` scans a `{ deny }` from beneath too. When Read's line numbers split a multi-line secret, it retries the finding with `withoutLineNumbers` before giving up.

Restored input passes beneath `tool.call`: PreToolUse / PermissionRequest settings hooks, the permission dialog and the auto-mode classifier all read the real value (confirmed: the classifier's debug line says a hook rewrote the input and the local classifier judges it). So in auto mode (`ctx.modes`, filled from `permission_mode` of the `classic.*` hooks registered for that; no `$` call reads the live mode) `autoModeRefusal` asks `$.tool.check` first and denies a call whose verdict is `ask`. A subagent's mode counts as unknown (asked) until its own classic hook reports it. Note that auto mode drops a bare `Bash` allow rule (`Ignoring dangerous permission Bash(*)`).

`session.append` (`APPEND_DOORS`: `command`, `note`, `tool-message`, `compaction`, `hook-context`): rows no other hook sees, e.g. `!cmd` (bash mode) as `<bash-input>` / `<bash-stdout>` rows (confirmed in a real session; they bypass `tool.call` and `prompt.submit`), other plugins' rows, compaction rows. A row cannot be refused, so `block`/`error` verdicts store the row with its text replaced (`withheldRow`), and the `.catch` handler must still call `next` with replaced text (answering without `next` keeps the original row). Doors covered by other hooks (`prompt`, `tool-result`, `attachment`, `delivery`) and the model's own rows are not scanned: that would run betterleaks twice per row. `queue` (2.1.312) is a transcript record, not a conversation row.

`ui.render` rewrites only what is drawn (`restoreDeep` on the writable props of `DISPLAY_FIELDS`; a rewrite of a read-only prop makes the engine draw the original), so the model still reads placeholders.

Why display-only: no mods hook masks only on send. `turn.step` messages are pinned, and a rewritten response is recorded in the history, so the real value would reach the next request. Secrets are never written to disk, so after `--resume` old rows keep their placeholders until the same secret is met again (`judge()` then calls `$.ui.invalidate('ui.render')`). An empty `hashKey` is generated in `readCtx` and kept in `$.store` (`loadStoredKey`, run on `session.start` and before the first `judge()` scan), so the same secret gets the same placeholder after a restart.

Placeholders are `[REDACTED-<first 12 hex of HMAC-SHA256(key, secret)>]` (`hooks/redactor.ts`), so the same secret maps to the same placeholder everywhere with no stored table. The `Map<placeholder, secret>` in memory is used only to restore real values in `tool.call` input before the tool runs and in `ui.render` props before they are drawn.

Constraints from Claude Code's static analysis (`validate` enforces them):

- `$` (the mods API) may only be passed to top-level functions in the **same file** as `register`. That is why the code that spawns betterleaks (`scanTexts`) lives in `register.ts`, while `redactor.ts` and `scanner.ts` are pure and importable by tests.
- Event names must be string literals; `$.process.run`, `$.ui.toast` etc. must be spelled in full (the parameter must be named `$`). Imports are relative paths (with `.ts`) or `claude-code`.
- Each event can be registered once without a matcher.

## betterleaks gotchas

- Output is parsed by `scanner.ts:interpret`: exit 0 or 1 with JSON is valid, anything else is a scan error (always fail closed).
- betterleaks reads `.betterleaks.toml` / `.gitleaks.toml` and `.betterleaksignore` / `.gitleaksignore` (stdin fingerprints are `:<rule>:<line>`) from its working directory even when `-i` names another path, and `BETTERLEAKS_CONFIG(_TOML)` / `GITLEAKS_CONFIG(_TOML)` from the environment. A project could thus allowlist everything. `scanTexts` runs it with `cwd: SCAN_CWD` (`/`) and `env: scanEnv()` (all four emptied); `-c configPath` is the only way to change rules, and `checkBinary` refuses a relative `configPath`.
- A line with `gitleaks:allow` / `betterleaks:allow` is skipped unless `--ignore-gitleaks-allow` is passed (`buildArgv` does).
- `checkBinary` runs `version` and then scans `PROBE_TEXT` (a made-up `ghp_` token, split in the source): a failed scan makes betterleaks unavailable with the reason in `ctx.lastError` (shown by `/block-creds`), a missed token only warns.
- Some secrets are only reported **nested** inside another finding (`aws-secret-access-key` under `aws-access-token` → `ComponentSets[].components[]`). `collectFindings` walks the whole tree; reading only top-level `Secret` leaked AWS secret keys in an E2E run.
- Default rules skip some shapes (standalone AWS key IDs, URL-embedded passwords, ids ending in `EXAMPLE`). Dummy AWS keys for manual checks must match `AKIA[A-Z2-7]{16}` plus a 40-char secret nearby.
- Read's `text` has line numbers (`12\t…` in 2.1.312) but `result.file.content` does not, so a multi-line Secret found in `text` (a PEM private key) is in no string of `result` as found. `guardResult` maps such a finding through `withoutLineNumbers` (verified with `tests/dummy-private-key.txt` in a real session), and still denies when `unredacted()` says a secret was not reached; keep that check.
- A secret directly followed by `<` is not detected (`…Qz</bash-stdout>`, `<SecretAccessKey>…</SecretAccessKey>`, `token=…</td>`). `scanTexts` scans `forScan(text)` (a space before every `<` and after every `>`, lines unchanged) for every path and redacts the original text.

## Testing notes

- Unit tests import `../hooks/*.ts` directly; event tests use `claude-code/testing` and stub `process.run` / `tool.call` / `prompt.submit` beneath the mod. `test(name, { options: {...} }, body)` sets userConfig values.
- Stubs for mods API calls return `{ value }` (or `{ deny }` to make the call reject); stubs for events return the event's own result shape (`tool.check` answers `{ decision }`, also for `$.tool.check`).
- `$.classic.<Event>(fields)` raises a classic hook event; it needs a stub beneath (`on('classic.UserPromptSubmit', () => ({}))`).
- A test cannot raise another plugin's `$.model.complete` (the test module's own `$` calls are refused: "its hooks module does not call it"), so the `model.*` hooks have no event test.
- Unit tests cannot see engine behavior such as result-schema validation or what a real session sends. For changes to hook results, also run a real session with a dummy `.env` (see the README example) and grep the `--output-format stream-json --verbose` output for the secrets.
- `userConfig` for a `--plugin-dir` session worked via `--settings file.json` with `pluginConfigs` holding both `"block-creds@inline": { "options": { "mode": "block" } }` and `"@inline/block-creds": { "mode": "block" }`. Which of the two keys took effect was not isolated.
- `on('ui.render', ...)` (like any `on`) must be registered before the test's first `$` call, or it throws `TypeError: on("ui.render") after the test first called $`. Register stubs first, then call `$.tool.call` and so on.
- A `sensitive` userConfig row (`hashKey`) does not show up in `$.config.list()` (real session: `no hashKey row`), so the generated key lives in `$.store`, not in the setting. A hand-entered `hashKey` wins over the store.
- `ui.render` only runs in an interactive session; `claude -p` output never goes through it, so the on-screen restore needs a manual check in `claude --plugin-dir .`.
