import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: vi.fn() } }))
vi.mock('./telemetry', () => ({ emit: vi.fn() }))
vi.mock('../sources/standalone/macRepair', () => ({
  removeQuarantine: vi.fn(),
  codesignBinaries: vi.fn()
}))

import { configurePygit2, gitExportTree, resetGitAvailableCache, resetPygit2State } from './git'
import { pluginSourceManifest, verifyPluginSource } from './pluginSourceManifest'

const python = process.env.FR_TEST_PYTHON ?? path.resolve('bootstrap-python/win-x64/python.exe')
let root: string

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', directory, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function write(directory: string, name: string, value: string | Buffer): void {
  const destination = path.join(directory, name)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, value)
}

function fixture(attributes = '', currentAttributes = '*.py text eol=lf\n') {
  const source = path.join(root, 'installed')
  fs.mkdirSync(source)
  git(source, 'init', '-b', 'main', '--template=')
  git(source, 'config', 'user.name', 'Fixture')
  git(source, 'config', 'user.email', 'fixture@example.invalid')
  git(source, 'config', 'core.autocrlf', 'false')
  write(source, '__init__.py', 'VALUE = 1\n')
  write(source, 'unchanged.txt', 'keep existing checkout bytes\n')
  write(source, '.gitattributes', currentAttributes)
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'before')
  const before = git(source, 'rev-parse', 'HEAD')
  write(source, '.gitattributes', attributes)
  write(source, '__init__.py', 'VALUE = 2\nSECOND = 3\n')
  write(source, 'nested/带 空格.py', 'VALUE = 4\n')
  write(source, 'binary.dat', Buffer.from([0, 13, 10, 65, 10, 255]))
  write(source, 'verbatim.txt', 'one\ntwo\n')
  write(source, 'not-in-archive.txt', 'export-ignore must still be checked\n')
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'target')
  const target = git(source, 'rev-parse', 'HEAD')
  git(source, 'checkout', before)
  return { source, before, target }
}

