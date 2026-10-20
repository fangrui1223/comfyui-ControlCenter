import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: vi.fn() } }))
vi.mock('./telemetry', () => ({ emit: vi.fn() }))
vi.mock('../sources/standalone/macRepair', () => ({
  removeQuarantine: vi.fn(),
  codesignBinaries: vi.fn()
}))
import { configurePygit2, inspectGitUpdate, resetGitAvailableCache, resetPygit2State } from './git'

let root: string | undefined
afterEach(() => {
  resetPygit2State()
  resetGitAvailableCache()
  vi.unstubAllEnvs()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe('plugin Git update cache inspection', () => {
  it.each(['system Git', 'pygit2'])(
    '%s ignores untracked Python caches and preserves real changes without writes',
    async (backend) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-git-cache-'))
      const repo = path.join(root, 'repo')
      fs.mkdirSync(repo)
      const git = (...args: string[]) =>
        execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
      const write = (relative: string, contents = 'fixture') => {
        const target = path.join(repo, relative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, contents)
        return target
      }
      git('init', '-b', 'main', '--template=')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      git('config', 'core.autocrlf', 'false')
      git('config', 'core.fsmonitor', 'false')
      write('__init__.py', '# original\n')
      write('tracked/__pycache__/node.cpython-313.pyc', 'tracked cache')
      git('add', '.')
      git('commit', '-m', 'fixture')
      const commit = git('rev-parse', 'HEAD')
      git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
      git('update-ref', 'refs/remotes/origin/main', commit)
      git('config', 'branch.main.remote', 'origin')
      git('config', 'branch.main.merge', 'refs/heads/main')
      // Avoid open_repo's legacy directory repair during this read-only test.
      fs.mkdirSync(path.join(repo, '.git/refs/tags'), { recursive: true })
      vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
      vi.stubEnv('COMFY_FORCE_PYGIT2', '')
      if (backend === 'pygit2') {
        configurePygit2(
          process.env.FR_TEST_PYTHON ?? path.resolve('bootstrap-python/win-x64/python.exe'),
          path.resolve('lib/git_operations.py')
        )
      }
      const fingerprint = () =>
        ['HEAD', 'index', 'config'].map((name) =>
          crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(repo, '.git', name)))
            .digest('hex')
        )
      const check = async (dirty: boolean, label: string) => {
        const before = fingerprint()
        expect(await inspectGitUpdate(repo), label).toMatchObject({
          dirty,
          localCommit: commit,
          remoteCommit: commit,
          ahead: 0,
          behind: 0,
          fetchError: null
        })
        expect(fingerprint(), label).toEqual(before)
      }
      const cache = write('__pycache__/__init__.cpython-313.pyc', 'root cache')
      write('nodes/__pycache__/node.cpython-313.opt-1.pyc', 'nested cache')
      await check(false, 'only untracked caches')
      for (const relative of [
        '__pycache__/custom_node.py',
        'custom_node.pyc',
        'my__pycache__/custom_node.pyc',
        '__pycache__/folder.pyc/config.json',
        '配置/设置.json'
      ]) {
        const target = write(relative)
        await check(true, relative)
        fs.unlinkSync(target)
      }
      write('__init__.py', '# local edit\n')
      await check(true, 'modified tracked source mixed with caches')
      write('__init__.py', '# original\n')
      const trackedCache = write('tracked/__pycache__/node.cpython-313.pyc', 'modified cache')
      await check(true, 'modified tracked cache')
      fs.unlinkSync(trackedCache)
      await check(true, 'deleted tracked cache')
      write('tracked/__pycache__/node.cpython-313.pyc', 'tracked cache')
      git('add', '__pycache__/__init__.cpython-313.pyc')
      await check(true, 'staged cache')
      expect(fs.readFileSync(cache, 'utf8')).toBe('root cache')
      expect(
        fs.readFileSync(path.join(repo, 'nodes/__pycache__/node.cpython-313.opt-1.pyc'), 'utf8')
      ).toBe('nested cache')
    }
  )
})

