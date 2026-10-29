import type { EngineInterface, On, PluginOptions } from 'claude-code'
import {
  appendToLastText,
  collectStrings,
  createRedactor,
  forScan,
  keyBytes,
  type Mapping,
  type Redactor,
  redactionNotice,
  replaceText,
  toHex,
  unredacted,
  withoutLineNumbers,
} from './redactor.ts'
import {
  buildArgv,
  type Finding,
  interpret,
  isAbsolutePath,
  MIN_SCAN_LENGTH,
  PROBE_SECRET,
  PROBE_TEXT,
  SCAN_CWD,
  type ScanOutcome,
  scanEnv,
} from './scanner.ts'

const SCAN_TIMEOUT_MS = 15_000

// Attachments the engine writes itself and that never carry file or tool content.
const SKIP_ATTACHMENTS = new Set(['todo_reminder', 'plan_mode', 'plan_mode_exit', 'auto_mode', 'auto_mode_exit', 'skill_listing', 'deferred_tools_delta'])

// Doors checked by `session.append`: rows no other hook here sees (bash mode, other plugins' rows, rows a tool hands
// over beside its result, the compaction's rows, settings hooks' context). The model's own rows are not user data.
const APPEND_DOORS = new Set<string>(['command', 'note', 'tool-message', 'compaction', 'hook-context'])

// Tools that run on this machine and whose input no other model reads: only these get real values back. Everything
// else (MCP, WebFetch's prompt, WebSearch, subagents, workflows, schedules, tools added later) keeps the placeholders.
const RESTORE_TOOLS = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Grep', 'Glob'] as const
const RESTORE_TOOL_SET = new Set<string>(RESTORE_TOOLS)

// Slash commands that act on this machine and send nothing to a model; their arguments are not checked, so they
// still run while betterleaks does not (the way to fix the setup).
const LOCAL_COMMANDS = new Set(['block-creds', 'plugin', 'plugins', 'reload-plugins', 'config', 'help', 'doctor', 'exit', 'quit'])

const MAIN_LOOP = 'main'

const HOW_TO_DISABLE = 'To turn block-creds off: /plugin, then block-creds, then Disable (or `claude plugin disable block-creds@block-creds-marketplace`).'

type Mode = 'redact' | 'block'

type Ctx = {
  mode: Mode
  bin: string
  configPath: string | undefined
  restore: boolean
  restoreDisplay: boolean
  /** A key made because `hashKey` was empty; `loadStoredKey` keeps it in the plugin store, or swaps it for the one already there. */
  generatedKey: string | undefined
  /** Set by the first `loadStoredKey`, so later calls wait for the same work. */
  keyLoad: Promise<void> | undefined
  keySource: 'setting' | 'store' | 'memory'
  redactor: Redactor
  stats: { redacted: number; blocked: number; failures: number; byRule: Map<string, number> }
  /** Notices since the last prompt was sent; kept on the status line until the next prompt. */
  notes: string[]
  version: string | undefined
  /** Whether betterleaks ran and passed the self-test last time it was checked; `undefined` until the first check. While it is not `true`, nothing is let through. */
  available: boolean | undefined
  /** Why betterleaks is not available, for the notices and `/block-creds`. */
  lastError: string | undefined
  /** Whether the self-test scan found its made-up token (rules in `configPath` may not). */
  detectsProbe: boolean | undefined
  /** The permission mode each loop last reported (classic hook inputs), by `agent_id`; `main` for the main loop. */
  modes: Map<string, string>
  /** System prompt texts already checked, with what is sent in their place (null: left out), so `prompt.compose` scans the rest only. */
  checkedTexts: Map<string, string | null>
}

type Verdict =
  | { kind: 'clean' }
  | { kind: 'redact'; mapping: Mapping; findings: readonly Finding[]; rules: string; notice: string }
  | { kind: 'block'; rules: string }
  | { kind: 'error'; error: string }

function readCtx(options: PluginOptions): Ctx {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  const configuredKey = str(options['hashKey'])
  const generatedKey = configuredKey === undefined ? toHex(crypto.getRandomValues(new Uint8Array(32))) : undefined
  return {
    mode: options['mode'] === 'block' ? 'block' : 'redact',
    bin: str(options['betterleaksPath']) ?? 'betterleaks',
    configPath: str(options['configPath']),
    restore: options['restoreInToolInput'] !== false,
    restoreDisplay: options['restoreInDisplay'] !== false,
    generatedKey,
    keyLoad: undefined,
    keySource: configuredKey === undefined ? 'memory' : 'setting',
    redactor: createRedactor(keyBytes(configuredKey ?? generatedKey)),
    stats: { redacted: 0, blocked: 0, failures: 0, byRule: new Map() },
    notes: [],
    version: undefined,
    available: undefined,
    lastError: undefined,
    detectsProbe: undefined,
    modes: new Map(),
    checkedTexts: new Map(),
  }
}

