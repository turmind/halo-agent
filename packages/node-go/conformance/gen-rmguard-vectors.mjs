// Regenerates internal/rmguard/testdata/vectors.json by running the server's
// TS assertRmSafe (sandbox.ts, loaded through tsx) over ~400 commands. Unlike
// the js-truth files these vectors track the codebase, so CI re-runs this with
// --check: exit 1 when the TS no longer produces the committed file.
//   node packages/node-go/conformance/gen-rmguard-vectors.mjs [--check]
//
// HOME is pinned (sandbox.ts reads os.homedir() at import), so the output
// doesn't depend on who runs it. In `vectors` the home and workspace paths are
// written as <HOME> / <WS>; `homes` re-imports the guard under odd HOME values
// and records them raw.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sandboxTs = pathToFileURL(path.join(here, '../../server/src/tools/sandbox.ts')).href
const out = path.join(here, '../internal/rmguard/testdata/vectors.json')
const { register } = await import(pathToFileURL(createRequire(path.join(here, '../../server/package.json')).resolve('tsx/esm/api')).href)
register()

// A fresh sandbox.ts per HOME via a query string: only that module is
// re-evaluated (tsImport reloads the whole tree per call and slows to a hang
// after ~6 calls).
let loads = 0
async function guardFor(home) {
  process.env.HOME = home
  const { assertRmSafe } = await import(`${sandboxTs}?home=${loads++}`)
  return (cmd, cwd) => {
    try { assertRmSafe(cmd, cwd); return 'ok' } catch (e) { return e.message }
  }
}

const HOME = '/home/tester'
const WS = `${HOME}/projects/demo`
const SUB = `${WS}/sub`

// ── sandbox-rm-guard.test.ts, verbatim (WS = HOME/projects/demo there too) ──
const fromTest = [
  'rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -rf $HOME', 'rm -rf "${HOME}"', 'rm -r ~/.halo', `rm -rf ${WS}`,
  'rm -rf .', 'rm -rf ./', 'rm -rf ..', `rm -rf ${path.dirname(HOME)}`,
  'rm -rf /usr', 'rm -rf /etc/ssh', 'rm -rf /tmp', 'rmdir /var/log',
  'rm -rf ~/*', 'rm -rf ./*', 'rm -rf *', 'rm -rf .*', 'rm -rf /*',
  'rm -rf "$BUILD_DIR/"', 'rm -rf ${OUT}/*', 'rm -rf ~/$SUBDIR',
  'sudo rm -rf /usr', '/bin/rm -rf ~', 'env FOO=1 rm -rf ~', 'echo ok && rm -rf ~', 'true; rm -r ~',
  'cd .. && rm -rf demo', 'cd / && rm -rf usr', 'find . | xargs -0 rm -rf ~', 'rm -rf -- ~', '(rm -rf ~)',
  'if true; then rm -rf ~; fi', 'for d in a b; do rm -rf ~; done',
  'rm -rf node_modules dist', 'rm -f ./build/*.log', 'rm -rf .halo/tmp/run-1', 'rm -rf /tmp/scratch-123',
  'rm -rf /tmp/build-*', `rm -rf ${WS}/out`, 'rm -rf ~/projects/other/cache', 'rm -rf *.o',
  'rm -rf "$HOME/.cache/pip"', 'rm file 2>/dev/null', 'rm file > /dev/null', 'echo "rm -rf /" > notes.txt',
  'grep -r "rm -rf ~" .', 'git rm -r --cached ~',
  "cat > clean.sh <<'EOF'\nrm -rf \"$OUT\"/*\nrm -rf ~\nEOF\nchmod +x clean.sh", 'cat <<-EOF > x.sh\n\trm -rf ~\n\tEOF',
  'cat <<EOF >a && cat <<EOF2 >b\nrm -rf ~\nEOF\nrm -rf /\nEOF2', "cat > a.txt <<'EOF'\nhello\nEOF\nrm -rf ~",
  'cat <<< "x"; rm -rf ~',
]

