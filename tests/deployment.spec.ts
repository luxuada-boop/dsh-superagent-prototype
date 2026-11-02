import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
/**
 * `CreateProcess` cannot start a `#!/bin/sh` script, and `execFile` cannot start a `.cmd`, so the stand-in CLIs and the
 * probe differ by platform: POSIX keeps its scripts and `/usr/bin`, Windows uses batch launchers and `cmd.exe`.
 */
const WINDOWS = process.platform === 'win32'
/** The command interpreter that starts the fake `.cmd` CLIs on Windows. */
const COMSPEC = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
let dir: string
let path: string
/** A fake CLI body per platform: the POSIX shell script and the Node script behind its Windows `.cmd` launcher. */
type Body = { posix: string; windows: string }
const body = (posix: string, windows: string): Body => ({ posix, windows })
/**
 * Write a fake CLI and return the path to pass as the CLI. On Windows that is a `.mjs` dispatch script plus an
 * `@echo off` launcher that forwards `%*` to it; a bare string body is a stub that only needs to exist there.
 */
const program = (file: string, fake: string | Body = ''): string => {
  if (!WINDOWS) { writeFileSync(file, `#!/bin/sh\n${typeof fake === 'string' ? fake : fake.posix}\n`); chmodSync(file, 0o755); return file }
  writeFileSync(`${file}.mjs`, `${typeof fake === 'string' ? '' : fake.windows}\n`)
  writeFileSync(`${file}.cmd`, `@echo off\r\ncall node "%~dp0${basename(file)}.mjs" %*\r\n`)
  return `${file}.cmd`
}
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, body(
  `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`,
  [
    `const args = process.argv.slice(2).join(' ')`,
    `if (args === 'api user') console.log(JSON.stringify({ login: ${JSON.stringify(login)}, id: 7 }))`,
    `else if (args.startsWith('api repos/acme/') && args.endsWith(' --jq {name: .full_name, push: .permissions.push}')) console.log(JSON.stringify({ name: 'acme/widgets', push: ${push} }))`,
    `else process.exit(1)`,
  ].join('\n'),
))
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): Body => body(
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`,
  [
    `const args = process.argv.slice(2).join(' ')`,
    `if (args === 'auth status') console.log(JSON.stringify(${JSON.stringify(status)}))`,
    `else if (args === 'config strict-mode') console.log('strict-mode: ' + ${JSON.stringify(mode)} + ' (source: profile)')`,
    `else if (args === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') console.log(JSON.stringify(${JSON.stringify(bot)}))`,
  ].join('\n'),
)
/** The extension PATHEXT appends when a bare command name resolves to the fake `.cmd` CLI on Windows. */
const commandExtension = WINDOWS
  ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').find(extension => extension.toLowerCase() === '.cmd') ?? '.CMD'
  : ''
/** The path that resolving `name` through the fake `bin` directory yields on this platform. */
const binCli = (name: string): string => join(dir, 'bin', `${name}${commandExtension}`)
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** The environment of the fake CLIs. Windows also needs what `cmd.exe`, `node`, and git read from the ambient environment. */
const probeEnv = (): Record<string, string | undefined> => {
  if (!WINDOWS) return { PATH: path, HOME: dir }
  // Git on Windows reads HOME, then USERPROFILE, then HOMEDRIVE+HOMEPATH for the operator's git configuration; all three
  // are pointed at the test directory so setup cannot read the operator's home even though `cmd.exe` needs the ambient PATH.
  const drive = /^([A-Za-z]:)/.exec(dir)?.[1] ?? ''
  return { ...process.env, PATH: path, HOME: dir, USERPROFILE: dir, HOMEDRIVE: drive, HOMEPATH: dir.slice(drive.length) }
}
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async (argv, extra = {}) => {
  const env = { ...probeEnv(), ...extra }
  // `execFile` cannot start a `.cmd`; `cmd.exe` can. Each argument stays one argv entry, so those with spaces arrive intact.
  if (!WINDOWS) return (await exec(argv[0]!, argv.slice(1), { env })).stdout
  return (await exec(COMSPEC, ['/d', '/s', '/c', argv[0]!, ...argv.slice(1)], { env })).stdout
}
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  // The trailing-slash and linked spellings of worker-bin stay: resolving duplicate PATH entries is part of what setup proves.
  path = WINDOWS
    ? [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}\\`, join(dir, 'bin'), process.env.PATH ?? ''].join(delimiter)
    : [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(delimiter)
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  // A directory junction needs no privilege Windows reserves for symbolic links.
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'), WINDOWS ? 'junction' : undefined)
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: binCli('gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: binCli('gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), body('exit 1', 'process.exit(1)')) })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'), body(
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`,
      [
        `const args = process.argv.slice(2).join(' ')`,
        `if (args === 'api user') console.log(JSON.stringify({ login: 'Agent-Bot', id: 7 }))`,
        `else { console.error('HTTP 404'); process.exit(1) }`,
      ].join('\n'),
    ))
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), body(`echo '{}'`, `console.log('{}')`)) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: binCli('lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), body('echo "not configured" >&2; exit 1', `console.error('not configured'); process.exit(1)`))
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
