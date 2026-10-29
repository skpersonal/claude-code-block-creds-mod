import { expect, test } from 'claude-code/testing'
import { createRedactor, keyBytes } from '../hooks/redactor.ts'

const TOKEN = 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A'
const PLACEHOLDER = /\[REDACTED-[0-9a-f]{12}\]/
const ORIGIN = { kind: 'composer' } as const

type Stubs = { toasts: string[]; statuses: (string | undefined)[]; scans: number }

// Stands in for betterleaks: it "finds" TOKEN in whatever is piped to it.
function fakeBetterleaks(on: any, initial: 'works' | 'missing' = 'works'): Stubs & { behaviour: 'works' | 'missing' } {
  const seen = { toasts: [], statuses: [], scans: 0, behaviour: initial } as Stubs & { behaviour: 'works' | 'missing' }
  on('process.run', ($: any, e: any) => {
    if (seen.behaviour === 'missing') return { deny: 'spawn betterleaks ENOENT' }
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '1.7.4\n', stderr: '' } }
    seen.scans += 1
    const stdin: string = e.init?.stdin ?? ''
    // Like the real thing, a secret directly followed by `<` is not found (`…key</bash-stdout>`).
    const hits = stdin.includes(TOKEN) && !stdin.includes(TOKEN + '<') ? [{ RuleID: 'github-pat', Secret: TOKEN }] : []
    return { value: { exitCode: hits.length > 0 ? 1 : 0, stdout: JSON.stringify(hits), stderr: '' } }
  })
  on('ui.toast', ($: any, e: any) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('a prompt with a token is sent with a placeholder instead', async ($, on) => {
  fakeBetterleaks(on)
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text, ...(e.context ?? []))
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'use ' + TOKEN + ' please', context: ['ctx ' + TOKEN], wait: false, origin: ORIGIN })
  // text, the redacted context, and the notice for the model
  expect(reached.length).toBe(3)
  for (const t of reached) {
    expect(t.includes(TOKEN)).toBe(false)
    expect(t).toMatch(PLACEHOLDER)
  }
  // Same secret, same placeholder, in the text and in the context
  expect(reached[0]?.match(PLACEHOLDER)?.[0]).toBe(reached[1]?.match(PLACEHOLDER)?.[0])
  expect(reached[2]).toContain('block-creds (a credential filter)')
  expect(reached[2]).toContain('github-pat')
})

test('a clean prompt gets no notice', async ($, on) => {
  fakeBetterleaks(on)
  const reached: any[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'list the files in this directory', wait: false, origin: ORIGIN })
  expect(reached[0].context).toBeUndefined()
})

test('a redacted tool result carries a notice for the model', async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  expect(out.context.length).toBe(1)
  expect(out.context[0]).toContain('block-creds (a credential filter)')
  expect(out.context[0]).toContain(out.result.file.content)
  expect(out.context[0]).toContain('github-pat')
  expect(out.context[0]).toContain('arguments of Bash, PowerShell, Write, Edit, NotebookEdit, Read, Grep, Glob: it is swapped for the real value')
  expect(out.context[0]).toContain('The user sees the real values on their screen')
  expect(JSON.stringify(out).includes(TOKEN)).toBe(false)
})

test('the notice says the user sees placeholders when restoreInDisplay=false', { options: { restoreInDisplay: false } }, async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  expect(out.context[0]).toContain('The user also sees the placeholders')
  expect(out.context[0]).not.toContain('sees the real values')
})

test('the notice says placeholders are literal when restoreInToolInput=false', { options: { restoreInToolInput: false } }, async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  expect(out.context[0]).toContain('receive the placeholder text literally')
  expect(out.context[0]).not.toContain('swapped for the real value')
})

test('a clean tool result gets no notice', async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: 'plain text, nothing secret' } }, text: 'plain text, nothing secret' }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/a.txt' })
  expect(out.context).toBeUndefined()
})

test('a clean prompt goes through untouched', async ($, on) => {
  fakeBetterleaks(on)
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'list the files in this directory', wait: false, origin: ORIGIN })
  expect(reached).toEqual(['list the files in this directory'])
})

test('the redaction notice stays on the status line until the next prompt', { options: { hashKey: 'test-key' } }, async ($, on) => {
  const seen = fakeBetterleaks(on)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'use ' + TOKEN + ' please', wait: false, origin: ORIGIN })
  expect(seen.statuses.length).toBe(1)
  expect(seen.statuses[0]).toContain('redacted 1 value(s)')
  expect(seen.statuses[0]?.includes(TOKEN)).toBe(false)
  await $.prompt.submit({ text: 'list the files in this directory', wait: false, origin: ORIGIN })
  expect(seen.statuses.length).toBe(2)
  expect(seen.statuses[1]).toBe(undefined)
})

test('block mode drops a prompt with a token', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  let reached = false
  on('prompt.submit', ($: any, e: any) => {
    reached = true
    return { text: e.text }
  })
  const out: any = await $.prompt.submit({ text: 'use ' + TOKEN, wait: false, origin: ORIGIN })
  expect(typeof out.drop).toBe('string')
  expect(out.drop.includes(TOKEN)).toBe(false)
  expect(reached).toBe(false)
})