// ── targets × flag / quote spellings ──
const targets = [
  '/', '~', '~/', '$HOME', '${HOME}', '~/.halo', '~/.halo/', HOME, `${HOME}/.halo`, WS, `${WS}/`, '.', '..', '../..', '/home',
  '/usr', '/usr/local', '/usr/local/bin', '/etc', '/var/log', '/var/log/app', '/tmp', '/tmp/', '/tmp/x', '/root', '/root/x',
  '/private/tmp', '/private/tmp/x', '/opt/app', '/Users', '/Users/someone/x', '/srv/data/www',
  'src', './dist', 'a/b/c', '.halo', '.halo/tmp', '~/.halo/tmp', '~/projects', '~/projects/other', `${WS}/node_modules`, '../other',
]
// every target as `rm -rf t`, plus one other spelling in rotation
const spellings = [(t) => `rm "${t}"`, (t) => `rm -r -- '${t}'`, (t) => `rmdir ${t}`]
const combos = targets.flatMap((t, k) => [`rm -rf ${t}`, spellings[k % spellings.length](t)])

// ── separators, wrappers, cd chains, globs, variables, redirections, quoting ──
const seps = [';', ' ; ', '&&', ' && ', '||', '|', '&', '\n', ';;', '&\n', ' |& ']
const separators = seps.flatMap((s) => [`echo a${s}rm -rf ~`, `echo a${s}rm -rf build`])
const misc = [
  // wrappers / command words
  'nohup rm -rf ~', 'nice -n 10 rm -rf ~', 'time rm -rf /usr', 'exec rm -rf ~', 'command -p rm -rf ~', 'sudo -u root -E rm -rf /',
  'xargs rm -rf', 'env -i A=1 B=2 rm -rf ~', 'FOO=1 BAR=2 rm -rf ~', '!rm -rf ~', '{ rm -rf ~; }', '((rm -rf ~))',
  'while true; do rm -rf ~; done', 'until false; do rm -rf build; done', 'else rm -rf ~', 'elif rm -rf ~',
  '/usr/bin/rmdir ~', './rm -rf ~', 'rm/ -rf ~', 'srm -rf ~', 'rmx -rf ~', 'echo rm -rf ~', 'sudo', 'sudo -i', 'env',
  'git rm -rf .', 'busybox rm -rf ~', 'doas rm -rf ~', 'then', 'FOO=1',
  // cd chains
  'cd', 'cd && rm -rf .', 'cd; rm -rf projects', 'cd ~ && rm -rf *', 'cd /tmp && rm -rf *', 'cd /tmp && rm -rf x',
  'cd sub && rm -rf ..', 'cd sub && rm -rf ../x', 'cd - && rm -rf .', 'cd "$DIR" && rm -rf *', 'cd $UNSET && rm -rf .',
  'cd ../.. && rm -rf demo', 'cd ../.. && rm -rf other', 'cd /usr && rm -rf local', 'cd /usr/local && rm -rf bin',
  '(cd /tmp) && rm -rf .', '(cd /tmp && rm -rf *)', 'cd /tmp/a/b && rm -rf ../..', 'cd ~/.halo && rm -rf .',
  'cd ~/.halo && rm -rf tmp', 'cd / && cd home && rm -rf tester', 'cd $(pwd) && rm -rf .', 'cd x; cd y; rm -rf ../..',
  'cd "a b" && rm -rf ..', 'cd \\\n/tmp && rm -rf *',
  // globs
  'rm -rf **', 'rm -rf ?', 'rm -rf ..*', 'rm -rf .??*', 'rm -rf ~/.*', 'rm -rf ~/.c*', 'rm -rf /usr/*', 'rm -rf /usr/l*',
  'rm -rf /tmp/*', 'rm -rf /tmp/*/x', 'rm -rf build/*', 'rm -rf */', 'rm -rf "*"', 'rm -rf [ab]', 'rm -rf ~/[a-z]*',
  'rm -rf ./**/*.tmp', 'rm -rf /*/tester', 'rm -rf ~/*/x', 'rm -rf ../*',
  // variables / substitutions
  'rm -rf $PWD', 'rm -rf ${PWD}', 'rm -rf $(pwd)', 'rm -rf `pwd`', 'rm -rf $PWD/build', 'rm -rf "$PWD/.."',
  'rm -rf $HOMEDIR', 'rm -rf ${HOME}x', 'rm -rf $HOME/', 'rm -rf $HOME/.halo', 'rm -rf "$HOME"/projects/x',
  'rm -rf $1', 'rm -rf "$1/"', 'rm -rf $10', 'rm -rf ${X:-/tmp/y}', 'rm -rf $(mktemp -d)', 'rm -rf "$(dirname x)/"',
  'rm -rf `echo x`/', 'rm -rf $A$B', 'rm -rf /tmp/$X', 'rm -rf /usr/$X', 'rm -rf ~$X', 'rm -rf $X~', 'rm -rf ~user',
  'rm -rf ~user/x', 'rm -rf \\~', 'rm -rf "~"', "rm -rf '$HOME'", 'rm -rf $$', 'rm -rf $@/', 'rm -rf $_/',
  // redirections
  'rm x >/dev/null 2>&1', 'rm x 2> /dev/null ~', 'rm x > ~', 'rm x >> log', 'rm x &> /dev/null', 'rm x &>/dev/null ~',
  'rm x < ~', 'rm x 2>&1 ~', 'rm x >| f', 'rm x 1> f', 'rm >f ~', 'rm x >',
  // quoting / escaping
  'rm -rf "/"', "rm -rf '/'", 'rm -rf "~"/', 'rm -rf ""', "rm -rf ''", 'rm -rf "" ~', 'rm -rf "a b" ~/', 'rm -rf a\\ b',
  'rm -rf \\/', 'rm -rf "\\/"', "rm -rf '\\/'", 'rm -rf "x\\"y" ~', 'rm -rf "x;y" build', "rm -rf 'a;rm -rf ~'",
  'echo "x" ; rm "-rf" ~', 'rm -rf "unterminated ~', "echo 'a' && rm -rf ~", 'rm -rf ~\\\n/x', 'rm -rf\t~', 'rm -rf ~\r',
  'r\\m -rf ~', '"rm" -rf ~', "'rm' -rf /usr",
  // options
  'rm --recursive --force ~', 'rm -- -rf', 'rm -- --', 'rm -rf -- -- ~', 'rm -- -x ~/x', 'rm -i', 'rm',
  'rm -rf build -- ~', 'rm -rf build ~',
  // subshells / parens
  '(rm -rf build)', '(rm -rf ~/x)', 'x=$(rm -rf ~)', '(rm -rf "$(pwd)")', 'rm -rf (x)', 'rm -rf x)', 'rm -rf ~))',
  // heredocs
  'cat <<EOF\nrm -rf ~\nEOF', 'cat << EOF\nrm -rf ~\nEOF\nrm -rf ~', 'cat <<"EOF"\nrm -rf ~\nEOF', 'cat <<EOF\nrm -rf ~',
  'cat <<-EOF\n\t\trm -rf ~\n\t\tEOF\nrm -rf build', 'cat <<EOF\n  EOF\nrm -rf ~\nEOF', 'cat <<a.b-c_1\nrm -rf ~\na.b-c_1\nls',
  'cat <<<~; rm -rf build', 'cat <<- "E"\nrm -rf ~\nE', "cat <<-'EOF\nrm -rf ~", 'cat <<-;rm -rf ~', 'cat <<-\nrm -rf ~\n-',
  'cat <<"EOF\nrm -rf ~\nEOF', 'cat <<\nEOF\nrm -rf ~\nEOF', "cat <<'E F'\nrm -rf ~", 'cat <<EOF; rm -rf ~\nbody\nEOF',
  'echo "<<EOF"\nrm -rf ~', 'cat <<EOF >x\nEOF\n\nrm -rf ~', 'cat <<1\nrm -rf ~\n1',
  // non-ASCII (the TS walks UTF-16 code units, Go walks bytes) and JS \s / \b / [^}]
  'rm -rf "/home/tëster"', 'rm -rf 日本/*', 'rm -rf ~/😀', 'rm -rf \\😀 ~', 'rm -rf "\\😀" /', 'rm -rf /usr/é',
  'rm -rf $HOMEé', 'rm -rf $HOME_x', 'rm -rf "${A\nB}"/', 'rm -rf "$(a\nb)"/', 'cat <<\u00a0EOF\nrm -rf ~\nEOF',
  'cat <<\u2028EOF\nrm -rf ~\nEOF', 'cat <<\u3000"EOF"\nrm -rf ~\nEOF', 'cat <<\u0085EOF\nrm -rf ~\nEOF',
]

