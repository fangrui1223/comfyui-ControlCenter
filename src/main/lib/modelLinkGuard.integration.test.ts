// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { once } from 'events'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { recoverModelLink, trackModelLinkChild, withProtectedModelLink } from './modelLinkGuard'
import { recoverInterruptedComfyOp } from './opMarker'

vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: vi.fn() } }))
vi.mock('./telemetry', () => ({ emit: vi.fn() }))
vi.mock('../sources/standalone/macRepair', () => ({
  removeQuarantine: vi.fn(),
  codesignBinaries: vi.fn()
}))
import {
  configurePygit2,
  resetPygit2State,
  gitResetHard,
  gitCheckoutCommit,
  gitFetchAndCheckout
} from './git'

const project = process.cwd()
const python =
  process.env.FR_TEST_PYTHON ?? path.join(project, 'bootstrap-python', 'win-x64', 'python.exe')
let root: string
let origin: string
let repo: string
let models: string
let shared: string
let before: string
let after: string

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function check(): void {
  expect(fs.lstatSync(models).isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(models)).toBe(fs.realpathSync(shared))
  expect(fs.readFileSync(path.join(models, 'LLM', 'sentinel.gguf'), 'utf8')).toBe(
    'GGUF shared model sentinel'
  )
  expect(fs.readFileSync(path.join(shared, 'configs', 'v1.yaml'), 'utf8')).toBe(
    'keep shared config'
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-model-link-git-'))
  origin = path.join(root, 'origin')
  repo = path.join(root, 'ComfyUI')
  shared = path.join(root, 'shared')
  models = path.join(repo, 'models')
  fs.mkdirSync(path.join(origin, 'models', 'configs'), { recursive: true })
  git(origin, 'init', '-b', 'master')
  git(origin, 'config', 'user.name', 'Fixture')
  git(origin, 'config', 'user.email', 'fixture@example.invalid')
  fs.writeFileSync(path.join(origin, 'models', 'configs', 'v1.yaml'), 'old core config')
  fs.writeFileSync(path.join(origin, '.gitignore'), 'models/**/*.gguf\n')
  fs.writeFileSync(path.join(origin, 'version.txt'), 'old')
  git(origin, 'add', '.')
  git(origin, 'commit', '-m', 'old')
  before = git(origin, 'rev-parse', 'HEAD')
  git(root, 'clone', origin, repo)
  fs.writeFileSync(path.join(origin, 'models', 'configs', 'v1.yaml'), 'new core config')
  fs.writeFileSync(path.join(origin, 'version.txt'), 'new')
  git(origin, 'add', '.')
  git(origin, 'commit', '-m', 'new')
  git(origin, 'tag', 'v9.8.7')
  after = git(origin, 'rev-parse', 'HEAD')
  fs.mkdirSync(path.join(shared, 'LLM'), { recursive: true })
  fs.mkdirSync(path.join(shared, 'configs'))
  fs.writeFileSync(path.join(shared, 'LLM', 'sentinel.gguf'), 'GGUF shared model sentinel')
  fs.writeFileSync(path.join(shared, 'configs', 'v1.yaml'), 'keep shared config')
  fs.renameSync(models, path.join(root, 'original-core-models'))
  fs.symlinkSync(shared, models, process.platform === 'win32' ? 'junction' : 'dir')
})