test('when betterleaks cannot run, the prompt is dropped (fail closed)', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  let reached = false
  on('prompt.submit', ($: any, e: any) => {
    reached = true
    return { text: e.text }
  })
  const out: any = await $.prompt.submit({ text: 'something longer than eight characters', wait: false, origin: ORIGIN })
  expect(typeof out.drop).toBe('string')
  expect(reached).toBe(false)
})

test('while betterleaks cannot run, even a short prompt is dropped', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  const out: any = await $.prompt.submit({ text: 'hi', wait: false, origin: ORIGIN })
  expect(typeof out.drop).toBe('string')
  expect(reached).toEqual([])
})

test('while betterleaks cannot run, an attachment is dropped', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  on('prompt.attachment', ($: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({ type: 'file', text: 'hi', origin: { kind: 'engine' } } as any)
  expect(out.text).toBe(null)
})

test('sending resumes once betterleaks runs again', async ($, on) => {
  const stub = fakeBetterleaks(on, 'missing')
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  const first: any = await $.prompt.submit({ text: 'hi', wait: false, origin: ORIGIN })
  expect(typeof first.drop).toBe('string')
  stub.behaviour = 'works'
  await $.prompt.submit({ text: 'hi', wait: false, origin: ORIGIN })
  expect(reached).toEqual(['hi'])
})

test('a tool result with a token reaches the model with a placeholder, same shape', async ($, on) => {
  fakeBetterleaks(on)
  const content = 'GITHUB_TOKEN=' + TOKEN + '\nOTHER=1'
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content, numLines: 2 } }, text: content }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  expect(JSON.stringify(out).includes(TOKEN)).toBe(false)
  expect(out.result.file.content).toMatch(PLACEHOLDER)
  expect(out.result.file.numLines).toBe(2)
  expect(out.result.type).toBe('text')
})

test('a tool result whose secret is not in `result` as found is withheld, not passed through', async ($, on) => {
  fakeBetterleaks(on)
  // Like Read: `text` carries line numbers, so a multi-line secret found there is not in `result.file.content` as it is.
  const content = TOKEN.slice(0, 20) + '\n' + TOKEN.slice(20)
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content } }, text: TOKEN }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/key.pem' })
  expect(typeof out.deny).toBe('string')
  expect(out.deny).toContain('could not be replaced')
  expect(out.result).toBe(undefined)
  expect(JSON.stringify(out).includes(TOKEN.slice(0, 20))).toBe(false)
})

test('a placeholder in a tool call is turned back into the real value, in memory only', async ($, on) => {
  fakeBetterleaks(on)
  on('classic.UserPromptSubmit', () => ({}))
  const calls: any[] = []
  let first = true
  on('tool.call', ($: any, e: any) => {
    calls.push(e)
    if (!first) return { ref: 2, result: { stdout: 'ok', stderr: '' }, text: 'ok' }
    first = false
    return { ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }
  })
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'default' })
  const read: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  const placeholder = read.result.file.content as string
  expect(placeholder).toMatch(PLACEHOLDER)
  await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: token ' + placeholder + '" https://api.github.com' })
  expect(calls[1].command.includes(TOKEN)).toBe(true)
  expect(calls[1].command.includes('REDACTED')).toBe(false)
})

test('restoreInToolInput=false leaves the placeholder in the tool call', { options: { restoreInToolInput: false } }, async ($, on) => {
  fakeBetterleaks(on)
  const calls: any[] = []
  on('tool.call', ($: any, e: any) => {
    calls.push(e)
    return { ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }
  })
  const read: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  await $.tool.call({ tool: 'Bash', command: 'echo ' + read.result.file.content })
  expect(calls[1].command.includes(TOKEN)).toBe(false)
})

test('a failed tool call that printed a token is redacted too', async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ ref: 1, isError: true, result: 'boom ' + TOKEN, text: 'boom ' + TOKEN }))
  const out: any = await $.tool.call({ tool: 'Bash', command: 'false' })
  expect(typeof out.deny).toBe('string')
  expect(out.deny.includes(TOKEN)).toBe(false)
  expect(out.deny).toMatch(PLACEHOLDER)
  expect(out.deny).toContain('block-creds (a credential filter)')
})

test('block mode denies a tool result with a token', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  expect(typeof out.deny).toBe('string')
  expect(JSON.stringify(out).includes(TOKEN)).toBe(false)
})

test('a tool result that cannot be checked is withheld (fail closed)', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: 'plenty of text here' } }, text: 'plenty of text here' }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/a.txt' })
  expect(typeof out.deny).toBe('string')
  expect(JSON.stringify(out).includes('plenty')).toBe(false)
})

