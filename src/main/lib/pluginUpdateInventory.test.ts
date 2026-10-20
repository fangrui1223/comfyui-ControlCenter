// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallationRecord } from '../installations'

const mocked = vi.hoisted(() => ({
  inspect: vi.fn(),
  remote: vi.fn(),
  profiles: vi.fn(),
  scan: vi.fn()
}))
vi.mock('./git', () => ({
  inspectGitUpdate: mocked.inspect,
  lsRemoteRef: mocked.remote,
  tryConfigurePygit2Fallback: async () => false
}))
vi.mock('./nodes', () => ({ scanCustomNodes: mocked.scan }))
vi.mock('./frEnvironmentProfiles', () => ({ listFrEnvironmentProfiles: mocked.profiles }))
vi.mock('./cnr', () => ({ getCnrInstallInfo: vi.fn() }))
import { getPluginUpdateInventory, __testing } from './pluginUpdates'

let root: string
let installation: InstallationRecord
const node = {
  id: 'fixture-node',
  dirName: 'fixture-node',
  type: 'git',
  enabled: true,
  url: 'https://example.invalid/node.git',
  commit: 'a'.repeat(40)
}
beforeEach(() => {
  vi.resetAllMocks()
  __testing.cache.clear()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-plugin-inventory-'))
  fs.mkdirSync(path.join(root, 'ComfyUI/custom_nodes/fixture-node/.git'), { recursive: true })
  fs.writeFileSync(path.join(root, 'ComfyUI/folder_paths.py'), '')
  installation = {
    id: 'fixture',
    name: 'Next',
    installPath: root,
    sourceId: 'standalone',
    createdAt: '2026-10-14'
  }
  mocked.profiles.mockReturnValue([
    { role: 'next', mode: 'managed', path: root, suggestedPath: root }
  ])
  mocked.scan.mockResolvedValue([node])
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('plugin update inspection errors', () => {
  it('shows local inspection failures as unknown and never enables update', async () => {
    mocked.inspect.mockRejectedValue(new Error('path too long'))
    const result = await getPluginUpdateInventory(installation, true)
    expect(result.items[0]).toMatchObject({
      status: 'check-failed',
      reasonCode: 'local-check-failed',
      updateable: false,
      localCommit: node.commit,
      remoteCommit: null,
      reason: 'path too long'
    })
    expect(result.summary).toMatchObject({ attention: 1, updateAvailable: 0 })
  })

  it('keeps actual remote failures distinct from local inspection failures', async () => {
    mocked.inspect.mockResolvedValue({
      detached: false,
      dirty: false,
      branch: 'main',
      upstream: 'origin/main',
      localCommit: node.commit,
      remoteCommit: node.commit,
      ahead: 0,
      behind: 0,
      fetchError: 'network unavailable'
    })
    const result = await getPluginUpdateInventory(installation, true)
    expect(result.items[0]).toMatchObject({
      status: 'unreachable',
      reasonCode: 'remote-unreachable',
      updateable: false
    })
  })

  it('shows recovered local changes while preserving a successful comparison', async () => {
    mocked.inspect.mockResolvedValue({
      detached: false,
      dirty: true,
      branch: 'main',
      upstream: 'origin/main',
      localCommit: node.commit,
      remoteCommit: 'b'.repeat(40),
      ahead: 0,
      behind: 2,
      fetchError: null
    })
    const result = await getPluginUpdateInventory(installation, true)
    expect(result.items[0]).toMatchObject({
      status: 'dirty',
      reasonCode: 'dirty',
      branch: 'main',
      behind: 2,
      updateable: false,
      dirty: true
    })
  })
})