async function scanTexts($: EngineInterface, ctx: Ctx, texts: readonly string[]): Promise<ScanOutcome> {
  const joined = texts.map(forScan).join('\n\n')
  if (joined.trim().length < MIN_SCAN_LENGTH) return { ok: true, findings: [] }
  try {
    // Run outside the project with the config variables emptied, so neither can change the rules or hide findings.
    const r = await $.process.run(buildArgv(ctx.bin, ctx.configPath), { stdin: joined, timeoutMs: SCAN_TIMEOUT_MS, cwd: SCAN_CWD, env: scanEnv() })
    return interpret(r.exitCode, r.stdout, r.stderr)
  } catch (err) {
    return { ok: false, error: 'could not run ' + ctx.bin + ': ' + String(err) }
  }
}

/** Shows a toast and keeps the notice on the status line until the next prompt (`clearNotes`). Neither reaches the model. */
function notify($: EngineInterface, ctx: Ctx, text: string): void {
  try {
    $.ui.toast('block-creds: ' + text)
  } catch {
    // Nothing draws here (for example claude -p); the verdict still applies.
  }
  if (!ctx.notes.includes(text)) ctx.notes.push(text)
  try {
    $.ui.status('block-creds: ' + ctx.notes.join(' | '))
  } catch {
    // Nothing draws here; the verdict still applies.
  }
}

/** The hook itself failed (threw or ran out of budget); its `.catch` withholds the text. */
function hookFailed($: EngineInterface, ctx: Ctx, kind: string): void {
  ctx.stats.failures += 1
  notify($, ctx, 'check failed (' + kind + '), withheld')
}

function clearNotes($: EngineInterface, ctx: Ctx): void {
  if (ctx.notes.length === 0) return
  ctx.notes = []
  try {
    $.ui.status(undefined)
  } catch {
    // Nothing draws here; the verdict still applies.
  }
}

function record(ctx: Ctx, findings: readonly Finding[], kind: 'redacted' | 'blocked'): string {
  const rules = [...new Set(findings.map((f) => f.ruleId))]
  const secrets = new Set(findings.map((f) => f.secret)).size
  ctx.stats[kind] += secrets
  for (const f of findings) ctx.stats.byRule.set(f.ruleId, (ctx.stats.byRule.get(f.ruleId) ?? 0) + 1)
  return rules.join(', ')
}

/** What the model reads beside the placeholders of `mapping`, each with the rules that found its secret. */
function noticeFor(ctx: Ctx, mapping: Mapping, findings: readonly Finding[]): string {
  const rulesOf = new Map<string, Set<string>>()
  for (const f of findings) {
    const set = rulesOf.get(f.secret) ?? new Set<string>()
    set.add(f.ruleId)
    rulesOf.set(f.secret, set)
  }
  return redactionNotice(
    mapping.map(([secret, placeholder]) => ({ placeholder, rules: [...(rulesOf.get(secret) ?? [])] })),
    { restoreTools: ctx.restore ? RESTORE_TOOLS : [], userSeesRealValues: ctx.restoreDisplay },
  )
}

/** Learns the placeholders for these secrets; rows drawn before a value was known (a resumed session) can show it now. */
async function learn($: EngineInterface, ctx: Ctx, secrets: readonly string[]): Promise<Mapping> {
  const before = ctx.redactor.known()
  const mapping = await ctx.redactor.mapping(secrets)
  if (ctx.restoreDisplay && ctx.redactor.known() > before) {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // Nothing draws here; the verdict still applies.
    }
  }
  return mapping
}