test('an attachment is redacted, or dropped in block mode', async ($, on) => {
  fakeBetterleaks(on)
  on('prompt.attachment', ($: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({ type: 'file', text: 'TOKEN=' + TOKEN, origin: { kind: 'engine' } } as any)
  expect(out.text.includes(TOKEN)).toBe(false)
  expect(out.text).toMatch(PLACEHOLDER)
  expect(out.text).toContain('block-creds (a credential filter)')
})

test('block mode drops an attachment with a token', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  on('prompt.attachment', ($: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({ type: 'file', text: 'TOKEN=' + TOKEN, origin: { kind: 'engine' } } as any)
  expect(out.text).toBe(null)
})

test('/block-creds reports what happened', async ($, on) => {
  fakeBetterleaks(on)
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'use ' + TOKEN, wait: false, origin: ORIGIN })
  const out: any = await $.command.run({ command: 'block-creds', args: '' } as any)
  expect(out.text).toMatch(/1 redacted, 0 blocked, 0 scan failures/)
  expect(out.text).toMatch(/github-pat x1/)
  expect(out.text).toMatch(/1\.7\.4/)
})

// Makes the mod learn TOKEN's placeholder, as a Read result would.
async function learnPlaceholder($: any, on: any): Promise<string> {
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }))
  const read: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  return read.result.file.content as string
}

function recordRender(on: any): any[] {
  const seen: any[] = []
  on('ui.render', ($: any, e: any) => {
    seen.push(e.props)
    return { type: 'engine', ref: 0 }
  })
  return seen
}

test('the screen shows the real value, in text and in nested tool data', async ($, on) => {
  fakeBetterleaks(on)
  const seen = recordRender(on)
  const placeholder = await learnPlaceholder($, on)
  await $.ui.render({
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text: 'key is ' + placeholder, isFirstOfReply: true },
  } as any)
  await $.ui.render({
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 't1',
    props: { tool_use_id: 't1', tool: 'Read', output: { file: { content: placeholder } }, isErrored: false },
  } as any)
  expect(seen[0].text).toBe('key is ' + TOKEN)
  expect(seen[0].isFirstOfReply).toBe(true)
  expect(seen[1].output.file.content).toBe(TOKEN)
  expect(seen[1].tool).toBe('Read')
})

test('an unknown placeholder stays as it is on screen', async ($, on) => {
  fakeBetterleaks(on)
  const seen = recordRender(on)
  const unknown = '[REDACTED-000000000000]'
  await $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'm1', props: { text: unknown, isFirstOfReply: false } } as any)
  expect(seen[0].text).toBe(unknown)
})

test('restoreInDisplay=false keeps placeholders on screen', { options: { restoreInDisplay: false } }, async ($, on) => {
  fakeBetterleaks(on)
  const seen = recordRender(on)
  const placeholder = await learnPlaceholder($, on)
  await $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'm1', props: { text: placeholder, isFirstOfReply: false } } as any)
  expect(seen[0].text).toBe(placeholder)
})

test('a generated hashKey is kept in the plugin store on session start', async ($, on) => {
  fakeBetterleaks(on)
  const sets: any[] = []
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', (() => ({ value: undefined })) as any)
  on('store.set', (($: any, e: any) => {
    sets.push(e)
    return { value: undefined }
  }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(sets.length).toBe(1)
  expect(sets[0].key).toBe('hashKey')
  expect(sets[0].value).toMatch(/^[0-9a-f]{64}$/)
})

test('a stored hashKey decides the placeholder and is not overwritten', async ($, on) => {
  fakeBetterleaks(on)
  const sets: any[] = []
  const sent: string[] = []
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', (() => ({ value: 'stored-key' })) as any)
  on('store.set', (($: any, e: any) => {
    sets.push(e)
    return { value: undefined }
  }) as any)
  on('prompt.submit', ($: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'token ' + TOKEN, wait: false, origin: ORIGIN })
  expect(sets.length).toBe(0)
  const expected = (await createRedactor(keyBytes('stored-key')).mapping([TOKEN]))[0]?.[1]
  expect(expected).toMatch(PLACEHOLDER)
  expect(sent[0]).toContain(expected as string)
})

test('a configured hashKey does not touch the store', { options: { hashKey: 'my-key' } }, async ($, on) => {
  fakeBetterleaks(on)
  const calls: string[] = []
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', (() => {
    calls.push('get')
    return { value: undefined }
  }) as any)
  on('store.set', (() => {
    calls.push('set')
    return { value: undefined }
  }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(calls.length).toBe(0)
})

test('a failed key save only warns', async ($, on) => {
  const seen = fakeBetterleaks(on)
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', (() => ({ deny: 'nope' })) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.toasts.some((t) => t.includes('could not use the saved hashKey'))).toBe(true)
})

test('a new secret redraws old rows, a known one does not', async ($, on) => {
  fakeBetterleaks(on)
  let invalidations = 0
  on('ui.invalidate', (() => {
    invalidations += 1
    return { value: undefined }
  }) as any)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'use ' + TOKEN, wait: false, origin: ORIGIN })
  await $.prompt.submit({ text: 'again ' + TOKEN, wait: false, origin: ORIGIN })
  expect(invalidations).toBe(1)
})

// A `!cmd` row: the engine appends it to the conversation without a tool call or a prompt.
function bashRow(text: string, door: string = 'command'): any {
  return {
    door,
    origin: { kind: 'unclassified' },
    uuid: 'row-1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
  }
}

