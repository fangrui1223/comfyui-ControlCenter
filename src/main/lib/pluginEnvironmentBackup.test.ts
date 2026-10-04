import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstallationRecord } from '../installations'
vi.mock('./pythonEnv', () => ({
  getActiveVenvDir: (installation: InstallationRecord) =>
    path.join(installation.installPath, 'ComfyUI', '.venv')
}))
import { preparePluginSourceBackups } from './pluginUpdateBackup'
import {
  beginPluginTransaction,
  writePluginJournal,
  restorePluginTransaction,
  finishPluginTransaction,
  recoverInterruptedPluginUpdate
} from './pluginEnvironmentBackup'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
async function fixture() {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-plugin-rollback-'))
  roots.push(installPath)
  const installation = { id: 'test', installPath } as InstallationRecord
  const plugin = path.join(installPath, 'ComfyUI', 'custom_nodes', 'node')
  const venv = path.join(installPath, 'ComfyUI', '.venv')
  fs.mkdirSync(plugin, { recursive: true })
  fs.mkdirSync(venv, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'node.py'), 'old source')
  fs.writeFileSync(path.join(venv, 'package.py'), 'old environment')
  const backup = (await preparePluginSourceBackups(installPath, path.join(installPath, 'ComfyUI'), [
    'node'
  ]))!
  const journal = await beginPluginTransaction(installation, backup, 'b'.repeat(64), true)
  return {
    installation,
    plugin,
    venv,
    journal,
    marker: path.join(installPath, '.launcher', 'plugin-update-in-progress.json')
  }
}
describe('offline plugin environment transactions', () => {
  it('restores complete source and environment including deleted and newly installed files', async () => {
    const f = await fixture()
    await writePluginJournal(f.installation, f.journal, 'applying-dependencies')
    fs.writeFileSync(path.join(f.plugin, 'node.py'), 'new source')
    fs.rmSync(path.join(f.venv, 'package.py'))
    fs.writeFileSync(path.join(f.venv, 'new.py'), 'new package')
    expect(await restorePluginTransaction(f.installation, f.journal, () => {})).toEqual([])
    expect(fs.readFileSync(path.join(f.plugin, 'node.py'), 'utf-8')).toBe('old source')
    expect(fs.readFileSync(path.join(f.venv, 'package.py'), 'utf-8')).toBe('old environment')
    expect(fs.existsSync(path.join(f.venv, 'new.py'))).toBe(false)
    expect(fs.existsSync(f.journal.environment!.backupPath)).toBe(true)
    await finishPluginTransaction(f.installation, f.journal, false)
    expect(fs.existsSync(f.marker)).toBe(false)
  })
  it.each(['applying-source', 'applying-dependencies', 'validating'] as const)(
    'recovers an interrupted %s transaction without network access',
    async (state) => {
      const f = await fixture()
      await writePluginJournal(f.installation, f.journal, state)
      fs.writeFileSync(path.join(f.plugin, 'node.py'), 'new source')
      fs.writeFileSync(path.join(f.venv, 'package.py'), 'new environment')
      expect(await recoverInterruptedPluginUpdate(f.installation, () => {})).toBe(true)
      expect(fs.readFileSync(path.join(f.venv, 'package.py'), 'utf-8')).toBe('old environment')
      expect(fs.existsSync(f.marker)).toBe(false)
    }
  )
  it('cleans a committed journal without reverting the successful update', async () => {
    const f = await fixture()
    fs.writeFileSync(path.join(f.plugin, 'node.py'), 'new source')
    await writePluginJournal(f.installation, f.journal, 'committed')
    expect(await recoverInterruptedPluginUpdate(f.installation, () => {})).toBe(false)
    expect(fs.readFileSync(path.join(f.plugin, 'node.py'), 'utf-8')).toBe('new source')
  })
  it('retains recovery data when an environment backup is missing', async () => {
    const f = await fixture()
    await writePluginJournal(f.installation, f.journal, 'applying-dependencies')
    fs.rmSync(f.journal.environment!.backupPath, { recursive: true })
    await expect(recoverInterruptedPluginUpdate(f.installation, () => {})).rejects.toThrow(
      'Environment rollback failed'
    )
    expect(fs.existsSync(f.marker)).toBe(true)
    expect(fs.existsSync(f.journal.sourceBackups.root)).toBe(true)
  })
  it('rejects a tampered recovery path before removing any files', async () => {
    const f = await fixture()
    f.journal.environment!.sourcePath = path.dirname(f.installation.installPath)
    fs.writeFileSync(f.marker, JSON.stringify(f.journal))
    await expect(recoverInterruptedPluginUpdate(f.installation, () => {})).rejects.toThrow(
      'Invalid environment'
    )
    expect(fs.readFileSync(path.join(f.venv, 'package.py'), 'utf-8')).toBe('old environment')
  })
  it('refuses a second transaction while a recovery marker exists', async () => {
    const f = await fixture()
    await expect(
      beginPluginTransaction(f.installation, f.journal.sourceBackups, null, true)
    ).rejects.toThrow('interrupted plugin update')
  })
})
