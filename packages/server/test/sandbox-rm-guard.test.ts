import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { assertRmSafe } from '../src/tools/sandbox.js'

/**
 * Contract: assertRmSafe rejects rm/rmdir whose target is the filesystem
 * root, $HOME, ~/.halo, the workspace root, a parent of any of those, or a
 * system directory / its direct children — including "everything in X" globs
 * and unset-variable paths that collapse to one of those. Ordinary deletes
 * inside the workspace or under /tmp pass untouched.
 */
const HOME = os.homedir()
const WS = path.join(HOME, 'projects', 'demo')

const blocked = (cmd: string) => expect(() => assertRmSafe(cmd, WS), cmd).toThrow(/rm blocked/)
const allowed = (cmd: string) => expect(() => assertRmSafe(cmd, WS), cmd).not.toThrow()

describe('assertRmSafe', () => {
  it('blocks root, home, ~/.halo and the workspace root', () => {
    blocked('rm -rf /')
    blocked('rm -rf ~')
    blocked('rm -rf ~/')
    blocked('rm -rf $HOME')
    blocked('rm -rf "${HOME}"')
    blocked('rm -r ~/.halo')
    blocked(`rm -rf ${WS}`)
    blocked('rm -rf .')
    blocked('rm -rf ./')
    blocked('rm -rf ..')
    blocked(`rm -rf ${path.dirname(HOME)}`)
  })

  it('blocks system dirs and their direct children', () => {
    blocked('rm -rf /usr')
    blocked('rm -rf /etc/ssh')
    blocked('rm -rf /tmp')
    blocked('rmdir /var/log')
  })

  it('blocks everything-globs whose parent is protected', () => {
    blocked('rm -rf ~/*')
    blocked('rm -rf ./*')
    blocked('rm -rf *')
    blocked('rm -rf .*')
    blocked('rm -rf /*')
  })

  it('blocks unset-variable paths that collapse to a protected dir', () => {
    blocked('rm -rf "$BUILD_DIR/"')
    blocked('rm -rf ${OUT}/*')
    blocked('rm -rf ~/$SUBDIR')
  })

  it('sees through wrappers, paths, chaining and cd', () => {
    blocked('sudo rm -rf /usr')
    blocked('/bin/rm -rf ~')
    blocked('env FOO=1 rm -rf ~')
    blocked('echo ok && rm -rf ~')
    blocked('true; rm -r ~')
    blocked('cd .. && rm -rf demo')
    blocked('cd / && rm -rf usr')
    blocked('find . | xargs -0 rm -rf ~')
    blocked('rm -rf -- ~')
    blocked('(rm -rf ~)')
    blocked('if true; then rm -rf ~; fi')
    blocked('for d in a b; do rm -rf ~; done')
  })

  it('allows ordinary deletes', () => {
    allowed('rm -rf node_modules dist')
    allowed('rm -f ./build/*.log')
    allowed('rm -rf .halo/tmp/run-1')
    allowed('rm -rf /tmp/scratch-123')
    allowed('rm -rf /tmp/build-*')
    allowed(`rm -rf ${WS}/out`)
    allowed('rm -rf ~/projects/other/cache')
    allowed('rm -rf *.o')
    allowed('rm -rf "$HOME/.cache/pip"')
    allowed('rm file 2>/dev/null')
    allowed('rm file > /dev/null')
    allowed('echo "rm -rf /" > notes.txt')
    allowed('grep -r "rm -rf ~" .')
    allowed('git rm -r --cached ~')
  })

  it('skips heredoc bodies but still checks commands after them', () => {
    allowed("cat > clean.sh <<'EOF'\nrm -rf \"$OUT\"/*\nrm -rf ~\nEOF\nchmod +x clean.sh")
    allowed('cat <<-EOF > x.sh\n\trm -rf ~\n\tEOF')
    allowed('cat <<EOF >a && cat <<EOF2 >b\nrm -rf ~\nEOF\nrm -rf /\nEOF2')
    blocked("cat > a.txt <<'EOF'\nhello\nEOF\nrm -rf ~")
    blocked('cat <<< "x"; rm -rf ~')
  })
})