/** Scans the texts and decides what has to happen to them. */
async function judge($: EngineInterface, ctx: Ctx, texts: readonly string[]): Promise<Verdict> {
  await loadStoredKey($, ctx)
  // Without a working betterleaks nothing is checked, so nothing is let through, short texts included.
  if (ctx.available !== true) await checkBinary($, ctx)
  if (ctx.available !== true) {
    ctx.stats.failures += 1
    return { kind: 'error', error: ctx.lastError ?? ctx.bin + ' is not available' }
  }
  const out = await scanTexts($, ctx, texts)
  if (!out.ok) {
    ctx.stats.failures += 1
    notify($, ctx, 'scan failed, withheld (' + out.error + ')')
    return { kind: 'error', error: out.error }
  }
  // A value already redacted once is redacted wherever it shows up again, even where betterleaks no longer sees it.
  const findings = [...out.findings]
  for (const secret of ctx.redactor.findKnown(texts)) {
    if (!findings.some((f) => f.secret === secret)) findings.push({ ruleId: 'known', secret })
  }
  if (findings.length === 0) return { kind: 'clean' }
  if (ctx.mode === 'block') {
    const rules = record(ctx, findings, 'blocked')
    notify($, ctx, 'blocked (' + rules + ')')
    return { kind: 'block', rules }
  }
  // betterleaks decodes (base64 and the like) and reports the decoded value, which is in no text, so nothing would be replaced.
  if (findings.some((f) => !texts.some((t) => t.includes(f.secret)))) {
    const rules = record(ctx, findings, 'blocked')
    notify($, ctx, 'withheld, could not redact (' + rules + ')')
    return { kind: 'block', rules }
  }
  const rules = record(ctx, findings, 'redacted')
  const mapping = await learn(
    $,
    ctx,
    findings.map((f) => f.secret),
  )
  notify($, ctx, 'redacted ' + mapping.length + ' value(s) (' + rules + ')')
  return { kind: 'redact', mapping, findings, rules, notice: noticeFor(ctx, mapping, findings) }
}

/** What the model reads in place of a tool result that held credentials. */
async function guardResult($: EngineInterface, ctx: Ctx, res: any) {
  // A refusal from beneath (a PreToolUse hook, another plugin) can quote the input, real values restored in it included.
  if (typeof res.deny === 'string') {
    const v = await judge($, ctx, [res.deny])
    if (v.kind === 'clean') return res
    if (v.kind === 'redact') return { deny: ctx.redactor.applyText(res.deny, v.mapping) + '\n\n' + v.notice }
    return { deny: 'This tool call was refused; block-creds withheld the reason because it could hold credentials. Do not retry the same call.' }
  }
  const texts: string[] = typeof res.text === 'string' ? [res.text] : collectStrings(res.result)
  if (Array.isArray(res.context)) texts.push(...res.context)
  const v = await judge($, ctx, texts)
  if (v.kind === 'clean') return res
  if (v.kind === 'error') {
    return { deny: 'block-creds could not check this tool result for credentials, so it was withheld. Do not retry the same call.' }
  }
  if (v.kind === 'block') {
    return { deny: 'block-creds withheld this tool result because it contains credentials (' + v.rules + '). Do not retry the same call.' }
  }
  if (res.isError === true) {
    const failure = typeof res.text === 'string' ? ctx.redactor.applyText(res.text, v.mapping) : 'The tool failed.'
    return { deny: failure + '\n\n' + v.notice }
  }
  const context: string[] = Array.isArray(res.context) ? res.context : []
  const original = [...collectStrings(res.result), ...context]
  let { mapping, notice } = v
  // Read's text numbers its lines, so a multi-line secret (a PEM private key) found there is in `result` without them.
  if (mapping.some(([secret]) => !original.some((s) => s.includes(secret)))) {
    const inResult = v.findings.map((f) => (original.some((s) => s.includes(f.secret)) ? f : { ...f, secret: withoutLineNumbers(f.secret) }))
    mapping = await learn(
      $,
      ctx,
      inResult.map((f) => f.secret),
    )
    notice = noticeFor(ctx, mapping, inResult)
  }
  const redacted = context.map((c) => ctx.redactor.applyText(c, mapping))
  const result = ctx.redactor.applyDeep(res.result, mapping)
  // The scan read `text`, but core maps `result` again for the model: a secret that is not in `result` as found (nor
  // without line numbers) is not replaced, so the result must not go through.
  if (unredacted(original, [...collectStrings(result), ...redacted], mapping)) {
    notify($, ctx, 'withheld, could not redact (' + v.rules + ')')
    return {
      deny:
        'block-creds withheld this tool result because it contains credentials (' + v.rules + ') that could not be replaced in it. Do not retry the same call.',
    }
  }
  return { result, context: [...redacted, notice] }
}

