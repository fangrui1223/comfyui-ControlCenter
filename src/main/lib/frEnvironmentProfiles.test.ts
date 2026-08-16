import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ configDir: '' }))

vi.mock('./paths', () => ({
  configDir: () => mockState.configDir
}))

import {
  __testing,
  listFrEnvironmentProfiles,
  saveFrEnvironmentProfile
} from './frEnvironmentProfiles'

describe('FR environment profile registry', () => {
  beforeEach(() => {
    mockState.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-env-registry-'))
  })

  afterEach(() => {
    fs.rmSync(mockState.configDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns suggestions without probing or adopting unregistered folders', () => {
    const stat = vi.spyOn(fs, 'statSync')
    const profiles = listFrEnvironmentProfiles()

    expect(profiles.map((profile) => profile.role)).toEqual(['stable', 'next', 'lab'])
    expect(profiles.every((profile) => profile.mode === 'unregistered')).toBe(true)
    expect(profiles.every((profile) => profile.folderState === 'not-checked')).toBe(true)
    expect(stat).not.toHaveBeenCalled()
    expect(fs.existsSync(__testing.registryPath())).toBe(false)
  })

  it('records a read-only folder without changing its contents', () => {
    const target = path.join(mockState.configDir, 'existing-comfy')
    fs.mkdirSync(target)
    const sentinel = path.join(target, 'user-owned.txt')
    fs.writeFileSync(sentinel, 'untouched')

    const profiles = saveFrEnvironmentProfile({
      role: 'stable',
      mode: 'read-only',
      path: target
    })

    expect(profiles.find((profile) => profile.role === 'stable')).toMatchObject({
      mode: 'read-only',
      path: target,
      folderState: 'directory',
      managedAuthorizedAt: null
    })
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('untouched')
    expect(fs.readdirSync(target)).toEqual(['user-owned.txt'])
  })

  it('requires explicit managed authorization metadata and can return to read only', () => {
    const target = path.join(mockState.configDir, 'next')
    fs.mkdirSync(target)

    let profiles = saveFrEnvironmentProfile({ role: 'next', mode: 'managed', path: target })
    const managed = profiles.find((profile) => profile.role === 'next')!
    expect(managed.mode).toBe('managed')
    expect(managed.managedAuthorizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    profiles = saveFrEnvironmentProfile({ role: 'next', mode: 'read-only', path: target })
    expect(profiles.find((profile) => profile.role === 'next')).toMatchObject({
      mode: 'read-only',
      managedAuthorizedAt: null
    })
  })

  it('rejects assigning one folder to more than one role', () => {
    const target = path.join(mockState.configDir, 'one-folder')
    fs.mkdirSync(target)
    saveFrEnvironmentProfile({ role: 'stable', mode: 'read-only', path: target })

    expect(() => saveFrEnvironmentProfile({ role: 'lab', mode: 'managed', path: target })).toThrow(
      'already registered as the stable environment'
    )
  })

  it('disconnects only the registry entry and never deletes the environment', () => {
    const target = path.join(mockState.configDir, 'lab')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.bin'), 'keep')
    saveFrEnvironmentProfile({ role: 'lab', mode: 'managed', path: target })

    const profiles = saveFrEnvironmentProfile({ role: 'lab', mode: 'unregistered' })

    expect(profiles.find((profile) => profile.role === 'lab')).toMatchObject({
      mode: 'unregistered',
      path: null,
      folderState: 'not-checked'
    })
    expect(fs.readFileSync(path.join(target, 'keep.bin'), 'utf8')).toBe('keep')
  })
})
