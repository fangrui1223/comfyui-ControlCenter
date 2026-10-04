import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discardPluginSourceBackups,
  preparePluginSourceBackups,
  restorePluginSourceBackups
} from './pluginUpdateBackup'

describe('plugin source update backups', () => {
  let installPath: string
  let comfyuiDir: string
  let nodePath: string

  beforeEach(async () => {
    installPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'plugin-update-backup-'))
    comfyuiDir = path.join(installPath, 'ComfyUI')
    nodePath = path.join(comfyuiDir, 'custom_nodes', 'example-node')
    await fs.promises.mkdir(nodePath, { recursive: true })
    await fs.promises.writeFile(path.join(nodePath, '.tracking'), 'old.py\n')
    await fs.promises.writeFile(path.join(nodePath, 'old.py'), 'old source')
  })

  afterEach(async () => {
    await fs.promises.rm(installPath, { recursive: true, force: true })
  })

  it('restores the exact pre-update directory without using the registry', async () => {
    const transaction = await preparePluginSourceBackups(installPath, comfyuiDir, ['example-node'])
    expect(transaction).not.toBeNull()
    expect(fs.existsSync(transaction!.manifestPath)).toBe(true)

    await fs.promises.rm(path.join(nodePath, 'old.py'))
    await fs.promises.writeFile(path.join(nodePath, 'new.py'), 'new source')
    const sendOutput = vi.fn()
    expect(await restorePluginSourceBackups(transaction!, sendOutput)).toEqual([])

    expect(await fs.promises.readFile(path.join(nodePath, 'old.py'), 'utf-8')).toBe('old source')
    expect(fs.existsSync(path.join(nodePath, 'new.py'))).toBe(false)
    expect(fs.existsSync(transaction!.root)).toBe(false)
    expect(sendOutput).toHaveBeenCalledWith(expect.stringContaining('local pre-update backup'))
  })

  it('removes a committed backup after a successful transaction', async () => {
    const transaction = await preparePluginSourceBackups(installPath, comfyuiDir, ['example-node'])
    await discardPluginSourceBackups(transaction)
    expect(fs.existsSync(transaction!.root)).toBe(false)
  })

  it('restores Git metadata and user files and removes a failed checkout long-path residue', async () => {
    const git = (...args: string[]): string =>
      execFileSync(
        'git',
        [
          '-c',
          'core.longpaths=true',
          '-c',
          'user.name=FR Test',
          '-c',
          'user.email=test@example.invalid',
          ...args
        ],
        { cwd: nodePath, windowsHide: true, encoding: 'utf-8', timeout: 20_000 }
      ).trim()
    git('init', '-b', 'main')
    await fs.promises.writeFile(path.join(nodePath, '.gitignore'), 'user.json\n')
    git('add', '.')
    git('commit', '-m', 'baseline')
    const commit = git('rev-parse', 'HEAD')
    await fs.promises.writeFile(path.join(nodePath, 'user.json'), 'user configuration')
    const transaction = await preparePluginSourceBackups(installPath, comfyuiDir, ['example-node'])
    const residue = path.join(
      nodePath,
      'examples',
      'workflows',
      'native-load-policy-exp',
      'workflow_'.repeat(20) + '.json'
    )
    expect(residue.length).toBeGreaterThan(260)
    await fs.promises.mkdir(path.dirname(residue), { recursive: true })
    await fs.promises.writeFile(residue, 'partial checkout')
    await fs.promises.writeFile(path.join(nodePath, 'old.py'), 'partially updated')
    await fs.promises.writeFile(path.join(nodePath, 'user.json'), 'install hook changed this')
    git('update-ref', 'refs/heads/failed-update', commit)

    expect(await restorePluginSourceBackups(transaction!, vi.fn())).toEqual([])
    expect(git('rev-parse', 'HEAD')).toBe(commit)
    expect(git('status', '--porcelain')).toBe('')
    expect(await fs.promises.readFile(path.join(nodePath, 'user.json'), 'utf-8')).toBe(
      'user configuration'
    )
    expect(fs.existsSync(residue)).toBe(false)
    expect(git('branch', '--list', 'failed-update')).toBe('')
  })

  it('rejects directory traversal before copying anything', async () => {
    await expect(
      preparePluginSourceBackups(installPath, comfyuiDir, ['..\\outside'])
    ).rejects.toThrow('Invalid plugin directory name')
  })
})