/** Marks betterleaks as not usable, with why; everything is withheld until a later check passes. */
function unavailable($: EngineInterface, ctx: Ctx, reason: string): void {
  ctx.available = false
  ctx.lastError = reason
  notify($, ctx, reason + '. Prompts and tool results are withheld until this is fixed; run /block-creds for how.')
}

/** Checks that betterleaks runs and scans with this mod's arguments: `version`, then a scan of a made-up token. */
async function checkBinary($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.configPath !== undefined && !isAbsolutePath(ctx.configPath)) {
    return unavailable($, ctx, 'configPath must be an absolute path (it is "' + ctx.configPath + '"; write ~ out in full)')
  }
  try {
    const r = await $.process.run([ctx.bin, 'version'], { timeoutMs: 5_000 })
    if (r.exitCode !== 0) throw new Error('exit ' + r.exitCode + (r.stderr ? ': ' + r.stderr.trim().slice(0, 200) : ''))
    ctx.version = r.stdout.trim()
  } catch (err) {
    return unavailable($, ctx, ctx.bin + ' was not found or does not run (' + String(err) + ')')
  }
  const probe = await scanTexts($, ctx, [PROBE_TEXT])
  if (!probe.ok) {
    return unavailable($, ctx, 'betterleaks runs but its scan failed (' + probe.error + ')' + (ctx.configPath ? '; check configPath' : ''))
  }
  ctx.available = true
  ctx.lastError = undefined
  ctx.detectsProbe = probe.findings.some((f) => f.secret === PROBE_SECRET)
  if (!ctx.detectsProbe) notify($, ctx, 'betterleaks did not detect a test GitHub token; check the rules in configPath')
}

/**
 * Makes placeholders the same after a restart when `hashKey` is empty: uses the key in the plugin store, or saves the generated one.
 * (A sensitive `userConfig` row is not in `$.config.list()`, so the setting cannot be written from here.)
 * It runs before the first scan, so the redactor is swapped while it holds nothing.
 */
function loadStoredKey($: EngineInterface, ctx: Ctx): Promise<void> {
  ctx.keyLoad ??= (async () => {
    const generated = ctx.generatedKey
    if (generated === undefined) return
    try {
      const stored = await $.store.get('hashKey')
      if (typeof stored === 'string' && stored !== '') ctx.redactor = createRedactor(keyBytes(stored))
      else await $.store.set('hashKey', generated)
      ctx.keySource = 'store'
    } catch (err) {
      notify($, ctx, 'could not use the saved hashKey, so placeholders change after a restart (' + String(err) + ')')
    }
  })()
  return ctx.keyLoad
}

function withheldRow(v: { kind: 'block'; rules: string } | { kind: 'error'; error: string }): string {
  return v.kind === 'block'
    ? 'block-creds withheld this text because it contains credentials (' + v.rules + ').'
    : 'block-creds could not check this text for credentials, so it was withheld.'
}

/** Records the permission mode a classic hook input reports, for the loop it came from. */
function trackMode(ctx: Ctx, e: { permission_mode?: string | undefined; agent_id?: string | undefined }): void {
  if (typeof e.permission_mode === 'string' && e.permission_mode !== '') ctx.modes.set(e.agent_id ?? MAIN_LOOP, e.permission_mode)
}

/**
 * In auto mode a call that needs approval goes to the auto-mode classifier, a model, and it reads the call as this
 * hook passes it on: with the real values. Such a call is refused instead. A loop whose mode is not known yet (a
 * subagent before its first classic hook) is asked about as auto mode is.
 */
async function autoModeRefusal($: EngineInterface, ctx: Ctx, tool: string, agentId: string | undefined, input: unknown): Promise<string | undefined> {
  const mode = ctx.modes.get(agentId ?? MAIN_LOOP)
  if (mode !== undefined && mode !== 'auto') return undefined
  const check = await $.tool.check({ tool, input })
  if (check.decision !== 'ask') return undefined
  notify($, ctx, 'refused a ' + tool + ' call with a redacted value that auto mode would hand to its classifier')
  return (
    'block-creds refused this call: it uses a redacted value and needs approval, and in auto mode that approval is ' +
    'decided by a classifier model, which would read the real value. Tell the user, who can run it themselves, allow it with a permission rule, or leave auto mode (Shift+Tab). Do not retry the same call.'
  )
}

const DISPLAY_FIELDS: Record<string, readonly string[]> = {
  AssistantMessage: ['text'],
  UserMessage: ['text'],
  ToolUse: ['input', 'output'],
  ToolResult: ['output'],
  CommandOutput: ['text'],
  AskUserQuestion: ['questions'],
}