test('bash mode output with a token is stored with a placeholder and a notice', async ($, on) => {
  fakeBetterleaks(on)
  const stored: any[] = [((await $.session.append(bashRow('<bash-stdout>GITHUB_TOKEN=' + TOKEN + '</bash-stdout>'))) as any).message]
  const text: string = stored[0].content[0].text
  expect(text.includes(TOKEN)).toBe(false)
  expect(text).toMatch(PLACEHOLDER)
  expect(text).toContain('block-creds (a credential filter)')
})

test('bash mode output without a token is stored as it is', async ($, on) => {
  fakeBetterleaks(on)
  const stored: any[] = [((await $.session.append(bashRow('<bash-stdout>nothing secret in here</bash-stdout>'))) as any).message]
  expect(stored[0].content[0].text).toBe('<bash-stdout>nothing secret in here</bash-stdout>')
})

test('block mode stores bash mode output with a token as a withheld notice', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  const stored: any[] = [((await $.session.append(bashRow('<bash-stdout>GITHUB_TOKEN=' + TOKEN + '</bash-stdout>'))) as any).message]
  const text: string = stored[0].content[0].text
  expect(text.includes(TOKEN)).toBe(false)
  expect(text).toContain('withheld')
})

test('bash mode output that cannot be checked is stored withheld (fail closed)', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  const stored: any[] = [((await $.session.append(bashRow('<bash-stdout>GITHUB_TOKEN=' + TOKEN + '</bash-stdout>'))) as any).message]
  const text: string = stored[0].content[0].text
  expect(text.includes(TOKEN)).toBe(false)
  expect(text).toContain('withheld')
})

test('rows of other doors are not scanned', async ($, on) => {
  const stub = fakeBetterleaks(on)
  const stored: any[] = [((await $.session.append(bashRow('GITHUB_TOKEN=' + TOKEN, 'response'))) as any).message]
  expect(stub.scans).toBe(0)
  expect(stored[0].content[0].text).toContain(TOKEN)
})

// Stands in for betterleaks with its own idea of what is found; `version` always works.
function scriptedBetterleaks(on: any, find: (stdin: string) => Array<{ RuleID: string; Secret: string }>): void {
  on('process.run', ($: any, e: any) => {
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '1.9.0\n', stderr: '' } }
    const hits = find(e.init?.stdin ?? '')
    return { value: { exitCode: hits.length > 0 ? 1 : 0, stdout: JSON.stringify(hits), stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
}

// Like betterleaks' decoding: the base64 form is found, and the decoded value is what it reports.
const ENCODED = btoa('token=' + TOKEN)
const decoding = (stdin: string) => (stdin.includes(ENCODED) ? [{ RuleID: 'github-pat', Secret: TOKEN }] : [])

test('a prompt whose secret was found decoded is dropped, not sent as it is', async ($, on) => {
  scriptedBetterleaks(on, decoding)
  let reached = false
  on('prompt.submit', ($: any, e: any) => {
    reached = true
    return { text: e.text }
  })
  const out: any = await $.prompt.submit({ text: 'data: ' + ENCODED, wait: false, origin: ORIGIN })
  expect(typeof out.drop).toBe('string')
  expect(reached).toBe(false)
})

test('an attachment whose secret was found decoded is dropped', async ($, on) => {
  scriptedBetterleaks(on, decoding)
  on('prompt.attachment', ($: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({ type: 'file', text: 'data: ' + ENCODED, origin: { kind: 'engine' } } as any)
  expect(out.text).toBe(null)
})

test('bash mode output whose secret was found decoded is stored withheld', async ($, on) => {
  scriptedBetterleaks(on, decoding)
  const stored: any = ((await $.session.append(bashRow('<bash-stdout>' + ENCODED + '</bash-stdout>'))) as any).message
  expect(stored.content[0].text.includes(ENCODED)).toBe(false)
  expect(stored.content[0].text).toContain('withheld')
})

test('a value redacted once is redacted again where betterleaks no longer finds it', async ($, on) => {
  // Found only with its variable name in front, as a bare value printed by `echo` is not.
  scriptedBetterleaks(on, (stdin) => (stdin.includes('GITHUB_TOKEN=' + TOKEN) ? [{ RuleID: 'github-pat', Secret: TOKEN }] : []))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ ref: 1, result: { stdout: TOKEN, stderr: '' }, text: TOKEN }))
  await $.prompt.submit({ text: 'GITHUB_TOKEN=' + TOKEN, wait: false, origin: ORIGIN })
  const out: any = await $.tool.call({ tool: 'Bash', command: 'echo $GITHUB_TOKEN' })
  expect(JSON.stringify(out).includes(TOKEN)).toBe(false)
  expect(out.result.stdout).toMatch(PLACEHOLDER)
  expect(out.context[0]).toContain('known')
})

test('a placeholder in a subagent prompt or a message to another agent stays a placeholder', async ($, on) => {
  fakeBetterleaks(on)
  const calls: any[] = []
  on('tool.call', ($: any, e: any) => {
    calls.push(e)
    return { ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }
  })
  const read: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  const placeholder = read.result.file.content as string
  await $.tool.call({ tool: 'Agent', description: 'use it', prompt: 'call the API with ' + placeholder } as any)
  await $.tool.call({ tool: 'SendMessage', to: 'worker', message: 'the key is ' + placeholder } as any)
  expect(calls[1].prompt).toContain(placeholder)
  expect(calls[2].message).toContain(placeholder)
  expect(JSON.stringify(calls.slice(1)).includes(TOKEN)).toBe(false)
})

test('a refusal from beneath that quotes a token is redacted', async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ deny: 'policy refused: curl -H "Authorization: token ' + TOKEN + '"' }))
  const out: any = await $.tool.call({ tool: 'Bash', command: 'curl' })
  expect(typeof out.deny).toBe('string')
  expect(out.deny.includes(TOKEN)).toBe(false)
  expect(out.deny).toMatch(PLACEHOLDER)
})