// ── a few of the above run from a different workspace root (node run's cwd) ──
const cwdCmds = ['rm -rf .', 'rm -rf ..', 'rm -rf ../..', 'rm -rf *', 'rm -rf x', 'cd .. && rm -rf sub', 'rm -rf $PWD', 'rm -rf ~/projects/x']
const cwds = [SUB, '/', HOME, `${WS}/a$&b`, `${WS}/a$'b`, `${WS}/a$Xb`, `${WS}/x/../y/`, `${HOME}/démo`]
const globCwds = [`${WS}/a[1]b`, `${WS}/a?b`, `${WS}/a*b`, '/srv/proj [v2]', `${HOME}/p*/q`, '/srv/[x/y']
const globCmds = [
  'rm -rf .', 'rm -rf ..', 'rm -rf $PWD', 'rm -rf "$PWD"/*', 'rm -rf ./*', 'rm -rf *', 'rm -rf .*', 'rm -rf ..*', 'rm -rf ../*',
  'rm -rf *.log', 'rm -rf a*', 'rm -rf x', 'rm -rf "$PWD/x"', 'cd .. && rm -rf .', 'cd x && rm -rf ..',
]
const globCdCmds = ['cd /srv/x[1] && rm -rf .', 'cd /srv/x[1] && rm -rf *', 'cd ~/* && rm -rf .', 'cd ~/p? && rm -rf ..', 'cd /tmp/* && rm -rf x']
// a narrow glob is judged by its literal self (a quoted path is no pattern)
const literalGlobCases = [
  ['cd "/srv/proj [v2]" && rm -rf .', '/srv/proj [v2]'], ['rm -rf "/srv/proj [v2]"', '/srv/proj [v2]'], ['cd /srv && rm -rf "proj [v2]"', '/srv/proj [v2]'],
  ['rm -rf "/srv/proj [v2]/x"', '/srv/proj [v2]'], ['rm -rf *.log', '/srv/proj [v2]'], ['rm -rf ../a[1]b', `${WS}/a[1]b`], ['rm -rf ../a?b', `${WS}/a[1]b`],
  ['rm -rf "../a[1]b"/x', `${WS}/a[1]b`], ['rm -rf *.log', `${WS}/a[1]b`], ['rm -rf /usr/l*', WS], ['rm -rf "/usr/[x]"', WS], ['rm -rf /etc/ss?', WS],
  ['rm -rf /home/*.bak', WS], ['rm -rf /var/log/*.gz', WS], ['rm -rf /u?r', WS], ['rm -rf /[t]mp', WS], ['rm -rf "/tmp/a*b"', WS],
  ['rm -rf ~/projects/d?mo', WS], ['rm -rf ~/project?', WS], ['rm -rf ~/projects/[a-z]*', WS], ['rm -rf "~/projects/de[m]o"', WS],
]