/** `/block-creds`: what protects this session, what went wrong, and how to fix it. */
async function doctor($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.available !== true) await checkBinary($, ctx)
  let claudeVersion = 'unknown'
  try {
    claudeVersion = (await $.session.version()).version
  } catch {
    // Left as unknown.
  }
  const rules = [...ctx.stats.byRule].map(([rule, n]) => rule + ' x' + n).join(', ')
  const lines = [
    ctx.available === true
      ? 'status: checking everything sent to the model'
      : 'status: NOT WORKING, so prompts, tool results and attachments are withheld (nothing unchecked is sent)',
    'Claude Code: ' + claudeVersion,
    'betterleaks: ' +
      ctx.bin +
      (ctx.version ? ' ' + ctx.version : '') +
      (ctx.available === true ? '' : ' (not available: ' + (ctx.lastError ?? 'not checked yet') + ')'),
    'self-test: ' +
      (ctx.available !== true
        ? 'not passed'
        : ctx.detectsProbe
          ? 'ok (a test GitHub token was detected)'
          : 'betterleaks ran, but did not detect a test GitHub token'),
    'rules: ' +
      (ctx.configPath
        ? 'configPath ' + ctx.configPath
        : "betterleaks' default rules (a project's .betterleaks.toml / .gitleaks.toml, ignore files and BETTERLEAKS_* / GITLEAKS_* variables are not used)"),
    'mode: ' + ctx.mode,
    'restore in tool input: ' + (ctx.restore ? 'on, for ' + RESTORE_TOOLS.join(', ') : 'off'),
    'restore on screen: ' + (ctx.restoreDisplay ? 'on' : 'off'),
    'placeholder key: ' +
      { setting: 'the hashKey setting', store: "generated, kept in the plugin's store", memory: 'generated for this run only' }[ctx.keySource],
    'this session: ' + ctx.stats.redacted + ' redacted, ' + ctx.stats.blocked + ' blocked, ' + ctx.stats.failures + ' scan failures',
    rules ? 'rules hit: ' + rules : 'rules hit: none',
  ]
  const fixes: string[] = []
  if (ctx.available !== true) {
    if (ctx.lastError?.startsWith('configPath')) fixes.push('Set configPath to an absolute path: /plugin, then block-creds, then Configure.')
    else if (ctx.lastError?.includes('scan failed'))
      fixes.push('Run `' + ctx.bin + ' stdin -c <configPath>` in a shell to see why the scan fails, or clear configPath to use the default rules.')
    else {
      fixes.push(
        'Install betterleaks: brew install betterleaks, mise use -g aqua:betterleaks/betterleaks, or go install github.com/betterleaks/betterleaks/v2@latest.',
      )
      fixes.push(
        'If it is installed, Claude Code may not see your PATH (started from an IDE or the desktop app): set betterleaksPath to the full path `which betterleaks` prints, with /plugin, then block-creds, then Configure.',
      )
    }
    fixes.push('After fixing, run /block-creds again (or /reload-plugins).')
  } else if (!ctx.detectsProbe) {
    fixes.push('The rules in configPath may miss common tokens: add `[extend] useDefault = true` to that file.')
  }
  if (fixes.length > 0) lines.push('', 'how to fix:', ...fixes.map((f) => '- ' + f), '- ' + HOW_TO_DISABLE)
  return lines.join('\n')
}

