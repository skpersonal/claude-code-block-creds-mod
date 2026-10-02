import { expect, test } from 'claude-code/testing'

const TOKEN = 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A'
const PLACEHOLDER = /\[REDACTED-[0-9a-f]{12}\]/
const ORIGIN = { kind: 'composer' } as const

type Stubs = { toasts: string[]; scans: number }

// Stands in for betterleaks: it "finds" TOKEN in whatever is piped to it.
function fakeBetterleaks(on: any, behaviour: 'works' | 'missing' = 'works'): Stubs {
  const seen: Stubs = { toasts: [], scans: 0 }
  on('process.run', ($: any, e: any) => {
    if (behaviour === 'missing') return { deny: 'spawn betterleaks ENOENT' }
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '1.7.4\n', stderr: '' } }
    seen.scans += 1
    const stdin: string = e.init?.stdin ?? ''
    const hits = stdin.includes(TOKEN) ? [{ RuleID: 'github-pat', Secret: TOKEN }] : []
    return { value: { exitCode: hits.length > 0 ? 1 : 0, stdout: JSON.stringify(hits), stderr: '' } }
  })
  on('ui.toast', ($: any, e: any) => {
    seen.toasts.push(e.text)
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
  expect(reached.length).toBe(2)
  for (const t of reached) {
    expect(t.includes(TOKEN)).toBe(false)
    expect(t).toMatch(PLACEHOLDER)
  }
  // Same secret, same placeholder, in the text and in the context
  expect(reached[0]?.match(PLACEHOLDER)?.[0]).toBe(reached[1]?.match(PLACEHOLDER)?.[0])
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

test('when betterleaks cannot run and failMode is open, the prompt is sent as is', { options: { failMode: 'open' } }, async ($, on) => {
  fakeBetterleaks(on, 'missing')
  const reached: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    reached.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'something longer than eight characters', wait: false, origin: ORIGIN })
  expect(reached).toEqual(['something longer than eight characters'])
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
  await $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'm1', props: { text: 'key is ' + placeholder, isFirstOfReply: true } } as any)
  await $.ui.render({ surface: 'terminal', component: 'ToolResult', requestId: 't1', props: { tool_use_id: 't1', tool: 'Read', output: { file: { content: placeholder } }, isErrored: false } } as any)
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

test('a generated hashKey is saved on session start, a configured one is not', async ($, on) => {
  fakeBetterleaks(on)
  const sets: any[] = []
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('config.list', (() => ({ value: [{ key: 'block-creds.hashKey', label: 'k', kind: 'text', value: '' }] })) as any)
  on('config.set', (($: any, e: any) => {
    sets.push(e)
    return { value: e.value }
  }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(sets.length).toBe(1)
  expect(sets[0].key).toBe('block-creds.hashKey')
  expect(sets[0].value).toMatch(/^[0-9a-f]{64}$/)
})

test('a configured hashKey is not overwritten', { options: { hashKey: 'my-key' } }, async ($, on) => {
  fakeBetterleaks(on)
  const sets: any[] = []
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('config.set', (($: any, e: any) => {
    sets.push(e)
    return { value: e.value }
  }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(sets.length).toBe(0)
})

test('a failed key save only warns', async ($, on) => {
  const seen = fakeBetterleaks(on)
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('config.list', (() => ({ deny: 'nope' })) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.toasts.some((t) => t.includes('could not save the generated hashKey'))).toBe(true)
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
