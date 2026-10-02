import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { collectStrings, createRedactor, keyBytes, toHex, type Mapping, type Redactor } from './redactor.ts'
import { buildArgv, interpret, MIN_SCAN_LENGTH, type Finding, type ScanOutcome } from './scanner.ts'

const SCAN_TIMEOUT_MS = 15_000

// Attachments the engine writes itself and that never carry file or tool content.
const SKIP_ATTACHMENTS = new Set([
  'todo_reminder',
  'plan_mode',
  'plan_mode_exit',
  'auto_mode',
  'auto_mode_exit',
  'skill_listing',
  'deferred_tools_delta',
])

type Mode = 'redact' | 'block'
type FailMode = 'closed' | 'open'

type Ctx = {
  mode: Mode
  failMode: FailMode
  bin: string
  configPath: string | undefined
  restore: boolean
  restoreDisplay: boolean
  /** A key made because `hashKey` was empty; it is saved to the setting on session start. */
  generatedKey: string | undefined
  redactor: Redactor
  stats: { redacted: number; blocked: number; failures: number; byRule: Map<string, number> }
  version: string | undefined
}

type Verdict =
  | { kind: 'clean' }
  | { kind: 'redact'; mapping: Mapping; rules: string }
  | { kind: 'block'; rules: string }
  | { kind: 'error'; error: string }

function readCtx(options: PluginOptions): Ctx {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  const configuredKey = str(options['hashKey'])
  const generatedKey = configuredKey === undefined ? toHex(crypto.getRandomValues(new Uint8Array(32))) : undefined
  return {
    mode: options['mode'] === 'block' ? 'block' : 'redact',
    failMode: options['failMode'] === 'open' ? 'open' : 'closed',
    bin: str(options['betterleaksPath']) ?? 'betterleaks',
    configPath: str(options['configPath']),
    restore: options['restoreInToolInput'] !== false,
    restoreDisplay: options['restoreInDisplay'] !== false,
    generatedKey,
    redactor: createRedactor(keyBytes(configuredKey ?? generatedKey)),
    stats: { redacted: 0, blocked: 0, failures: 0, byRule: new Map() },
    version: undefined,
  }
}

async function scanTexts($: EngineInterface, ctx: Ctx, texts: readonly string[]): Promise<ScanOutcome> {
  const joined = texts.join('\n\n')
  if (joined.trim().length < MIN_SCAN_LENGTH) return { ok: true, findings: [] }
  try {
    const r = await $.process.run(buildArgv(ctx.bin, ctx.configPath), { stdin: joined, timeoutMs: SCAN_TIMEOUT_MS })
    return interpret(r.exitCode, r.stdout, r.stderr)
  } catch (err) {
    return { ok: false, error: 'could not run ' + ctx.bin + ': ' + String(err) }
  }
}

function notify($: EngineInterface, text: string): void {
  try {
    $.ui.toast('block-creds: ' + text)
  } catch {
    // Nothing draws here (for example claude -p); the verdict still applies.
  }
}

function record(ctx: Ctx, findings: readonly Finding[], kind: 'redacted' | 'blocked'): string {
  const rules = [...new Set(findings.map((f) => f.ruleId))]
  const secrets = new Set(findings.map((f) => f.secret)).size
  ctx.stats[kind] += secrets
  for (const f of findings) ctx.stats.byRule.set(f.ruleId, (ctx.stats.byRule.get(f.ruleId) ?? 0) + 1)
  return rules.join(', ')
}

/** Scans the texts and decides what has to happen to them. */
async function judge($: EngineInterface, ctx: Ctx, texts: readonly string[]): Promise<Verdict> {
  const out = await scanTexts($, ctx, texts)
  if (!out.ok) {
    ctx.stats.failures += 1
    if (ctx.failMode === 'open') {
      notify($, 'scan failed, sent as is (' + out.error + ')')
      return { kind: 'clean' }
    }
    notify($, 'scan failed, withheld (' + out.error + ')')
    return { kind: 'error', error: out.error }
  }
  if (out.findings.length === 0) return { kind: 'clean' }
  if (ctx.mode === 'block') {
    const rules = record(ctx, out.findings, 'blocked')
    notify($, 'blocked (' + rules + ')')
    return { kind: 'block', rules }
  }
  const rules = record(ctx, out.findings, 'redacted')
  const before = ctx.redactor.known()
  const mapping = await ctx.redactor.mapping(out.findings.map((f) => f.secret))
  // Rows drawn before this value was known (a resumed session) can show it now.
  if (ctx.restoreDisplay && ctx.redactor.known() > before) {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // Nothing draws here; the verdict still applies.
    }
  }
  notify($, 'redacted ' + mapping.length + ' value(s) (' + rules + ')')
  return { kind: 'redact', mapping, rules }
}