afterEach(() => {
  resetPygit2State()
  if (!path.basename(root).startsWith('fr-model-link-git-') || path.dirname(root) !== os.tmpdir())
    throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('real Git operations with shared models', () => {
  it('protects models across native Git hard reset and rollback', async () => {
    git(repo, 'fetch', 'origin')
    expect((await gitResetHard(repo, after, () => {})).exitCode).toBe(0)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(after)
    check()
    expect((await gitCheckoutCommit(repo, before, () => {})).exitCode).toBe(0)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    check()
  })

  it.runIf(fs.existsSync(python))(
    'protects pygit2 fetch/checkout and snapshot rollback entry points',
    async () => {
      configurePygit2(python, path.join(project, 'lib', 'git_operations.py'))
      const moved = await gitFetchAndCheckout(repo, after, () => {})
      expect(moved.exitCode, moved.stderr).toBe(0)
      check()
      const restored = await gitCheckoutCommit(repo, before, () => {})
      expect(restored.exitCode, restored.stderr).toBe(0)
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
      check()
      fs.writeFileSync(path.join(repo, 'version.txt'), 'local source edit')
      const conflict = await gitCheckoutCommit(repo, after, () => {})
      expect(conflict.exitCode).not.toBe(0)
      expect(fs.readFileSync(path.join(repo, 'version.txt'), 'utf8')).toBe('local source edit')
      check()
    }
  )

  it('retains the journal until a still-running Git child has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const closed = once(child, 'close')
    try {
      await expect(
        withProtectedModelLink(repo, async () => {
          trackModelLinkChild(repo, child)
          return 'premature process completion'
        })
      ).rejects.toThrow('in use by process')
      expect(() => recoverModelLink(repo)).toThrow('in use by process')
    } finally {
      child.kill()
      await closed
    }
    expect(recoverModelLink(repo)).toBe(true)
    check()
  })

  it('recovers an actual forcibly terminated update process on the next launch', async () => {
    git(repo, 'fetch', 'origin')
    const module = path.join(root, 'guard.cjs')
    fs.writeFileSync(
      module,
      ts.transpileModule(
        fs.readFileSync(path.join(project, 'src/main/lib/modelLinkGuard.ts'), 'utf8'),
        {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true
          }
        }
      ).outputText
    )
    const runner = path.join(root, 'crash.cjs')
    fs.writeFileSync(
      runner,
      `const {withProtectedModelLink}=require(${JSON.stringify(module)});
      withProtectedModelLink(${JSON.stringify(repo)}, async () => {
        require('child_process').execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'reset', '--hard', ${JSON.stringify(after)}], {stdio:'ignore',windowsHide:true});
        process.stdout.write('ready');
        await new Promise(() => setInterval(() => {}, 1000));
      }).catch(error => { console.error(error); process.exit(1); });`
    )
    const child = spawn(process.execPath, [runner], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const closed = once(child, 'close')
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        closed.then(() => {
          throw new Error('Fixture updater exited before checkpoint')
        })
      ])
      expect(fs.lstatSync(models).isSymbolicLink()).toBe(false)
    } finally {
      child.kill()
      await closed
    }
    expect(await recoverInterruptedComfyOp(root)).toBe(true)
    check()
  })

  it.runIf(fs.existsSync(python))(
    'protects the actual pygit2 updater, repeat updates, and a failed target selection',
    async () => {
      const updater = path.join(project, 'lib', 'update_comfyui.py')
      const run = async (...args: string[]): Promise<string> =>
        withProtectedModelLink(repo, async (guarded) => {
          try {
            return execFileSync(python, ['-B', '-s', updater, repo, ...args], {
              encoding: 'utf8',
              windowsHide: true,
              env: {
                ...process.env,
                FR_MODELS_LINK_GUARDED: guarded ? '1' : '0',
                COMFY_FORCE_PYGIT2: '1'
              }
            })
          } catch (error) {
            const detail = error as Error & { stdout?: string; stderr?: string }
            throw new Error(`${detail.message}\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`, {
              cause: error
            })
          }
        })
      const output = await run('--stable')
      expect(output).toContain('[CHECKED_OUT_TAG] v9.8.7')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(after)
      const branch = /\[BACKUP_BRANCH\] (.+)/.exec(output)![1]!.trim()
      expect(git(repo, 'show', `${branch}:models/configs/v1.yaml`)).toBe('old core config')
      check()
      await run('--stable')
      check()
      await expect(run('--tag', 'v0.0.0')).rejects.toThrow()
      check()
    }
  )
})
