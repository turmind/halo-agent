import { describe, it, expect } from 'vitest'
import {
  buildUserUnit,
  serializeEnvFile,
  parseCgroup,
  matchSystemUnit,
  planStart,
  type StartFacts,
  type UnitUser,
} from '../src/server-systemd.js'

/**
 * The pure half of the systemd integration for `halo server`. The invariant
 * the whole file serves: a server some unit owns is never signalled and
 * re-spawned outside it (the unit then loops on the server's flock guard), and
 * a redirected HOME never touches the real user's units.
 */

describe('buildUserUnit', () => {
  const base = { execPath: '/usr/bin/node', script: '/usr/lib/node_modules/@turmind/halo/bin/halo.js', cwd: '/home/u' }

  it('writes the unit the design specifies', () => {
    expect(buildUserUnit(base)).toBe([
      '# Written by `halo server start -d` / `halo server restart`, which rewrite it on every run.',
      '[Unit]',
      'Description=Halo Server',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=/usr/bin/node /usr/lib/node_modules/@turmind/halo/bin/halo.js server start',
      'WorkingDirectory=-/home/u',
      'EnvironmentFile=%h/.halo/secrets/server.env',
      'Restart=on-failure',
      'RestartSec=5',
      'StandardOutput=append:%h/.halo/logs/server.log',
      'StandardError=append:%h/.halo/logs/server.log',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'))
  })

  it('adds -p only for an explicit port', () => {
    expect(buildUserUnit({ ...base, port: 9631 })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@turmind/halo/bin/halo.js server start -p 9631\n')
  })

  it('escapes specifiers, variables and spaces in paths', () => {
    const text = buildUserUnit({ execPath: '/opt/my node/node', script: '/a/50%$x/halo.js', cwd: '/w/100%' })
    expect(text).toContain('ExecStart="/opt/my node/node" /a/50%%$$x/halo.js server start\n')
    expect(text).toContain('WorkingDirectory=-/w/100%%\n')
  })
})

describe('serializeEnvFile', () => {
  const lines = (env: NodeJS.ProcessEnv): string[] => serializeEnvFile(env).split('\n').filter((l) => l && !l.startsWith('#'))

  it('keeps server env, sorted and double-quoted', () => {
    expect(lines({ PATH: '/home/u/.nvm/bin:/usr/bin', HALO_PASSWORD: 'pw', AWS_REGION: 'us-east-1' })).toEqual([
      'AWS_REGION="us-east-1"',
      'HALO_PASSWORD="pw"',
      'PATH="/home/u/.nvm/bin:/usr/bin"',
    ])
  })

  it('escapes backslash, double quote, backtick and dollar', () => {
    expect(lines({ K: 'a\\b"c`d$e' })).toEqual(['K="a\\\\b\\"c\\`d\\$e"'])
  })

  it('skips values with a newline', () => {
    expect(lines({ MULTI: 'a\nb', OK: '1' })).toEqual(['OK="1"'])
  })

  it('drops shell / session / service-manager vars and the supervisor marker', () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/h', USER: 'u', LOGNAME: 'u', SHELL: '/bin/bash', PWD: '/', OLDPWD: '/', SHLVL: '1', _: '/usr/bin/halo',
      TERM: 'xterm', COLORTERM: 'truecolor', LS_COLORS: 'x', MAIL: 'm', DISPLAY: ':0', WAYLAND_DISPLAY: 'w',
      SSH_AUTH_SOCK: 's', SSH_CONNECTION: 'c', XDG_RUNTIME_DIR: '/run/user/1', XDG_SESSION_ID: '3',
      DBUS_SESSION_BUS_ADDRESS: 'd', INVOCATION_ID: 'i', JOURNAL_STREAM: 'j', SYSTEMD_EXEC_PID: '1',
      MANAGERPID: '1', NOTIFY_SOCKET: 'n', LISTEN_FDS: '1', LISTEN_PID: '1', HALO_SUPERVISE: '1',
      HALO_SSH_PASSPHRASE: 'p', JUPYTER_TOKEN: 't',
      KEEP: 'yes',
    }
    expect(lines(env)).toEqual(['KEEP="yes"'])
  })

  it('drops keys that are not valid variable names', () => {
    expect(lines({ 'BASH_FUNC_x%%': '() { :; }', 'A-B': '1', OK: '1' })).toEqual(['OK="1"'])
  })
})

describe('parseCgroup', () => {
  it('system unit', () => {
    expect(parseCgroup('0::/system.slice/halo.service\n')).toEqual({
      path: '/system.slice/halo.service',
      unit: { scope: 'system', name: 'halo.service' },
    })
  })

  it('user unit under user@<uid>.service', () => {
    expect(parseCgroup('0::/user.slice/user-1001.slice/user@1001.service/app.slice/halo.service\n')).toEqual({
      path: '/user.slice/user-1001.slice/user@1001.service/app.slice/halo.service',
      unit: { scope: 'user', name: 'halo.service' },
    })
  })

  it('login session scope (legacy -d) is no unit', () => {
    expect(parseCgroup('0::/user.slice/user-1000.slice/session-12.scope\n')?.unit).toBeNull()
  })

  it('user manager scope outside any service is no unit', () => {
    expect(parseCgroup('0::/user.slice/user-1000.slice/user@1000.service/init.scope\n')?.unit).toBeNull()
  })

  it('container root / non-systemd is no unit', () => {
    expect(parseCgroup('0::/\n')?.unit).toBeNull()
  })

  it('cgroup v1 / hybrid: reads the name=systemd hierarchy', () => {
    const text = '12:cpu,cpuacct:/system.slice/halo.service\n1:name=systemd:/system.slice/halo.service\n'
    expect(parseCgroup(text)?.unit).toEqual({ scope: 'system', name: 'halo.service' })
  })

  it('unparseable is null', () => {
    expect(parseCgroup('')).toBeNull()
  })
})

describe('matchSystemUnit', () => {
  const me: UnitUser = { name: 'ubuntu', uid: 1000, passwdHome: '/home/ubuntu', home: '/home/ubuntu' }
  const prod = [
    '[Unit]', 'Description=Halo AI Server', 'After=network.target', '',
    '[Service]', 'Type=simple', 'User=ubuntu', 'ExecStart=/usr/bin/halo server start', 'Restart=always', 'RestartSec=5', '',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n')
  const dev = [
    '[Unit]', 'Description=Halo Dev Server (source build, isolated HOME)', '',
    '[Service]', 'Type=simple', 'User=ubuntu', 'WorkingDirectory=/home/ubuntu/halo-agent/packages/server',
    'ExecStart=/usr/bin/node dist/index.js', 'Environment=NODE_ENV=production',
    'Environment=HOME=/home/ubuntu/halo-dev-home', 'Environment=HALO_PORT=8527', '',
  ].join('\n')

  it('prod-like unit (User = me, `halo server start`) matches', () => {
    expect(matchSystemUnit(prod, me)).toBe(true)
  })

  it('dev-like unit (node dist/index.js, own HOME) does not', () => {
    expect(matchSystemUnit(dev, me)).toBe(false)
  })

  it('another User= does not', () => {
    expect(matchSystemUnit(prod.replace('User=ubuntu', 'User=halotest'), me)).toBe(false)
  })

  it('User= as a uid matches', () => {
    expect(matchSystemUnit(prod.replace('User=ubuntu', 'User=1000'), me)).toBe(true)
  })

  it('no User= runs as root: matches only for root', () => {
    const rootUnit = prod.replace('User=ubuntu\n', '')
    expect(matchSystemUnit(rootUnit, me)).toBe(false)
    expect(matchSystemUnit(rootUnit, { name: 'root', uid: 0, passwdHome: '/root', home: '/root' })).toBe(true)
  })

  it('a HOME override must equal our HOME', () => {
    expect(matchSystemUnit(prod.replace('Restart=always', 'Environment=HOME=/srv/halo'), me)).toBe(false)
    expect(matchSystemUnit(prod.replace('Restart=always', 'Environment="HOME=/home/ubuntu" A=1'), me)).toBe(true)
  })

  it('a redirected HOME without an override does not match', () => {
    expect(matchSystemUnit(prod, { ...me, home: '/tmp/h' })).toBe(false)
  })

  it('node + halo.js script and -p flags match; other subcommands do not', () => {
    const js = prod.replace('/usr/bin/halo server start', '/usr/bin/node /opt/halo/bin/halo.js server start -p 9632')
    expect(matchSystemUnit(js, me)).toBe(true)
    expect(matchSystemUnit(prod.replace('server start', 'agentcore -w /w'), me)).toBe(false)
  })

  it('ignores ExecStart outside [Service] and commented lines', () => {
    const text = '[Unit]\nExecStart=/usr/bin/halo server start\n[Service]\nUser=ubuntu\n#ExecStart=/usr/bin/halo server start\nExecStart=/usr/bin/other\n'
    expect(matchSystemUnit(text, me)).toBe(false)
  })
})

describe('planStart', () => {
  const linux: StartFacts = {
    platform: 'linux',
    systemdBooted: true,
    homeMatches: true,
    userManagerOk: true,
    runningPid: null,
    owner: null,
    systemUnit: null,
    restart: false,
  }

  it('Linux + systemd + user manager → user unit', () => {
    expect(planStart(linux)).toEqual({ action: 'user-unit' })
  })

  it('non-Linux → legacy supervisor, no note', () => {
    expect(planStart({ ...linux, platform: 'darwin' })).toEqual({ action: 'legacy', note: null })
  })

  it('Linux without systemd → legacy with a note', () => {
    expect(planStart({ ...linux, systemdBooted: false })).toMatchObject({ action: 'legacy', note: expect.stringMatching(/systemd is not running/) })
  })

  it('redirected HOME → legacy, never a user unit', () => {
    expect(planStart({ ...linux, homeMatches: false })).toMatchObject({ action: 'legacy', note: expect.stringMatching(/HOME/) })
  })

  it('user manager unreachable → legacy with a note', () => {
    expect(planStart({ ...linux, userManagerOk: false })).toMatchObject({ action: 'legacy', note: expect.stringMatching(/user manager not reachable/) })
  })

  it('a matching system unit wins over a user unit, even without a user manager', () => {
    expect(planStart({ ...linux, systemUnit: 'halo.service' })).toEqual({ action: 'system-unit', unit: 'halo.service' })
    expect(planStart({ ...linux, systemUnit: 'halo.service', userManagerOk: false })).toEqual({ action: 'system-unit', unit: 'halo.service' })
  })

  it('a running server → "already running", naming its unit', () => {
    const owner = { scope: 'system' as const, name: 'halo.service' }
    expect(planStart({ ...linux, runningPid: 42, owner })).toEqual({ action: 'running', pid: 42, owner })
    expect(planStart({ ...linux, runningPid: 42 })).toEqual({ action: 'running', pid: 42, owner: null })
  })

  it('restart of our own running user unit → user unit (rewrite + restart)', () => {
    const owner = { scope: 'user' as const, name: 'halo.service' }
    expect(planStart({ ...linux, runningPid: 42, owner, restart: true })).toEqual({ action: 'user-unit' })
    // Plain `start -d` still refuses.
    expect(planStart({ ...linux, runningPid: 42, owner })).toMatchObject({ action: 'running' })
    // A different user unit is never adopted.
    const other = { scope: 'user' as const, name: 'my-halo.service' }
    expect(planStart({ ...linux, runningPid: 42, owner: other, restart: true })).toMatchObject({ action: 'running' })
  })
})
