// Pure helpers for running betterleaks. The process itself is started in register.ts,
// because a mod can only pass `$` to functions declared in its own hooks module.

export type Finding = { ruleId: string; secret: string }

export type ScanOutcome = { ok: true; findings: Finding[] } | { ok: false; error: string }

/** Inputs shorter than this cannot hold a credential worth scanning for. */
export const MIN_SCAN_LENGTH = 8

/**
 * Where betterleaks runs. It reads `.betterleaks.toml` / `.gitleaks.toml` and `.betterleaksignore` / `.gitleaksignore`
 * from its working directory (`-i` does not stop that), so a project could weaken the rules or hide findings.
 */
export const SCAN_CWD = '/'

export function buildArgv(bin: string, configPath: string | undefined): string[] {
  // `--ignore-gitleaks-allow`: a line marked `gitleaks:allow` or `betterleaks:allow` would otherwise not be scanned.
  const argv = [bin, 'stdin', '--no-banner', '-l', 'error', '-f', 'json', '-r', '-', '--ignore-gitleaks-allow']
  if (configPath) argv.push('-c', configPath)
  return argv
}

/** Empties the variables betterleaks reads a config from, so only `-c` (`configPath`) or its default rules apply. */
export function scanEnv(): Record<string, string> {
  return { BETTERLEAKS_CONFIG: '', GITLEAKS_CONFIG: '', BETTERLEAKS_CONFIG_TOML: '', GITLEAKS_CONFIG_TOML: '' }
}

/** A relative path would be read from SCAN_CWD, not from where the person meant. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** A made-up GitHub token the default rules detect, for the self-test. Split so this file holds no token itself. */
export const PROBE_SECRET = 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A'
export const PROBE_TEXT = 'GITHUB_TOKEN=' + PROBE_SECRET

/**
 * A finding can carry further secrets inside it: `aws-access-token` lists the paired
 * `aws-secret-access-key` under `ComponentSets[].components[]` and does not report it on its own.
 * Every object with a `Secret` at any depth counts.
 */
function collectFindings(node: unknown, into: Finding[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFindings(item, into)
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj['Secret'] === 'string' && obj['Secret'].length > 0) {
    into.push({ ruleId: typeof obj['RuleID'] === 'string' ? obj['RuleID'] : 'unknown', secret: obj['Secret'] })
  }
  for (const value of Object.values(obj)) collectFindings(value, into)
}

/**
 * betterleaks exits 0 with `[]` when nothing was found and 1 with a JSON array when something was.
 * Anything else (missing binary, bad config, timeout, cut-off output) is an error, not "clean".
 */
export function interpret(exitCode: number, stdout: string, stderr: string): ScanOutcome {
  if (exitCode !== 0 && exitCode !== 1) {
    return { ok: false, error: 'betterleaks exited with ' + exitCode + (stderr ? ': ' + stderr.trim().slice(0, 200) : '') }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, error: 'betterleaks printed output that is not JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'betterleaks printed JSON that is not a list' }
  const findings: Finding[] = []
  collectFindings(parsed, findings)
  if (exitCode === 1 && findings.length === 0) {
    return { ok: false, error: 'betterleaks reported leaks but listed none' }
  }
  return { ok: true, findings }
}
