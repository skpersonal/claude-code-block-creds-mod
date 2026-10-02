// Pure redaction logic. No access to the mods API (`$`), so it can be tested without a session.

const BLOCK_SIZE = 64
const PLACEHOLDER_HEX = 12
const PLACEHOLDER_RE = /\[REDACTED-[0-9a-f]{12}\]/g

const encoder = new TextEncoder()

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

// The mods environment's Web Crypto only offers `digest`, so HMAC (RFC 2104) is built from it.
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const k = new Uint8Array(BLOCK_SIZE)
  k.set(key.length > BLOCK_SIZE ? await sha256(key) : key)
  const inner = new Uint8Array(BLOCK_SIZE + message.length)
  const outer = new Uint8Array(BLOCK_SIZE + 32)
  for (let i = 0; i < BLOCK_SIZE; i++) {
    inner[i] = (k[i] ?? 0) ^ 0x36
    outer[i] = (k[i] ?? 0) ^ 0x5c
  }
  inner.set(message, BLOCK_SIZE)
  outer.set(await sha256(inner), BLOCK_SIZE)
  return sha256(outer)
}

export type Mapping = ReadonlyArray<readonly [secret: string, placeholder: string]>

export type Redactor = {
  /** Placeholders for these secrets, longest secret first (so a secret that contains another is replaced whole). */
  mapping(secrets: readonly string[]): Promise<Mapping>
  /** Replaces every secret in a string. */
  applyText(text: string, mapping: Mapping): string
  /** Replaces every secret in every string of an object or array, keeping its shape. */
  applyDeep<T>(value: T, mapping: Mapping): T
  /** Turns the placeholders this redactor handed out back into the secrets. Memory only. */
  restoreDeep<T>(value: T): { value: T; changed: boolean }
  /** How many placeholders this redactor can turn back. */
  known(): number
}

export function keyBytes(keyText: string | undefined): Uint8Array {
  if (keyText) return encoder.encode(keyText)
  return crypto.getRandomValues(new Uint8Array(32))
}

/**
 * The placeholder is a keyed hash of the secret, so the same secret is always the same
 * placeholder (in a prompt, a tool result or another agent) and nothing has to be stored.
 * The key stays in memory; without it the model cannot test guesses against the placeholder.
 */
export function createRedactor(key: Uint8Array): Redactor {
  const byPlaceholder = new Map<string, string>()
  const bySecret = new Map<string, string>()

  async function placeholderOf(secret: string): Promise<string> {
    const known = bySecret.get(secret)
    if (known !== undefined) return known
    const mac = await hmacSha256(key, encoder.encode(secret))
    const placeholder = '[REDACTED-' + toHex(mac).slice(0, PLACEHOLDER_HEX) + ']'
    bySecret.set(secret, placeholder)
    byPlaceholder.set(placeholder, secret)
    return placeholder
  }

  function applyText(text: string, mapping: Mapping): string {
    let out = text
    for (const [secret, placeholder] of mapping) {
      if (out.includes(secret)) out = out.split(secret).join(placeholder)
    }
    return out
  }

  function mapStrings(value: unknown, fn: (s: string) => string): unknown {
    if (typeof value === 'string') return fn(value)
    if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn)
      return out
    }
    return value
  }

  return {
    async mapping(secrets) {
      const unique = [...new Set(secrets.filter((s) => s.length > 0))]
      unique.sort((a, b) => b.length - a.length)
      const out: Array<readonly [string, string]> = []
      for (const secret of unique) out.push([secret, await placeholderOf(secret)])
      return out
    },
    applyText,
    applyDeep<T>(value: T, mapping: Mapping): T {
      return mapStrings(value, (s) => applyText(s, mapping)) as T
    },
    restoreDeep<T>(value: T): { value: T; changed: boolean } {
      let changed = false
      const restored = mapStrings(value, (s) =>
        s.replace(PLACEHOLDER_RE, (p) => {
          const secret = byPlaceholder.get(p)
          if (secret === undefined) return p
          changed = true
          return secret
        }),
      ) as T
      return { value: restored, changed }
    },
    known: () => byPlaceholder.size,
  }
}

/** Every string inside a value, for scanning a result that has no flattened `text`. */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into)
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, into)
  return into
}