test('a clean refusal from beneath is passed on as it is', async ($, on) => {
  fakeBetterleaks(on)
  on('tool.call', () => ({ deny: 'the user refused this call' }))
  const out: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(out.deny).toBe('the user refused this call')
})

const CONTEXT_BLOCKS = [
  { name: 'claudeMd', text: 'Contents of CLAUDE.md:\nGITHUB_TOKEN=' + TOKEN },
  { name: 'currentDate', text: "Today's date is 2026-10-29." },
]

test('CLAUDE.md in the context blocks is redacted, the other blocks kept', async ($, on) => {
  fakeBetterleaks(on)
  on('prompt.context', () => ({ blocks: CONTEXT_BLOCKS }))
  const out: any = await $.prompt.context({ blocks: CONTEXT_BLOCKS })
  expect(JSON.stringify(out).includes(TOKEN)).toBe(false)
  expect(out.blocks[0].text).toMatch(PLACEHOLDER)
  expect(out.blocks[0].text).toContain('block-creds (a credential filter)')
  expect(out.blocks[1]).toEqual(CONTEXT_BLOCKS[1])
})

test('block mode withholds only the context block with a token', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  on('prompt.context', () => ({ blocks: CONTEXT_BLOCKS }))
  const out: any = await $.prompt.context({ blocks: CONTEXT_BLOCKS })
  expect(out.blocks[0].text).toContain('withheld')
  expect(out.blocks[1]).toEqual(CONTEXT_BLOCKS[1])
})

test('context blocks that cannot be checked are withheld (fail closed)', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  on('prompt.context', () => ({ blocks: CONTEXT_BLOCKS }))
  const out: any = await $.prompt.context({ blocks: CONTEXT_BLOCKS })
  expect(JSON.stringify(out).includes(TOKEN)).toBe(false)
  for (const b of out.blocks) expect(b.text).toContain('withheld')
})

test('a system prompt section with a token is redacted, or left out in block mode', async ($, on) => {
  fakeBetterleaks(on)
  on('prompt.section', () => ({ text: 'memory: GITHUB_TOKEN=' + TOKEN }))
  const out: any = await $.prompt.section({ name: 'memory', text: null })
  expect(out.text.includes(TOKEN)).toBe(false)
  expect(out.text).toMatch(PLACEHOLDER)
})

test('block mode leaves a section with a token out', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  on('prompt.section', () => ({ text: 'memory: GITHUB_TOKEN=' + TOKEN }))
  const out: any = await $.prompt.section({ name: 'memory', text: null })
  expect(out.text).toBe(null)
})

test('a skill prompt with a token is redacted', async ($, on) => {
  fakeBetterleaks(on)
  on('skill.prompt', () => ({ text: 'env output: GITHUB_TOKEN=' + TOKEN }))
  const out: any = await $.skill.prompt({ skill: 'deploy', text: '' })
  expect(out.text.includes(TOKEN)).toBe(false)
  expect(out.text).toMatch(PLACEHOLDER)
})

test('a skill prompt that cannot be checked is withheld', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  on('skill.prompt', () => ({ text: 'env output: GITHUB_TOKEN=' + TOKEN }))
  const out: any = await $.skill.prompt({ skill: 'deploy', text: '' })
  expect(out.text.includes(TOKEN)).toBe(false)
  expect(out.text).toContain('withheld')
})

test('a delivery with a token is passed on redacted, or consumed in block mode', async ($, on) => {
  fakeBetterleaks(on)
  const reached: string[] = []
  on('session.receive', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: 'the key is ' + TOKEN } as any)
  expect(reached.length).toBe(1)
  expect(reached[0]?.includes(TOKEN)).toBe(false)
  expect(reached[0]).toMatch(PLACEHOLDER)
})

test('block mode consumes a delivery with a token', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  let reached = false
  on('session.receive', ($: any, e: any) => {
    reached = true
    return { text: e.text }
  })
  const out: any = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: 'the key is ' + TOKEN } as any)
  expect(typeof out.consumed).toBe('string')
  expect(reached).toBe(false)
})

