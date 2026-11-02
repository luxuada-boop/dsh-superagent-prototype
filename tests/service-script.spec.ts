/**
 * Tests for scripts/dsh-superagent using a temporary checkout path with spaces.
 * POSIX tests stub ps, tmux, and dsh; Windows tests use the real process and console APIs instead, with a fake `dsh`
 * batch shim that serves the management API.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const windows = process.platform === 'win32'
/** Windows installs `python`, not `python3`, on PATH. */
const python = windows ? 'python' : 'python3'
const itWindows = windows ? it : it.skip
const itPosix = windows ? it.skip : it
const pathSeparator = windows ? ';' : ':'
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const program = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
/** Spawn a dummy process whose PID can be listed by the fake ps binary; ignoreInterrupt simulates a hung graceful stop. */
function sleeper(ignoreInterrupt = false): number {
  const [program, args] = ignoreInterrupt ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const : ['sleep', ['60']] as const
  const child = spawn(program, [...args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
/** Write active process lines (`pid ucomm args`) for the fake ps binary. Entries prefixed with `after:<pid> ` appear only after that PID exits. */
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
  processes()
  program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  case "$line" in after:*) dep=\${line#after:}; dep=\${dep%% *}; kill -0 "$dep" 2>/dev/null && continue; line=\${line#after:$dep };; esac
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
  // Log tmux invocations and simulate session creation by outputting the pane PID.
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  program('dsh', 'exit 0')
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(python, [join(root, 'scripts', 'dsh-superagent'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}${pathSeparator}${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** Start a mock HTTP server that returns 503 until tmux launches the service (unless always is true). */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

itPosix('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  processes(service(sleeper()), `${sleeper()} node node /opt/dsh --profile=superagent`)
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
})
it('keeps a stop per profile', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
})
itPosix('takes no `dsh plugin` command of the profile for its service', async () => {
  const service = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`,
    `${service} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
})
itPosix('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
  // The checkout's path, which has a space, is one argument, and the log path inside it is quoted for the shell.
  const checkout = realpathSync(root)
  expect(tmux).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_pid}', '-c', checkout]))
  const log = new RegExp(`>> '${checkout}/\\.artifacts/dsh-superagent-superagent-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
  expect(tmux.find(word => word.startsWith('umask 077; exec '))).toMatch(log)
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile superagent`)
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
  expect(await status('superagent')).toMatchObject({ pids: [pid, second] })
}, 20_000)
itPosix('waits only for the process it stopped', async () => {
  const pid = sleeper()
  // Another instance shows up once the stopped one ended.
  processes(service(pid), `after:${pid} ${sleeper()} node node /opt/dsh --profile superagent`)
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped') })
}, 20_000)
itPosix('keeps only the newest logs it wrote for the profile', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
}, 20_000)
itPosix('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
})
itPosix('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, 20_000)
itPosix('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 20_000)
itPosix('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  const url = await answering()
  const old = sleeper(), pid = sleeper()
  processes(service(old))
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
  expect(restarted.stdout).not.toContain('Automatic recovery is paused')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // A service that does not stop in time is left running, and the next check may restart it.
  rmSync(join(root, 'launched'))
  processes(service(sleeper(true)))
  expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(await status('superagent')).toMatchObject({ manually_stopped: false })
}, 20_000)
itPosix('refuses a second control operation while one holds the profile\'s lock', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const held = join(root, 'held')
  const holder = spawn(python, ['-c', `import fcntl, pathlib, time
lock = open(${JSON.stringify(join(control('superagent'), 'operation.lock'))}, 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)`], { stdio: 'ignore' })
  sleepers.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
}, 20_000)
itPosix('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[0])).toEqual(['has-session'])
}, 20_000)
itPosix('starts the service in a new window of the profile\'s tmux session when the session exists', async () => {
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 0;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[0] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[0] === 'new-session')).toBe(false)
}, 20_000)
itPosix('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 20_000)
itPosix('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // A service that does not stop in time keeps the stop, so recovery does not start it again.
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(service(sleeper(true)))
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)

const servicePid = (profile: string) => join(control(profile), 'service.pid')

/** Reserve an ephemeral port for the fake service. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/** Put a `dsh` batch shim on PATH that serves the management API from a real Python HTTP server until signalled. */
async function fakeDsh(): Promise<string> {
  const port = await freePort()
  writeFileSync(join(root, 'bin', 'fake-service.py'), `import http.server
import json
BODY = json.dumps({'health': {'runtime': {'state': 'ready'}}, 'setup': {}, 'feishuProblem': None}).encode()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?', 1)[0] != '/orchestrator/api/state':
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)
    def log_message(self, *arguments):
        pass
http.server.HTTPServer(('127.0.0.1', ${port}), Handler).serve_forever()
`)
  writeFileSync(join(root, 'bin', 'dsh.bat'), '@echo off\r\npython "%~dp0fake-service.py" %*\r\n')
  return `http://127.0.0.1:${port}`
}

describe('on Windows, against the real script', () => {
  itWindows('reports a stopped service with the documented JSON and exit code', async () => {
    const result = await run('status', '--profile', 'winstop', '--url', 'http://127.0.0.1:9')
    expect(result.code).toBe(1)
    const body = JSON.parse(result.stdout)
    expect(body).toMatchObject({ pids: [], url: 'http://127.0.0.1:9', manually_stopped: false, health: null })
    expect(Object.keys(body).sort()).toEqual(['cwd', 'errors', 'feishu', 'health', 'manually_stopped', 'pids', 'setup', 'url'])
    expect(body.cwd.toLowerCase()).toBe(realpathSync(root).toLowerCase())
  }, 20_000)
  itWindows('rejects an invalid profile name', async () => {
    expect(await run('status', '--profile', 'bad/name')).toMatchObject({ code: 2,
      stderr: expect.stringContaining('--profile must be a DSH profile name') })
  })
  itWindows('refuses a second control operation while one holds the profile\'s lock', async () => {
    const directory = control('winlock')
    mkdirSync(directory, { recursive: true })
    const held = join(root, 'held')
    const holder = spawn(python, ['-c', `import msvcrt, pathlib, time
lock = open(${JSON.stringify(join(directory, 'operation.lock'))}, 'a')
msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)`], { stdio: 'ignore' })
    sleepers.push(holder)
    for (let waited = 0; !existsSync(held); waited += 50) {
      if (waited > 5_000) throw new Error('the lock holder did not start')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(await run('status', '--profile', 'winlock', '--url', 'http://127.0.0.1:9')).toMatchObject({ code: 1,
      stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
  }, 20_000)
  itWindows('keeps only the newest logs it wrote for the profile', async () => {
    const url = await fakeDsh()
    mkdirSync(join(root, '.artifacts'), { recursive: true })
    for (const profile of ['winlog', 'other']) for (let index = 0; index < 25; index++) {
      const log = join(root, '.artifacts', `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
      writeFileSync(log, '')
      utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
    }
    writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
    try {
      expect(await run('start', '--profile', 'winlog', '--url', url, '--timeout', '15')).toMatchObject({ code: 0 })
      const logs = readdirSync(join(root, '.artifacts'))
      const own = logs.filter(name => name.startsWith('dsh-superagent-winlog-')).sort()
      expect(own).toHaveLength(20)
      // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
      expect(own).not.toContain('dsh-superagent-winlog-20260901-000000-1.log')
      expect(own.filter(name => !name.startsWith('dsh-superagent-winlog-20260901-'))).toHaveLength(1)
      expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
      expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
    } finally {
      await run('stop', '--profile', 'winlog', '--stop-timeout', '10')
    }
  }, 20_000)
  itWindows('starts, reports and stops a service through a fake dsh shim', async () => {
    const url = await fakeDsh()
    let stopped = false
    try {
      expect(await run('start', '--profile', 'winlife', '--url', url, '--timeout', '15'))
        .toMatchObject({ code: 0, stdout: expect.stringContaining('Log: ') })
      const pid = Number(readFileSync(servicePid('winlife'), 'utf8').trim())
      expect(pid).toBeGreaterThan(0)
      const status = await run('status', '--profile', 'winlife', '--url', url)
      expect(status.code).toBe(0)
      expect(JSON.parse(status.stdout)).toMatchObject({
        pids: [pid], url, manually_stopped: false, health: { runtime: 'ready' } })
      const stop = await run('stop', '--profile', 'winlife', '--stop-timeout', '10')
      stopped = true
      expect(stop).toMatchObject({ code: 0,
        stdout: expect.stringContaining('dsh-superagent stopped. Automatic recovery is paused until start/restart.') })
      expect(stop.stderr).not.toContain('taskkill')
      expect(existsSync(servicePid('winlife'))).toBe(false)
      expect(existsSync(join(control('winlife'), 'manually-stopped'))).toBe(true)
    } finally {
      if (!stopped) await run('stop', '--profile', 'winlife', '--stop-timeout', '5')
    }
  }, 20_000)
})