/** What the model reads in place of a tool result that held credentials. */
async function guardResult($: EngineInterface, ctx: Ctx, res: any) {
  if (typeof res.deny === 'string') return res
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
    return { deny: typeof res.text === 'string' ? ctx.redactor.applyText(res.text, v.mapping) : 'The tool failed.' }
  }
  const out: { result: unknown; context?: string[] } = { result: ctx.redactor.applyDeep(res.result, v.mapping) }
  if (Array.isArray(res.context)) out.context = res.context.map((c: string) => ctx.redactor.applyText(c, v.mapping))
  return out
}

async function checkBinary($: EngineInterface, ctx: Ctx): Promise<void> {
  try {
    const r = await $.process.run([ctx.bin, 'version'], { timeoutMs: 5_000 })
    if (r.exitCode !== 0) throw new Error('exit ' + r.exitCode)
    ctx.version = r.stdout.trim()
  } catch {
    notify($, ctx.bin + ' was not found or does not run. Install betterleaks (' + (ctx.failMode === 'closed' ? 'prompts and tool results are withheld until then' : 'nothing is checked until then') + ').')
  }
}

/** Keeps a generated key in the `hashKey` setting so placeholders stay the same after a restart. */
async function saveGeneratedKey($: EngineInterface, ctx: Ctx): Promise<void> {
  const value = ctx.generatedKey
  if (value === undefined) return
  try {
    const row = (await $.config.list()).find((r) => r.key.endsWith('.hashKey'))
    if (row === undefined) throw new Error('no hashKey row')
    const r = await $.config.set({ key: row.key, value })
    if (r.deny !== undefined) throw new Error(r.deny)
  } catch (err) {
    notify($, 'could not save the generated hashKey, so placeholders change after a restart (' + String(err) + ')')
  }
}

const DISPLAY_FIELDS: Record<string, readonly string[]> = {
  AssistantMessage: ['text'],
  UserMessage: ['text'],
  ToolUse: ['input', 'output'],
  ToolResult: ['output'],
  CommandOutput: ['text'],
  AskUserQuestion: ['questions'],
}

function summary(ctx: Ctx): string {
  const rules = [...ctx.stats.byRule].map(([rule, n]) => rule + ' x' + n).join(', ')
  return [
    'mode: ' + ctx.mode + ', on scan failure: ' + ctx.failMode,
    'betterleaks: ' + ctx.bin + (ctx.version ? ' ' + ctx.version : ' (not checked or not found)') + (ctx.configPath ? ', config ' + ctx.configPath : ''),
    'this session: ' + ctx.stats.redacted + ' redacted, ' + ctx.stats.blocked + ' blocked, ' + ctx.stats.failures + ' scan failures',
    rules ? 'rules hit: ' + rules : 'rules hit: none',
  ].join('\n')
}

export function register(on: On, options: PluginOptions) {
  const ctx = readCtx(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'block-creds', description: 'Show what block-creds redacted or blocked in this session' })
    await checkBinary($, ctx)
    await saveGeneratedKey($, ctx)
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

  on('command.run', { command: 'block-creds' }, async () => ({ text: summary(ctx) }))

  on('prompt.submit', async ($, e, next) => {
    const v = await judge($, ctx, [e.text, ...(e.context ?? [])])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'error') return { drop: 'block-creds could not check the prompt, so it was not sent (' + v.error + ')' }
    if (v.kind === 'block') return { drop: 'block-creds: the prompt contains credentials (' + v.rules + '), so it was not sent' }
    const text = ctx.redactor.applyText(e.text, v.mapping)
    if (e.context === undefined) return next({ ...e, text })
    return next({ ...e, text, context: e.context.map((c) => ctx.redactor.applyText(c, v.mapping)) })
  })

  on('prompt.attachment', async ($, e, next) => {
    if (SKIP_ATTACHMENTS.has(e.type)) return next(e)
    const v = await judge($, ctx, [e.text])
    if (v.kind === 'clean') return next(e)
    if (v.kind === 'error' || v.kind === 'block') return { text: null }
    return next({ ...e, text: ctx.redactor.applyText(e.text, v.mapping) })
  })

  on('tool.call', async ($, e, next) => {
    let input: typeof e = e
    if (ctx.restore) {
      // The model only knows placeholders; the tool needs the real value to work.
      const { tool, tool_use_id, agentId, ...args } = e as Record<string, unknown>
      const restored = ctx.redactor.restoreDeep(args)
      if (restored.changed) {
        const reserved: Record<string, unknown> = { tool }
        if (tool_use_id !== undefined) reserved['tool_use_id'] = tool_use_id
        if (agentId !== undefined) reserved['agentId'] = agentId
        input = { ...reserved, ...restored.value } as typeof e
      }
    }
    return guardResult($, ctx, await next(input))
  }).catch(async () => ({
    // Fail closed: a result this hook could not check must not reach the model.
    deny: 'block-creds failed while checking this tool result, so it was withheld.',
  }))
}