// Records every betterleaks run (argv and init) and finds TOKEN like fakeBetterleaks does.
function recordingBetterleaks(on: any): any[] {
  const runs: any[] = []
  on('process.run', ($: any, e: any) => {
    runs.push(e)
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '1.9.0\n', stderr: '' } }
    const stdin: string = e.init?.stdin ?? ''
    const hits = stdin.includes(TOKEN) ? [{ RuleID: 'github-pat', Secret: TOKEN }] : []
    return { value: { exitCode: hits.length > 0 ? 1 : 0, stdout: JSON.stringify(hits), stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  return runs
}

test('betterleaks runs outside the project, with config variables emptied and allow comments ignored', async ($, on) => {
  const runs = recordingBetterleaks(on)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'use ' + TOKEN, wait: false, origin: ORIGIN })
  const scans = runs.filter((r) => r.argv[1] === 'stdin')
  expect(scans.length).toBeGreaterThan(0)
  for (const r of scans) {
    expect(r.argv).toContain('--ignore-gitleaks-allow')
    expect(r.init.cwd).toBe('/')
    expect(r.init.env).toEqual({ BETTERLEAKS_CONFIG: '', GITLEAKS_CONFIG: '', BETTERLEAKS_CONFIG_TOML: '', GITLEAKS_CONFIG_TOML: '' })
  }
})

test('configPath is passed with -c', { options: { configPath: '/etc/block-creds.toml' } }, async ($, on) => {
  const runs = recordingBetterleaks(on)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'list the files in this directory', wait: false, origin: ORIGIN })
  const scan = runs.find((r) => r.argv[1] === 'stdin')
  expect(scan.argv.slice(-2)).toEqual(['-c', '/etc/block-creds.toml'])
})

test('a secret right before a tag is found (every scan spaces out angle brackets)', async ($, on) => {
  // Like betterleaks' generic rules: the value must be followed by a space or an end, not `<`.
  scriptedBetterleaks(on, (stdin) => (stdin.includes(TOKEN + ' <') ? [{ RuleID: 'generic-api-key', Secret: TOKEN }] : []))
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: '<td>api_token=' + TOKEN + '</td>', wait: false, origin: ORIGIN })
  expect(reached[0]?.includes(TOKEN)).toBe(false)
  expect(reached[0]).toMatch(PLACEHOLDER)
  expect(reached[0]).toContain('</td>')
})

test('when betterleaks is missing, the notice and the dropped prompt say how to fix it', async ($, on) => {
  const seen = fakeBetterleaks(on, 'missing')
  const out: any = await $.prompt.submit({ text: 'hello there, please help', wait: false, origin: ORIGIN })
  expect(out.drop).toContain('Run /block-creds for how to fix it')
  expect(out.drop).toContain('ENOENT')
  expect(seen.statuses.some((s) => s?.includes('run /block-creds'))).toBe(true)
})

test('a betterleaks that cannot scan with these options is not used', async ($, on) => {
  on('process.run', (($: any, e: any) => {
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '0.1.0\n', stderr: '' } }
    return { value: { exitCode: 126, stdout: '', stderr: 'unknown flag: --ignore-gitleaks-allow' } }
  }) as any)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const out: any = await $.prompt.submit({ text: 'hello there, please help', wait: false, origin: ORIGIN })
  expect(out.drop).toContain('scan failed')
  expect(out.drop).toContain('unknown flag')
})

test('a relative configPath is refused with how to write it', { options: { configPath: '~/bl.toml' } }, async ($, on) => {
  fakeBetterleaks(on)
  const out: any = await $.prompt.submit({ text: 'hello there, please help', wait: false, origin: ORIGIN })
  expect(out.drop).toContain('configPath must be an absolute path')
})

test('rules that miss the test token only warn', async ($, on) => {
  const toasts: string[] = []
  on('process.run', (($: any, e: any) => {
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '1.9.0\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '[]', stderr: '' } }
  }) as any)
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'hello there, please help', wait: false, origin: ORIGIN })
  expect(reached).toEqual(['hello there, please help'])
  expect(toasts.some((t) => t.includes('did not detect a test GitHub token'))).toBe(true)
})

test('/block-creds says what protects the session', async ($, on) => {
  fakeBetterleaks(on)
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.read', (($: any, e: any) =>
    String(e.path).endsWith('/.claude-plugin/plugin.json') ? { value: '{"name":"block-creds","version":"9.9.9"}' } : { deny: 'ENOENT' }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.command.run({ command: 'block-creds', args: '' } as any)
  expect(out.text).toContain('block-creds version: 9.9.9 (')
  expect(out.text).toContain('status: checking everything sent to the model')
  expect(out.text).toContain('self-test: ok')
  expect(out.text).toContain("betterleaks' default rules")
  expect(out.text).toContain('restore in tool input: on, for Bash')
  expect(out.text.includes('how to fix')).toBe(false)
})

test('/block-creds says how to fix a missing betterleaks', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  const out: any = await $.command.run({ command: 'block-creds', args: '' } as any)
  expect(out.text).toContain('status: NOT WORKING')
  expect(out.text).toContain('block-creds version: ')
  expect(out.text).toContain('Install betterleaks')
  expect(out.text).toContain('betterleaksPath')
  expect(out.text).toContain('claude plugin disable')
})