function fingerprint(source: string) {
  const names = [
    '.git/HEAD',
    '.git/index',
    '.git/config',
    ...git(source, 'ls-files', '-z').split('\0').filter(Boolean)
  ]
  return names.map((name) => [
    name,
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(source, name)))
      .digest('hex')
  ])
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-source-checkout-test-'))
  write(root, 'global.gitconfig', '[core]\n autocrlf = true\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('COMFY_FORCE_PYGIT2', '')
  vi.stubEnv('CM_USE_PYGIT2', '')
  vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
  resetGitAvailableCache()
  resetPygit2State()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetGitAvailableCache()
  resetPygit2State()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Git plugin source approval and real checkout', () => {
  it('uses Manager system Git formatting even when the launcher fetches with pygit2', async () => {
    const { source, target } = fixture('verbatim.txt -text\nnot-in-archive.txt export-ignore\n')
    git(source, 'config', '--unset', 'core.autocrlf')
    configurePygit2(python, path.resolve('lib/git_operations.py'))
    const initial = fingerprint(source)
    const staged = path.join(root, 'staged')
    await gitExportTree(source, target, staged)
    expect(fingerprint(source)).toEqual(initial)
    expect(fs.readFileSync(path.join(staged, '__init__.py'), 'utf8')).toBe(
      'VALUE = 2\r\nSECOND = 3\r\n'
    )
    expect(fs.readFileSync(path.join(staged, 'verbatim.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(fs.readFileSync(path.join(staged, 'binary.dat'))).toEqual(
      Buffer.from([0, 13, 10, 65, 10, 255])
    )
    expect(fs.existsSync(path.join(staged, 'not-in-archive.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(staged, 'unchanged.txt'), 'utf8')).toBe(
      'keep existing checkout bytes\n'
    )
    const approved = await pluginSourceManifest(staged)
    git(source, 'checkout', target)
    await expect(verifyPluginSource(source, approved)).resolves.toBeUndefined()
    write(source, '__init__.py', 'VALUE = 999\r\nSECOND = 3\r\n')
    await expect(verifyPluginSource(source, approved)).rejects.toThrow('__init__.py')
    fs.copyFileSync(path.join(staged, '__init__.py'), path.join(source, '__init__.py'))
    write(source, 'binary.dat', Buffer.from([0, 10, 65, 10, 255]))
    await expect(verifyPluginSource(source, approved)).rejects.toThrow('binary.dat')
  })

  it.each(['true', 'false', 'input'])(
    'matches system Git with core.autocrlf=%s and target attributes',
    async (autocrlf) => {
      const { source, target } = fixture('*.py text eol=crlf\nverbatim.txt -text\n')
      git(source, 'config', 'core.autocrlf', autocrlf)
      const initial = fingerprint(source)
      const staged = path.join(root, 'staged')
      await gitExportTree(source, target, staged)
      expect(fingerprint(source)).toEqual(initial)
      const approved = await pluginSourceManifest(staged)
      git(source, 'checkout', target)
      await expect(verifyPluginSource(source, approved)).resolves.toBeUndefined()
      expect(fs.readFileSync(path.join(staged, '__init__.py'), 'utf8')).toContain('\r\n')
    }
  )

  it('honors info attributes and the configured external attributes file', async () => {
    const { source, target } = fixture('')
    write(source, '.git/info/attributes', '*.py text eol=crlf\n')
    write(root, 'external attributes', '*.txt text eol=lf\n')
    git(source, 'config', 'core.attributesFile', path.join(root, 'external attributes'))
    const initial = fingerprint(source)
    const staged = path.join(root, 'staged')
    await gitExportTree(source, target, staged)
    expect(fingerprint(source)).toEqual(initial)
    git(source, 'checkout', target)
    await expect(
      verifyPluginSource(source, await pluginSourceManifest(staged))
    ).resolves.toBeUndefined()
  })

  it.each(['', '*.py text eol=crlf\nverbatim.txt -text\n'])(
    'matches the forced Manager pygit2 backend (%s)',
    async (attributes) => {
      const { source, target } = fixture(attributes, attributes)
      git(source, 'config', 'core.autocrlf', 'true')
      configurePygit2(python, path.resolve('lib/git_operations.py'))
      vi.stubEnv('COMFY_FORCE_PYGIT2', '1')
      const initial = fingerprint(source)
      const staged = path.join(root, 'staged')
      await gitExportTree(source, target, staged)
      expect(fingerprint(source)).toEqual(initial)
      execFileSync(
        python,
        [
          '-I',
          '-B',
          '-c',
          'import sys; sys.path.insert(0,sys.argv[1]); import git_operations as g; g.harden_pygit2_config(); import pygit2; r=pygit2.Repository(sys.argv[2]); r.checkout_tree(r.revparse_single(sys.argv[3]), strategy=pygit2.enums.CheckoutStrategy.FORCE)',
          path.resolve('lib'),
          source,
          target
        ],
        { windowsHide: true }
      )
      await expect(
        verifyPluginSource(source, await pluginSourceManifest(staged))
      ).resolves.toBeUndefined()
    }
  )

  it.each(['system', 'pygit2'])(
    'blocks custom checkout filters without running them (%s)',
    async (backend) => {
      const { source, target } = fixture('*.py filter=fixture\n', '*.py filter=fixture\n')
      write(
        root,
        'filter.js',
        `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'filter-ran'))}, 'unsafe')`
      )
      git(
        source,
        'config',
        'filter.fixture.smudge',
        `node "${path.join(root, 'filter.js').replaceAll('\\', '/')}"`
      )
      git(source, 'config', 'filter.fixture.required', 'true')
      if (backend === 'pygit2') {
        configurePygit2(python, path.resolve('lib/git_operations.py'))
        vi.stubEnv('COMFY_FORCE_PYGIT2', '1')
      }
      const initial = fingerprint(source)
      await expect(gitExportTree(source, target, path.join(root, 'staged'))).rejects.toThrow(
        'filter requires separate review'
      )
      expect(fingerprint(source)).toEqual(initial)
      expect(fs.existsSync(path.join(root, 'filter-ran'))).toBe(false)
    }
  )

  it('matches Manager pygit2 ignoring global autocrlf configuration', async () => {
    const { source, target } = fixture('', '')
    git(source, 'config', '--unset', 'core.autocrlf')
    configurePygit2(python, path.resolve('lib/git_operations.py'))
    vi.stubEnv('CM_USE_PYGIT2', '1')
    const staged = path.join(root, 'staged')
    await gitExportTree(source, target, staged)
    expect(fs.readFileSync(path.join(staged, 'verbatim.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  it.each(['system', 'pygit2'])('rejects Git links before creating them (%s)', async (backend) => {
    const { source } = fixture('')
    const blob = execFileSync('git', ['-C', source, 'hash-object', '-w', '--stdin'], {
      input: '../../outside',
      encoding: 'utf8',
      windowsHide: true
    }).trim()
    git(source, 'update-index', '--add', '--cacheinfo', `120000,${blob},unsafe-link`)
    git(source, 'commit', '-m', 'link target')
    const target = git(source, 'rev-parse', 'HEAD')
    if (backend === 'pygit2') {
      configurePygit2(python, path.resolve('lib/git_operations.py'))
      vi.stubEnv('COMFY_FORCE_PYGIT2', '1')
    }
    const staged = path.join(root, 'staged')
    await expect(gitExportTree(source, target, staged)).rejects.toThrow('Git links or submodules')
    expect(fs.readdirSync(staged)).toEqual([])
  })

  it('requires review before a pygit2 update changes checkout attributes', async () => {
    const { source, target } = fixture('')
    configurePygit2(python, path.resolve('lib/git_operations.py'))
    vi.stubEnv('CM_USE_PYGIT2', '1')
    const initial = fingerprint(source)
    const staged = path.join(root, 'staged')
    await expect(gitExportTree(source, target, staged)).rejects.toThrow(
      'Changes to .gitattributes require separate review'
    )
    expect(fingerprint(source)).toEqual(initial)
    expect(fs.readdirSync(staged)).toEqual([])
  })

  it('keeps CNR source verification byte-exact', async () => {
    const archive = path.join(root, 'cnr')
    write(archive, '__init__.py', 'VALUE = 1\n')
    const approved = await pluginSourceManifest(archive)
    write(archive, '__init__.py', 'VALUE = 1\r\n')
    await expect(verifyPluginSource(archive, approved)).rejects.toThrow('__init__.py')
  })
})
