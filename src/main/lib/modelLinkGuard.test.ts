// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { recoverModelLink, withProtectedModelLink } from './modelLinkGuard'

let root: string
let repo: string
let shared: string
let models: string
let state: string

function junction(target: string, entry: string): void {
  fs.symlinkSync(target, entry, process.platform === 'win32' ? 'junction' : 'dir')
}

function verifyShared(): void {
  expect(fs.lstatSync(models).isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(models)).toBe(fs.realpathSync(shared))
  expect(fs.readFileSync(path.join(shared, 'model.gguf'), 'utf8')).toBe('do not change this model')
  expect(fs.readFileSync(path.join(shared, 'configs', 'v1.yaml'), 'utf8')).toBe('shared config')
}

function interrupted(phase: 'prepared' | 'parked' | 'checkout' | 'archived' | 'restored'): string {
  const id = crypto.randomUUID()
  const history = path.join(state, id)
  fs.mkdirSync(history, { recursive: true })
  fs.writeFileSync(
    path.join(state, 'active.json'),
    JSON.stringify({
      version: 1,
      id,
      repo,
      ownerPid: process.pid,
      linkTarget: fs.readlinkSync(models),
      resolvedTarget: fs.realpathSync(models)
    })
  )
  if (phase === 'prepared') return history
  fs.renameSync(models, path.join(history, 'original-link'))
  if (phase === 'parked') return history
  fs.mkdirSync(models)
  fs.writeFileSync(path.join(models, 'generated.txt'), 'new core file')
  if (phase === 'checkout') return history
  fs.renameSync(models, path.join(history, 'checkout-models'))
  if (phase === 'archived') return history
  fs.renameSync(path.join(history, 'original-link'), models)
  return history
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-model-link-test-'))
  repo = path.join(root, 'ComfyUI')
  shared = path.join(root, 'shared')
  models = path.join(repo, 'models')
  state = path.join(repo, '.git', 'fr-model-link-guard')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(shared, 'configs'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'model.gguf'), 'do not change this model')
  fs.writeFileSync(path.join(shared, 'configs', 'v1.yaml'), 'shared config')
  junction(shared, models)
})

afterEach(() => {
  // Only the mkdtemp fixture is removed; production paths never enter tests.
  if (!path.basename(root).startsWith('fr-model-link-test-') || path.dirname(root) !== os.tmpdir())
    throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('model directory link protection', () => {
  it('isolates checkout writes and restores the same shared library across repeated updates', async () => {
    for (let revision = 1; revision <= 2; revision++) {
      const result = await withProtectedModelLink(repo, async (guarded) => {
        expect(guarded).toBe(true)
        expect(fs.lstatSync(models).isSymbolicLink()).toBe(false)
        expect(fs.existsSync(path.join(models, 'model.gguf'))).toBe(false)
        fs.mkdirSync(path.join(models, 'configs'))
        fs.writeFileSync(path.join(models, 'configs', 'v1.yaml'), `updated ${revision}`)
        return revision
      })
      expect(result).toBe(revision)
      verifyShared()
      expect(fs.existsSync(path.join(state, 'active.json'))).toBe(false)
    }
    expect(fs.readdirSync(state)).toHaveLength(2)
    for (const dir of fs.readdirSync(state)) {
      expect(fs.existsSync(path.join(state, dir, 'checkout-models', 'configs', 'v1.yaml'))).toBe(
        true
      )
    }
  })

  it('restores on thrown failures and nonzero process exits', async () => {
    await expect(
      withProtectedModelLink(repo, async () => {
        throw new Error('cancelled')
      })
    ).rejects.toThrow('cancelled')
    verifyShared()
    await expect(withProtectedModelLink(repo, async () => ({ exitCode: 1 }))).resolves.toEqual({
      exitCode: 1
    })
    verifyShared()
  })

  it('leaves ordinary model folders untouched and creates no recovery state', async () => {
    fs.unlinkSync(models)
    fs.mkdirSync(models)
    fs.writeFileSync(path.join(models, 'local.gguf'), 'local')
    await withProtectedModelLink(repo, async (guarded) => {
      expect(guarded).toBe(false)
    })
    expect(fs.readFileSync(path.join(models, 'local.gguf'), 'utf8')).toBe('local')
    expect(fs.existsSync(state)).toBe(false)
  })

  it('rejects concurrent operations instead of restoring a link while Git is still running', async () => {
    await withProtectedModelLink(repo, async () => {
      await expect(withProtectedModelLink(repo, async () => 1)).rejects.toThrow('already running')
      expect(() => recoverModelLink(repo)).toThrow('already running')
    })
    verifyShared()
  })

  it.each(['prepared', 'parked', 'checkout', 'archived', 'restored'] as const)(
    'recovers an interrupted transaction at the %s boundary without requiring HEAD to move',
    (phase) => {
      const history = interrupted(phase)
      expect(recoverModelLink(repo)).toBe(true)
      verifyShared()
      expect(recoverModelLink(repo)).toBe(false)
      if (['checkout', 'archived', 'restored'].includes(phase)) {
        expect(
          fs.readFileSync(path.join(history, 'checkout-models', 'generated.txt'), 'utf8')
        ).toBe('new core file')
      }
    }
  )

  it('retains recovery data on a conflicting replacement link and does not remove either target', () => {
    const history = interrupted('parked')
    const other = path.join(root, 'other')
    fs.mkdirSync(other)
    junction(other, models)
    expect(() => recoverModelLink(repo)).toThrow('physical directory')
    expect(fs.realpathSync(models)).toBe(fs.realpathSync(other))
    expect(fs.lstatSync(path.join(history, 'original-link')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(state, 'active.json'))).toBe(true)
  })

  it('fails closed for malformed journals and linked metadata directories', async () => {
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, 'active.json'), '{ broken')
    let ran = false
    await expect(
      withProtectedModelLink(repo, async () => {
        ran = true
      })
    ).rejects.toThrow()
    expect(ran).toBe(false)
    verifyShared()
    fs.unlinkSync(path.join(state, 'active.json'))
    fs.rmdirSync(state)
    junction(shared, state)
    await expect(
      withProtectedModelLink(repo, async () => {
        ran = true
      })
    ).rejects.toThrow('physical directory')
    expect(ran).toBe(false)
    verifyShared()
  })

  it('rejects links back into the source tree before any mutation', async () => {
    fs.unlinkSync(models)
    junction(repo, models)
    await expect(withProtectedModelLink(repo, async () => 1)).rejects.toThrow(
      'separate model library'
    )
    expect(fs.realpathSync(models)).toBe(fs.realpathSync(repo))
    expect(fs.existsSync(state)).toBe(false)
  })

  it('does not recover while a recorded Git child still runs', () => {
    interrupted('checkout')
    const marker = path.join(state, 'active.json')
    const journal = JSON.parse(fs.readFileSync(marker, 'utf8'))
    journal.childPids = [process.pid]
    fs.writeFileSync(marker, JSON.stringify(journal))
    expect(() => recoverModelLink(repo)).toThrow('in use by process')
    expect(fs.lstatSync(models).isSymbolicLink()).toBe(false)
    journal.childPids = []
    fs.writeFileSync(marker, JSON.stringify(journal))
    expect(recoverModelLink(repo)).toBe(true)
    verifyShared()
  })
})