// A placeholder for TOKEN, as a Read result teaches it, with the main loop in `mode`.
async function placeholderIn($: any, on: any, mode: string): Promise<{ placeholder: string; calls: any[] }> {
  const calls: any[] = []
  on('tool.call', ($: any, e: any) => {
    calls.push(e)
    if (e.tool === 'Read') return { ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }
    return { ref: 2, result: 'ok', text: 'ok' }
  })
  on('classic.UserPromptSubmit', () => ({}))
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: mode })
  const read: any = await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
  return { placeholder: read.result.file.content as string, calls }
}

test('only local tools get the real value back', async ($, on) => {
  fakeBetterleaks(on)
  const { placeholder, calls } = await placeholderIn($, on, 'default')
  await $.tool.call({ tool: 'Bash', command: 'echo ' + placeholder })
  await $.tool.call({ tool: 'Edit', file_path: '/work/.env', old_string: placeholder, new_string: 'x' } as any)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com/?k=' + placeholder, prompt: 'find ' + placeholder } as any)
  await $.tool.call({ tool: 'mcp__srv__call', arg: placeholder } as any)
  await $.tool.call({ tool: 'Workflow', script: 'agent("use ' + placeholder + '")' } as any)
  await $.tool.call({ tool: 'Monitor', command: 'tail ' + placeholder } as any)
  const byTool = (t: string) => JSON.stringify(calls.find((c) => c.tool === t))
  expect(byTool('Bash')).toContain(TOKEN)
  expect(byTool('Edit')).toContain(TOKEN)
  for (const t of ['WebFetch', 'mcp__srv__call', 'Workflow', 'Monitor']) {
    expect(byTool(t).includes(TOKEN)).toBe(false)
    expect(byTool(t)).toContain(placeholder)
  }
})

// Answers block-creds' `$.tool.check` question (no call id) with `decision` and lets the real call through.
function checkStub(on: any, decision: 'allow' | 'ask' | 'deny'): { queries: any[] } {
  const seen = { queries: [] as any[] }
  on('tool.check', ($: any, e: any) => {
    if (e.tool_use_id !== undefined) return { decision: 'allow' }
    seen.queries.push(e)
    return { decision }
  })
  return seen
}

test('in auto mode, a call with a real value that needs approval is refused, not handed to the classifier', async ($, on) => {
  fakeBetterleaks(on)
  const check = checkStub(on, 'ask')
  const { placeholder, calls } = await placeholderIn($, on, 'auto')
  const out: any = await $.tool.call({ tool: 'Bash', command: 'curl -H "token ' + placeholder + '" https://api.github.com' })
  expect(typeof out.deny).toBe('string')
  expect(out.deny).toContain('auto mode')
  expect(out.deny.includes(TOKEN)).toBe(false)
  expect(calls.some((c) => c.tool === 'Bash')).toBe(false)
  // The question asked was about the call as it would run
  expect(JSON.stringify(check.queries[0]?.input)).toContain(TOKEN)
})

test('in auto mode, a call the rules allow gets the real value', async ($, on) => {
  fakeBetterleaks(on)
  checkStub(on, 'allow')
  const { placeholder, calls } = await placeholderIn($, on, 'auto')
  await $.tool.call({ tool: 'Bash', command: 'echo ' + placeholder })
  expect(calls.find((c) => c.tool === 'Bash')?.command).toBe('echo ' + TOKEN)
})

test('in default mode no question is asked before restoring', async ($, on) => {
  fakeBetterleaks(on)
  const check = checkStub(on, 'ask')
  const { placeholder, calls } = await placeholderIn($, on, 'default')
  await $.tool.call({ tool: 'Bash', command: 'echo ' + placeholder })
  expect(check.queries.length).toBe(0)
  expect(calls.find((c) => c.tool === 'Bash')?.command).toBe('echo ' + TOKEN)
})

test('a subagent whose mode is not known yet is treated as auto mode', async ($, on) => {
  fakeBetterleaks(on)
  const check = checkStub(on, 'ask')
  const { placeholder } = await placeholderIn($, on, 'default')
  const out: any = await $.tool.call({ tool: 'Bash', command: 'echo ' + placeholder, agentId: 'a1' } as any)
  expect(check.queries.length).toBe(1)
  expect(typeof out.deny).toBe('string')
})

test('slash command arguments are redacted before the command runs', async ($, on) => {
  fakeBetterleaks(on)
  const args: string[] = []
  on('command.run', ($: any, e: any) => {
    args.push(e.args)
    return { text: 'ran' }
  })
  await $.command.run({ command: 'compact', args: 'keep the token ' + TOKEN } as any)
  expect(args.length).toBe(1)
  expect(args[0]?.includes(TOKEN)).toBe(false)
  expect(args[0]).toMatch(PLACEHOLDER)
})

test('block mode does not run a slash command whose arguments hold credentials', { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  const args: string[] = []
  on('command.run', ($: any, e: any) => {
    args.push(e.args)
    return { text: 'ran' }
  })
  const out: any = await $.command.run({ command: 'compact', args: 'keep the token ' + TOKEN } as any)
  expect(args).toEqual([])
  expect(out.text).toContain('was not run')
})