describe('plugin inspection with inherited Git configuration', () => {
  it.each(['SYSTEM', 'GLOBAL'])(
    'honors %s line endings and ignore rules without enabling them for networking',
    (level) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-git-config-'))
      const repo = path.join(root, 'repo')
      const configDir = path.join(root, 'config')
      fs.mkdirSync(repo)
      fs.mkdirSync(configDir)
      const ignored = path.join(root, 'ignored')
      fs.writeFileSync(ignored, 'local-session.json\n')
      const config =
        '[core]\n autocrlf = true\n excludesFile = ' + ignored.replaceAll('\\', '/') + '\n'
      const systemConfig = path.join(configDir, 'gitconfig')
      const globalConfig = path.join(configDir, '.gitconfig')
      fs.writeFileSync(systemConfig, level === 'SYSTEM' ? config : '')
      fs.writeFileSync(globalConfig, level === 'GLOBAL' ? config : '')
      vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig)
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', undefined)
      const git = (...args: string[]) =>
        execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
      git('init', '-b', 'main', '--template=')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      git('config', 'core.fsmonitor', 'false')
      git('config', '--unset', 'core.symlinks')
      expect(git('config', '--get', 'core.autocrlf')).toBe('true')
      const source = path.join(repo, 'nodes.py')
      fs.writeFileSync(source, 'VALUE = 1\r\nSECOND = 2\r\n')
      git('add', '.')
      git('commit', '-m', 'fixture')
      git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
      fs.writeFileSync(source, 'VALUE = 1\r\nSECOND = 2\r\n')
      fs.writeFileSync(path.join(repo, 'local-session.json'), '{}')
      fs.mkdirSync(path.join(repo, '__pycache__'))
      fs.writeFileSync(path.join(repo, '__pycache__/nodes.cpython-313.pyc'), 'cache')
      const fingerprint = () =>
        ['HEAD', 'index', 'config'].map((name) =>
          crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(repo, '.git', name)))
            .digest('hex')
        )
      const inspect = (dirty: boolean) => {
        const before = fingerprint()
        const result = spawnSync(
          process.env.FR_TEST_PYTHON ?? path.resolve('bootstrap-python/win-x64/python.exe'),
          [
            '-B',
            '-c',
            [
              'import sys,runpy,pygit2',
              'from pygit2.enums import ConfigLevel as L',
              'pygit2.option(pygit2.GIT_OPT_SET_OWNER_VALIDATION,0)',
              'levels=(L.SYSTEM,L.XDG,L.GLOBAL)',
              '[(pygit2.settings.search_path.__setitem__(x,sys.argv[1] if x==getattr(L,sys.argv[2]) else "")) for x in levels]',
              'sys.path.insert(0,sys.argv[3])',
              'sys.argv=[sys.argv[3]+"/git_operations.py","inspect-update",sys.argv[4]]',
              'runpy.run_path(sys.argv[0],run_name="__main__")',
              'assert all(pygit2.settings.search_path[x]=="" for x in levels), "Network config hardening was not restored"'
            ].join(';'),
            configDir,
            level,
            path.resolve('lib'),
            repo
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 10000 }
        )
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ dirty })
        expect(fingerprint()).toEqual(before)
      }
      expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')
      inspect(false)
      fs.writeFileSync(source, 'VALUE = 999\r\nSECOND = 2\r\n')
      inspect(true)
      fs.writeFileSync(source, 'VALUE = 1\r\nSECOND = 2\r\n')
      git('mv', 'nodes.py', 'renamed.py')
      inspect(true)
    }
  )
})

describe.skipIf(process.platform !== 'win32')('Windows long-path Git update inspection', () => {
  it.each([false, true])(
    'recovers long-path inspection (dirty=%s) without changing source or Git metadata',
    async (dirty) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-git-long-path-'))
      const repo = path.join(root, 'repo')
      fs.mkdirSync(repo)
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['--no-optional-locks', '-c', 'core.longpaths=true', '-C', repo, ...args],
          { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim()
      git('init', '-b', 'main', '--template=')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      git('config', 'core.longpaths', 'false')
      git('config', 'core.autocrlf', 'false')
      const workflow = path.join(repo, 'examples', 'a'.repeat(90), 'b'.repeat(160) + '.json')
      expect(workflow.length).toBeGreaterThan(260)
      fs.mkdirSync(path.dirname(workflow), { recursive: true })
      fs.writeFileSync(workflow, 'original workflow\n')
      git('add', '.')
      git('commit', '-m', 'before')
      const before = git('rev-parse', 'HEAD')
      fs.writeFileSync(path.join(repo, 'version.txt'), 'target')
      git('add', '.')
      git('commit', '-m', 'target')
      const target = git('rev-parse', 'HEAD')
      git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
      git('update-ref', 'refs/remotes/origin/main', target)
      git('config', 'branch.main.remote', 'origin')
      git('config', 'branch.main.merge', 'refs/heads/main')
      git('reset', '--hard', before)
      fs.mkdirSync(path.join(repo, '.git/refs/tags'), { recursive: true })
      const contents = dirty ? 'keep this local workflow edit\n' : 'original workflow\n'
      fs.writeFileSync(workflow, contents)
      const metadata = ['HEAD', 'index', 'config'].map((name) => path.join(repo, '.git', name))
      const fingerprint = () =>
        metadata.map((name) =>
          crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex')
        )
      const original = fingerprint()
      const python =
        process.env.FR_TEST_PYTHON ?? path.resolve('bootstrap-python/win-x64/python.exe')
      const helper = path.resolve('lib/git_operations.py')
      vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
      vi.stubEnv('COMFY_FORCE_PYGIT2', '')
      const failed = spawnSync(python, ['-B', helper, 'inspect-update', repo], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      })
      expect(failed.status).not.toBe(0)
      expect(failed.stderr).toContain('path too long')
      configurePygit2(python, helper)
      const result = await inspectGitUpdate(repo, false)
      expect(result).toMatchObject({
        branch: 'main',
        localCommit: before,
        remoteCommit: target,
        dirty,
        ahead: 0,
        behind: 1,
        fetchError: null
      })
      expect(fingerprint()).toEqual(original)
      expect(fs.readFileSync(workflow, 'utf8')).toBe(contents)
    }
  )
})
