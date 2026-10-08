import { expect, test } from 'claude-code/testing'
import { appendToLastText, createRedactor, forScan, hmacSha256, keyBytes, redactionNotice, replaceText, toHex } from '../hooks/redactor.ts'
import { interpret } from '../hooks/scanner.ts'

const enc = new TextEncoder()
const bytes = (n: number, v: number) => new Uint8Array(n).fill(v)

test('hmacSha256 matches RFC 4231 test vectors', async () => {
  // Test case 1
  expect(toHex(await hmacSha256(bytes(20, 0x0b), enc.encode('Hi There')))).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  // Test case 2
  expect(toHex(await hmacSha256(enc.encode('Jefe'), enc.encode('what do ya want for nothing?')))).toBe(
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  )
  // Test case 6: a key longer than the block size is hashed first
  expect(toHex(await hmacSha256(bytes(131, 0xaa), enc.encode('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe(
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  )
})

test('forScan puts bash-mode tags on their own lines and keeps the text between them', () => {
  const scanned = forScan('<bash-stdout>KEY=abc</bash-stdout><bash-stderr></bash-stderr>')
  expect(scanned).toContain('\nKEY=abc\n')
  expect(scanned).not.toMatch(/[^\n]<\//)
  expect(forScan('no tags here')).toBe('no tags here')
})

test('the same secret always gets the same placeholder, another secret another one', async () => {
  const r = createRedactor(keyBytes('k'))
  const a = await r.mapping(['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  const b = await r.mapping(['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'])
  const secretA = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const phA = a[0]?.[1]
  expect(phA).toMatch(/^\[REDACTED-[0-9a-f]{12}\]$/)
  expect(b.find(([s]) => s === secretA)?.[1]).toBe(phA)
  expect(b.find(([s]) => s !== secretA)?.[1]).not.toBe(phA)
})

test('a fixed hashKey gives the same placeholder in a new redactor, a random key does not', async () => {
  const secret = 'AKIAABCDEFGHIJKLMNOP'
  const one = await createRedactor(keyBytes('fixed')).mapping([secret])
  const two = await createRedactor(keyBytes('fixed')).mapping([secret])
  const three = await createRedactor(keyBytes(undefined)).mapping([secret])
  expect(one[0]?.[1]).toBe(two[0]?.[1])
  expect(three[0]?.[1]).not.toBe(one[0]?.[1])
})

test('applyText replaces every occurrence, longest secret first', async () => {
  const r = createRedactor(keyBytes('k'))
  const short = 'abcdef123456'
  const long = 'abcdef123456-and-more'
  const m = await r.mapping([short, long])
  const out = r.applyText('x=' + long + ' y=' + short + ' z=' + short, m)
  expect(out.includes(short)).toBe(false)
  expect(out.match(/\[REDACTED-[0-9a-f]{12}\]/g)?.length).toBe(3)
  // The long secret was replaced whole, not as the short one plus "-and-more"
  expect(out.includes('-and-more')).toBe(false)
})

test('applyDeep keeps the shape and restoreDeep brings the secrets back', async () => {
  const r = createRedactor(keyBytes('k'))
  const secret = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'
  const m = await r.mapping([secret])
  const value = { file: { content: 'key:\n' + secret, n: 3 }, list: ['a', secret], flag: true }
  const redacted = r.applyDeep(value, m)
  expect(JSON.stringify(redacted).includes('MIIE')).toBe(false)
  expect(redacted.file.n).toBe(3)
  expect(redacted.flag).toBe(true)
  const back = r.restoreDeep(redacted)
  expect(back.changed).toBe(true)
  expect(back.value).toEqual(value)
})

test('restoreDeep leaves a placeholder it did not hand out alone', () => {
  const r = createRedactor(keyBytes('k'))
  const input = { command: 'echo [REDACTED-0123456789ab]' }
  const out = r.restoreDeep(input)
  expect(out.changed).toBe(false)
  expect(out.value).toEqual(input)
})

test('interpret: clean, findings and every way a scan can fail', () => {
  expect(interpret(0, '[]', '')).toEqual({ ok: true, findings: [] })
  expect(interpret(1, '[{"RuleID":"github-pat","Secret":"ghp_x"},{"RuleID":"r","Secret":""}]', '')).toEqual({
    ok: true,
    findings: [{ ruleId: 'github-pat', secret: 'ghp_x' }],
  })
  // The AWS secret key is only reported inside the access key's finding
  const aws = {
    RuleID: 'aws-access-token',
    Secret: 'AKIAABCDEFGHIJKLMNOP',
    ComponentSets: [{ components: [{ RuleID: 'aws-secret-access-key', Secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzqAbCdEfGh' }] }],
  }
  expect(interpret(1, JSON.stringify([aws]), '')).toEqual({
    ok: true,
    findings: [
      { ruleId: 'aws-access-token', secret: 'AKIAABCDEFGHIJKLMNOP' },
      { ruleId: 'aws-secret-access-key', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzqAbCdEfGh' },
    ],
  })
  expect(interpret(127, '', 'not found').ok).toBe(false)
  expect(interpret(0, '', '').ok).toBe(false)
  expect(interpret(1, '[{"RuleID":"a","Secret":"x"', '').ok).toBe(false)
  expect(interpret(0, '{"a":1}', '').ok).toBe(false)
  expect(interpret(1, '[]', '').ok).toBe(false)
})

test('the same key gives the same placeholder after a restart and restores it', async () => {
  const key = keyBytes('fixed-key')
  const first = createRedactor(key)
  const placeholder = (await first.mapping(['s3cret-value']))[0]![1]
  const second = createRedactor(keyBytes('fixed-key'))
  expect(second.restoreDeep(placeholder).changed).toBe(false)
  const again = (await second.mapping(['s3cret-value']))[0]![1]
  expect(again).toBe(placeholder)
  expect(second.restoreDeep(placeholder).value).toBe('s3cret-value')
  expect(second.known()).toBe(1)
})

test('redactionNotice lists each placeholder with its rules and follows restore', () => {
  const entries = [
    { placeholder: '[REDACTED-aaaaaaaaaaaa]', rules: ['github-pat'] },
    { placeholder: '[REDACTED-bbbbbbbbbbbb]', rules: ['aws-access-token', 'aws-secret-access-key'] },
  ]
  const on = redactionNotice(entries, { restoresInToolInput: true, userSeesRealValues: true })
  expect(on).toContain('[REDACTED-aaaaaaaaaaaa] (github-pat)')
  expect(on).toContain('[REDACTED-bbbbbbbbbbbb] (aws-access-token, aws-secret-access-key)')
  expect(on).toContain('swapped for the real value')
  expect(on).toContain('The user sees the real values on their screen')
  const off = redactionNotice(entries, { restoresInToolInput: false, userSeesRealValues: false })
  expect(off).toContain('receive the placeholder text literally')
  expect(off).not.toContain('swapped for the real value')
  expect(off).toContain('The user also sees the placeholders')
  expect(off).not.toContain('sees the real values')
})

test('appendToLastText adds the note to the last text block and keeps the others', () => {
  const img = { type: 'image' }
  const out = appendToLastText([{ type: 'text', text: 'a' }, img, { type: 'text', text: 'b' }], 'note')
  expect(out).toEqual([{ type: 'text', text: 'a' }, img, { type: 'text', text: 'b\n\nnote' }])
})

test('replaceText keeps one text block and the other blocks', () => {
  const img = { type: 'image' }
  const out = replaceText([{ type: 'text', text: 'a' }, img, { type: 'text', text: 'b' }], 'x')
  expect(out).toEqual([{ type: 'text', text: 'x' }, img])
})