export function register(on: On, options: PluginOptions) {
  const ctx = readCtx(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'block-creds', description: 'Show what block-creds checks, what it redacted or blocked, and how to fix a setup problem' })
    await checkBinary($, ctx)
    await loadStoredKey($, ctx)
    return next(e)
  })

  // Only the drawing changes; the stored messages, and so what the model reads, keep the placeholders.
  on('ui.render', ($, e, next) => {
    const fields = DISPLAY_FIELDS[e.component]
    if (!ctx.restoreDisplay || fields === undefined) return next(e)
    const props = e.props as Record<string, unknown>
    const changed: Record<string, unknown> = {}
    for (const field of fields) {
      if (props[field] === undefined) continue
      const r = ctx.redactor.restoreDeep(props[field])
      if (r.changed) changed[field] = r.value
    }
    if (Object.keys(changed).length === 0) return next(e)
    return next({ ...e, props: { ...props, ...changed } } as typeof e)
  })

  // Slash command arguments can reach a model (`/compact <instructions>`, a question for the model). This mod's
  // own `/block-creds` is answered here too.
  on('command.run', async ($, e, next) => {
    if (e.command === 'block-creds') return { text: await doctor($, ctx) }
    if (LOCAL_COMMANDS.has(e.command) || e.args.trim() === '') return next(e)
    const v = await judge($, ctx, [e.args])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') return next({ ...e, args: ctx.redactor.applyText(e.args, v.mapping) })
    if (v.kind === 'block') return { text: 'block-creds: /' + e.command + ' was not run because its arguments contain credentials (' + v.rules + ').' }
    return { text: 'block-creds could not check the arguments of /' + e.command + ', so it was not run (' + v.error + '). Run /block-creds for how to fix it.' }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    hookFailed($, ctx, next.error.kind)
    return { text: 'block-creds failed while checking the arguments of /' + e.command + ', so it was not run.' }
  })

  // Rows the engine adds to the conversation by itself: `!cmd` (bash mode) and its output arrive here, not at a tool or a prompt.
  // A row cannot be refused, so a blocked or unchecked one is stored with its text replaced.
  on('session.append', async ($, e, next) => {
    if (!APPEND_DOORS.has(e.door)) return next(e)
    const v = await judge($, ctx, collectStrings(e.message.content))
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') {
      const content = appendToLastText(ctx.redactor.applyDeep(e.message.content, v.mapping), v.notice)
      return next({ ...e, message: { ...e.message, content } })
    }
    return next({ ...e, message: { ...e.message, content: replaceText(e.message.content, withheldRow(v)) } })
  }).catch(async ($, e, next) => {
    // Fail closed: the row is stored, so what could not be checked is replaced rather than left as it is.
    hookFailed($, ctx, next.error.kind)
    return next({
      ...e,
      message: { ...e.message, content: replaceText(e.message.content, 'block-creds failed while checking this row, so its text was withheld.') },
    })
  })

  on('prompt.submit', async ($, e, next) => {
    clearNotes($, ctx)
    const v = await judge($, ctx, [e.text, ...(e.context ?? [])])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'error') return { drop: 'block-creds could not check the prompt, so it was not sent (' + v.error + '). Run /block-creds for how to fix it.' }
    if (v.kind === 'block') return { drop: 'block-creds: the prompt contains credentials (' + v.rules + '), so it was not sent' }
    const text = ctx.redactor.applyText(e.text, v.mapping)
    const context = [...(e.context ?? []).map((c) => ctx.redactor.applyText(c, v.mapping)), v.notice]
    return next({ ...e, text, context })
  }).catch(async ($, _e, next) => {
    // Fail closed: a prompt this hook could not check must not be sent.
    hookFailed($, ctx, next.error.kind)
    return { drop: 'block-creds failed while checking the prompt, so it was not sent.' }
  })

  on('prompt.attachment', async ($, e, next) => {
    if (SKIP_ATTACHMENTS.has(e.type)) return next(e)
    const v = await judge($, ctx, [e.text])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'error' || v.kind === 'block') return { text: null }
    return next({ ...e, text: ctx.redactor.applyText(e.text, v.mapping) + '\n\n' + v.notice })
  }).catch(async ($, _e, next) => {
    hookFailed($, ctx, next.error.kind)
    return { text: null }
  })

  on('tool.call', async ($, e, next) => {
    let input: typeof e = e
    if (ctx.restore && RESTORE_TOOL_SET.has(e.tool)) {
      // The model only knows placeholders; the tool needs the real value to work.
      const { tool, tool_use_id, agentId, ...args } = e as Record<string, unknown>
      const restored = ctx.redactor.restoreDeep(args)
      if (restored.changed) {
        const refusal = await autoModeRefusal($, ctx, e.tool, e.agentId, restored.value)
        if (refusal !== undefined) return { deny: refusal }
        const reserved: Record<string, unknown> = { tool }
        if (tool_use_id !== undefined) reserved['tool_use_id'] = tool_use_id
        if (agentId !== undefined) reserved['agentId'] = agentId
        input = { ...reserved, ...restored.value } as typeof e
      }
    }
    return guardResult($, ctx, await next(input))
  }).catch(async ($, _e, next) => {
    // Fail closed: a result this hook could not check must not reach the model.
    hookFailed($, ctx, next.error.kind)
    return { deny: 'block-creds failed while checking this tool result, so it was withheld.' }
  })

  // The permission mode, for `autoModeRefusal`: no call on `$` reads it, but the classic hooks' inputs carry it.
  on('classic.SessionStart', ($, e, next) => {
    trackMode(ctx, e)
    return next(e)
  })
  on('classic.UserPromptSubmit', ($, e, next) => {
    trackMode(ctx, e)
    return next(e)
  })
  on('classic.SubagentStart', ($, e, next) => {
    trackMode(ctx, e)
    return next(e)
  })
  on('classic.PostToolUseFailure', ($, e, next) => {
    trackMode(ctx, e)
    return next(e)
  })
  on('classic.PermissionRequest', ($, e, next) => {
    trackMode(ctx, e)
    return next(e)
  })
  on('classic.PermissionDenied', ($, e, next) => {
    trackMode(ctx, e)
    return next(e)
  })

  // A settings PostToolUse hook can replace what the model reads of a tool's result (`updatedToolOutput`).
  on('classic.PostToolUse', async ($, e, next) => {
    trackMode(ctx, e)
    const out = await next(e)
    if (out.updatedToolOutput === undefined && out.updatedMCPToolOutput === undefined) return out
    const v = await judge($, ctx, [...collectStrings(out.updatedToolOutput), ...collectStrings(out.updatedMCPToolOutput)])
    if (v.kind === 'clean') return out
    if (v.kind === 'redact') {
      return {
        ...out,
        ...(out.updatedToolOutput !== undefined ? { updatedToolOutput: ctx.redactor.applyDeep(out.updatedToolOutput, v.mapping) } : {}),
        ...(out.updatedMCPToolOutput !== undefined ? { updatedMCPToolOutput: ctx.redactor.applyDeep(out.updatedMCPToolOutput, v.mapping) } : {}),
        additionalContext: [...(out.additionalContext ?? []), v.notice],
      }
    }
    // The model reads the tool's own result instead, which `tool.call` checked.
    const { updatedToolOutput, updatedMCPToolOutput, ...rest } = out
    return rest
  }).catch(async ($, e, next) => {
    hookFailed($, ctx, next.error.kind)
    const { updatedToolOutput, updatedMCPToolOutput, ...rest } = await next(e)
    return rest
  })

  // The first user message's context blocks: CLAUDE.md (`claudeMd`) and the like. One scan per block, so only the one at fault is withheld.
  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    const blocks = []
    for (const block of out.blocks) {
      const v = await judge($, ctx, [block.text])
      if (v.kind === 'clean') blocks.push(block)
      else if (v.kind === 'redact') blocks.push({ ...block, text: ctx.redactor.applyText(block.text, v.mapping) + '\n\n' + v.notice })
      else blocks.push({ ...block, text: withheldRow(v) })
    }
    return { ...out, blocks }
  }).catch(async ($, _e, next) => {
    hookFailed($, ctx, next.error.kind)
    return { blocks: [] }
  })

  // System prompt sections (`memory` and the like); cached by the engine, so each is scanned once.
  on('prompt.section', async ($, e, next) => {
    const out = await next(e)
    if (out.text === null) return out
    const v = await judge($, ctx, [out.text])
    if (v.kind === 'clean') return { text: checked(ctx, out.text, out.text) }
    if (v.kind === 'redact') {
      const text = ctx.redactor.applyText(out.text, v.mapping) + '\n\n' + v.notice
      return { text: checked(ctx, text, text) }
    }
    return { text: null }
  }).catch(async ($, _e, next) => {
    hookFailed($, ctx, next.error.kind)
    return { text: null }
  })

  // The whole system prompt: sections no `prompt.section` carried (another plugin's, a flag's) are checked here.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (out.sections.every((s) => ctx.checkedTexts.get(s.text) === s.text)) return out
    const sections = []
    for (const section of out.sections) {
      let text = ctx.checkedTexts.get(section.text)
      if (text === undefined) {
        const v = await judge($, ctx, [section.text])
        if (v.kind === 'error') continue
        text = checked(
          ctx,
          section.text,
          v.kind === 'clean' ? section.text : v.kind === 'redact' ? ctx.redactor.applyText(section.text, v.mapping) + '\n\n' + v.notice : null,
        )
      }
      // A blocked section, or one that could not be checked, is left out.
      if (text !== null) sections.push(text === section.text ? section : { ...section, text })
    }
    return { ...out, sections }
  }).catch(async ($, _e, next) => {
    hookFailed($, ctx, next.error.kind)
    return { sections: [] }
  })

  // A skill's prompt as expanded, `!`cmd`` output included.
  on('skill.prompt', async ($, e, next) => {
    const out = await next(e)
    const v = await judge($, ctx, [out.text])
    if (v.kind === 'clean') return out
    if (v.kind === 'redact') return { text: ctx.redactor.applyText(out.text, v.mapping) + '\n\n' + v.notice }
    return { text: withheldRow(v) }
  }).catch(async ($, _e, next) => {
    hookFailed($, ctx, next.error.kind)
    return { text: 'block-creds failed while checking this skill prompt, so it was withheld.' }
  })

  // What the summarizer is told to keep (`/compact <instructions>`, a plugin's); the conversation itself was checked on the way in.
  on('session.compact', async ($, e, next) => {
    if (e.instructions === undefined || e.instructions.trim() === '') return next(e)
    const v = await judge($, ctx, [e.instructions])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') return next({ ...e, instructions: ctx.redactor.applyText(e.instructions, v.mapping) })
    return next({ ...e, instructions: withheldRow(v) })
  }).catch(async ($, e, next) => {
    if (next.called || e.instructions === undefined) return next(e)
    hookFailed($, ctx, next.error.kind)
    return next({ ...e, instructions: 'block-creds failed while checking the compaction instructions, so they were withheld.' })
  })

  // Deliveries from outside the conversation: another agent's message, Remote Control, a relay's event.
  on('session.receive', async ($, e, next) => {
    const v = await judge($, ctx, [e.text])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') return next({ ...e, text: ctx.redactor.applyText(e.text, v.mapping) + '\n\n' + v.notice })
    return { consumed: withheldRow(v) }
  }).catch(async ($, _e, next) => {
    hookFailed($, ctx, next.error.kind)
    return { consumed: 'block-creds failed while checking this delivery, so it was withheld.' }
  })

  // Messages leaving for another agent or session, whose model reads them (another process may not run this mod).
  on('session.send', async ($, e, next) => {
    const v = await judge($, ctx, [e.text])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') return next({ ...e, text: ctx.redactor.applyText(e.text, v.mapping) + '\n\n' + v.notice })
    return { isDelivered: false, reason: withheldRow(v) }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    hookFailed($, ctx, next.error.kind)
    return { isDelivered: false, reason: 'block-creds failed while checking this message, so it was not sent.' }
  })

  // Other plugins' own model calls.
  on('model.complete', async ($, e, next) => {
    const v = await judge($, ctx, [e.prompt, ...(e.system !== undefined ? [e.system] : [])])
    if (v.kind === 'clean') return next(e)
    if (v.kind !== 'redact') return { deny: withheldRow(v) }
    const apply = (s: string) => ctx.redactor.applyText(s, v.mapping)
    return next({
      ...e,
      prompt: apply(e.prompt),
      ...(e.system !== undefined ? { system: apply(e.system) } : {}),
      ...(e.promptBlocks !== undefined ? { promptBlocks: ctx.redactor.applyDeep(e.promptBlocks, v.mapping) } : {}),
      ...(e.systemBlocks !== undefined ? { systemBlocks: ctx.redactor.applyDeep(e.systemBlocks, v.mapping) } : {}),
    })
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    hookFailed($, ctx, next.error.kind)
    return { deny: 'block-creds failed while checking this model request, so it was not sent.' }
  })

  on('model.fork', async ($, e, next) => {
    const v = await judge($, ctx, [e.prompt])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') return next({ ...e, prompt: ctx.redactor.applyText(e.prompt, v.mapping) })
    return { deny: withheldRow(v) }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    hookFailed($, ctx, next.error.kind)
    return { deny: 'block-creds failed while checking this model request, so it was not sent.' }
  })

  on('model.classify', async ($, e, next) => {
    const v = await judge($, ctx, [e.text])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'redact') return next({ ...e, text: ctx.redactor.applyText(e.text, v.mapping) })
    return { deny: withheldRow(v) }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    hookFailed($, ctx, next.error.kind)
    return { deny: 'block-creds failed while checking this model request, so it was not sent.' }
  })
}

/** Remembers what is sent for a system prompt text (`sent` itself when it passes), so `prompt.compose` does not scan it again. */
function checked(ctx: Ctx, text: string, sent: string | null): string | null {
  if (ctx.checkedTexts.size > 500) ctx.checkedTexts.clear()
  ctx.checkedTexts.set(text, sent)
  if (sent !== null) ctx.checkedTexts.set(sent, sent)
  return sent
}