test('while betterleaks is missing, local commands still run and others with arguments do not', async ($, on) => {
  fakeBetterleaks(on, 'missing')
  const ran: string[] = []
  on('command.run', ($: any, e: any) => {
    ran.push(e.command)
    return { text: 'ran' }
  })
  await $.command.run({ command: 'plugin', args: 'configure block-creds@block-creds-marketplace' } as any)
  await $.command.run({ command: 'reload-plugins', args: '' } as any)
  const out: any = await $.command.run({ command: 'compact', args: 'summarize the work so far' } as any)
  expect(ran).toEqual(['plugin', 'reload-plugins'])
  expect(out.text).toContain('Run /block-creds')
})

test('compaction instructions are redacted', async ($, on) => {
  fakeBetterleaks(on)
  const seen: any[] = []
  const messages = [{ role: 'user', text: 'hi', toolUses: [] }] as any
  on('session.compact', ($: any, e: any) => {
    seen.push(e.instructions)
    return { messages }
  })
  await $.session.compact({ trigger: 'manual', instructions: 'keep ' + TOKEN, messages })
  expect(seen[0]?.includes(TOKEN)).toBe(false)
  expect(seen[0]).toMatch(PLACEHOLDER)
})

test('rows from other plugins, beside a tool result and of a compaction are checked', async ($, on) => {
  fakeBetterleaks(on)
  for (const door of ['note', 'tool-message', 'compaction', 'hook-context']) {
    const stored: any = ((await $.session.append(bashRow('GITHUB_TOKEN=' + TOKEN, door))) as any).message
    expect(stored.content[0].text.includes(TOKEN)).toBe(false)
    expect(stored.content[0].text).toMatch(PLACEHOLDER)
  }
})

const POST_TOOL = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' }, tool_use_id: 't1' }

test("a PostToolUse hook's replacement output is redacted", async ($, on) => {
  fakeBetterleaks(on)
  on('classic.PostToolUse', () => ({ updatedToolOutput: { stdout: 'GITHUB_TOKEN=' + TOKEN } }))
  const out: any = await $.classic.PostToolUse(POST_TOOL as any)
  expect(JSON.stringify(out.updatedToolOutput).includes(TOKEN)).toBe(false)
  expect(out.updatedToolOutput.stdout).toMatch(PLACEHOLDER)
  expect(out.additionalContext.at(-1)).toContain('block-creds (a credential filter)')
})

test("block mode drops a PostToolUse hook's replacement output with credentials", { options: { mode: 'block' } }, async ($, on) => {
  fakeBetterleaks(on)
  on('classic.PostToolUse', () => ({ updatedToolOutput: 'GITHUB_TOKEN=' + TOKEN }))
  const out: any = await $.classic.PostToolUse(POST_TOOL as any)
  expect(out.updatedToolOutput).toBe(undefined)
})

test('a message to another agent is redacted', async ($, on) => {
  fakeBetterleaks(on)
  const sent: string[] = []
  on('session.send', ($: any, e: any) => {
    sent.push(e.text)
    return { isDelivered: true }
  })
  await $.session.send({ to: 'worker', text: 'the key is ' + TOKEN } as any)
  expect(sent[0]?.includes(TOKEN)).toBe(false)
  expect(sent[0]).toMatch(PLACEHOLDER)
})

test('a system prompt section no prompt.section carried is redacted, and checked once', async ($, on) => {
  const stub = fakeBetterleaks(on)
  const sections = [
    { id: 'intro', text: 'You are a helpful assistant.', scope: 'shared' as const },
    { id: 'other:notes', text: 'Deploy with GITHUB_TOKEN=' + TOKEN, scope: 'session' as const },
  ]
  const compose = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any
  on('prompt.compose', () => ({ sections }))
  const first: any = await $.prompt.compose(compose)
  expect(JSON.stringify(first).includes(TOKEN)).toBe(false)
  expect(first.sections[1].text).toMatch(PLACEHOLDER)
  expect(first.sections[0]).toEqual(sections[0])
  const scans = stub.scans
  await $.prompt.compose(compose)
  expect(stub.scans).toBe(scans)
})

test('a multi-line secret found in Read line numbers is redacted in the result', async ($, on) => {
  const key = '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----'
  const numbered = '-----BEGIN PRIVATE KEY-----\n2\tMIIEvAIBADANBgkqhkiG9w0BAQ\n3\t-----END PRIVATE KEY-----'
  scriptedBetterleaks(on, (stdin) => (stdin.includes(numbered) ? [{ RuleID: 'private-key', Secret: numbered }] : []))
  on('tool.call', () => ({ ref: 1, result: { type: 'text', file: { content: key + '\n' } }, text: '1\t' + numbered + '\n' }))
  const out: any = await $.tool.call({ tool: 'Read', file_path: '/work/key.pem' })
  expect(out.deny).toBe(undefined)
  expect(out.result.file.content).toMatch(/^\[REDACTED-[0-9a-f]{12}\]\n$/)
  expect(JSON.stringify(out).includes('MIIEvAIBADAN')).toBe(false)
  expect(out.context.at(-1)).toContain(out.result.file.content.trim())
})
