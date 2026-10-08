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
  expect(out.context[0]).toContain('swapped for the real value')
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
  const calls: any[] = []
  let first = true
  on('tool.call', ($: any, e: any) => {
    calls.push(e)
    if (!first) return { ref: 2, result: { stdout: 'ok', stderr: '' }, text: 'ok' }
    first = false
    return { ref: 1, result: { type: 'text', file: { content: TOKEN } }, text: TOKEN }
  })
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