const vectors = [
  ...[...new Set([...fromTest, ...combos, ...separators, ...misc])].map((cmd) => [cmd, WS]),
  ...cwds.flatMap((cwd) => cwdCmds.map((cmd) => [cmd, cwd])),
  ["cd '/tmp/$&x' && rm -rf $PWD", WS],
  ["cd '/tmp/$Xy' && rm -rf $PWD", WS],
  // glob chars in the workspace path are a name, not a pattern; the command's own globs still count
  ...globCwds.flatMap((cwd) => globCmds.map((cmd) => [cmd, cwd])),
  ...globCdCmds.map((cmd) => [cmd, WS]),
  ...literalGlobCases,
]

const check = await guardFor(HOME)
const hold = (s) => s.replaceAll(WS, '<WS>').replaceAll(HOME, '<HOME>')
const unhold = (s) => s.replaceAll('<WS>', WS).replaceAll('<HOME>', HOME)
const rows = vectors.map(([cmd, cwd]) => {
  const row = { cmd: hold(cmd), cwd: hold(cwd), result: hold(check(cmd, cwd)) }
  if (unhold(row.cmd) !== cmd || unhold(row.cwd) !== cwd || unhold(row.result) !== check(cmd, cwd)) throw new Error(`placeholder round trip: ${JSON.stringify(cmd)}`)
  return row
})

// ── odd HOME values: container root, trailing slash, `$&` / `$X` (inserted literally), / ──
const homeCmds = ['rm -rf ~', 'rm -rf ~/x', 'rm -rf $HOME/x', 'rm -rf /root', 'rm -rf /root/x', 'cd && rm -rf .', 'cd && rm -rf x', 'rm -rf ~/.halo/x']
const homes = []
for (const home of ['/root', '/home/tester/', '/home/x$&y', "/home/x$'y", '/home/u$X', '/']) {
  const g = await guardFor(home)
  for (const cmd of homeCmds) homes.push({ home, cmd, cwd: '/srv/ws', result: g(cmd, '/srv/ws') })
}
// glob chars in HOME: a name, not a pattern
const globHomeCmds = [...homeCmds, 'rm -rf ~/*', 'rm -rf $HOME/.*', 'cd && rm -rf *', 'rm -rf ~/*.log', 'cd ~/x && rm -rf ..']
for (const home of ['/home/x[1]y', '/home/a?b', '/home/x*', '/srv/[h']) {
  const g = await guardFor(home)
  // …and the home written out literally (quoted: no pattern)
  const literal = [`rm -rf "${home}"`, `cd "${home}" && rm -rf .`, `rm -rf "${home}/.halo"`, `rm -rf "${home}/z"`]
  for (const cmd of [...globHomeCmds, ...literal]) homes.push({ home, cmd, cwd: '/srv/ws', result: g(cmd, '/srv/ws') })
}

const text = `{"home":${JSON.stringify(HOME)},"ws":${JSON.stringify(WS)},"vectors":[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n],"homes":[\n${homes.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`
const blocked = rows.filter((r) => r.result !== 'ok').length

if (process.argv.includes('--check')) {
  const old = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  if (old !== text) {
    const a = old.split('\n')
    const b = text.split('\n')
    const k = b.findIndex((l, i) => l !== a[i])
    console.error(`[rmguard] ${out} is stale vs the TS assertRmSafe (first diff at line ${k + 1}):\n- ${a[k] ?? ''}\n+ ${b[k] ?? ''}\nRe-run without --check and port the change to internal/rmguard.`)
    process.exit(1)
  }
  console.log(`[rmguard] vectors up to date: ${rows.length} (${rows.length - blocked} ok, ${blocked} blocked) + ${homes.length} homes`)
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text)
  console.log(`[rmguard] wrote ${rows.length} vectors (${rows.length - blocked} ok, ${blocked} blocked) + ${homes.length} homes → ${out}`)
}
