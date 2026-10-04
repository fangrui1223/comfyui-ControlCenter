import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallationRecord } from '../../installations'
import type {
  PluginCompatibilityPlan,
  PluginUpdateInventory,
  PluginUpdateItem
} from '../../../types/ipc'

const mocks = vi.hoisted(() => ({
  getPluginUpdateInventory: vi.fn(),
  recordPluginUpdateRun: vi.fn(),
  invalidatePluginUpdateInventory: vi.fn(),
  preparePluginSourceBackups: vi.fn(),
  restorePluginSourceBackups: vi.fn(),
  discardPluginSourceBackups: vi.fn(),
  runLoggedProcess: vi.fn(),
  saveSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  getSnapshotCount: vi.fn(),
  restorePipPackages: vi.fn(),
  buildPluginCompatibilityPlan: vi.fn(),
  getPluginCompatibilityPlan: vi.fn(),
  invalidatePluginCompatibilityPlans: vi.fn(),
  pipFreeze: vi.fn(),
  getApprovedPluginPlan: vi.fn(),
  beginPluginTransaction: vi.fn(),
  writePluginJournal: vi.fn(),
  restorePluginTransaction: vi.fn(),
  finishPluginTransaction: vi.fn(),
  recoverInterruptedPluginUpdate: vi.fn(),
  verifyPluginSource: vi.fn(),
  prepareApprovedWheels: vi.fn(),
  installApprovedWheels: vi.fn()
}))

vi.mock('../../lib/pythonEnv', () => ({
  getActivePythonPath: () => process.execPath,
  getActiveUvPath: () => process.execPath
}))
vi.mock('../../lib/pip', () => ({ pipFreeze: mocks.pipFreeze }))
vi.mock('../../lib/bundledScript', () => ({ getBundledScriptPath: () => process.execPath }))
vi.mock('../../lib/popoutWindows', () => ({ releaseInstallTerminalForFsOp: vi.fn() }))
vi.mock('../../settings', () => ({ getMirrorConfig: () => ({}) }))
vi.mock('../../lib/logged-process', () => ({
  runLoggedProcess: mocks.runLoggedProcess,
  withOutputTail: (message: string, output: string) => `${message}\n${output}`
}))
vi.mock('../../lib/snapshots', () => ({
  saveSnapshot: mocks.saveSnapshot,
  loadSnapshot: mocks.loadSnapshot,
  getSnapshotCount: mocks.getSnapshotCount,
  restorePipPackages: mocks.restorePipPackages
}))
vi.mock('../../lib/pluginUpdateBackup', () => ({
  preparePluginSourceBackups: mocks.preparePluginSourceBackups,
  restorePluginSourceBackups: mocks.restorePluginSourceBackups,
  discardPluginSourceBackups: mocks.discardPluginSourceBackups
}))
vi.mock('../../lib/pluginUpdates', () => ({
  getPluginMutationPolicy: () => ({ mutable: true, reason: null }),
  resolveComfyUIPath: () => 'C:\\test\\ComfyUI',
  getPluginUpdateInventory: mocks.getPluginUpdateInventory,
  invalidatePluginUpdateInventory: mocks.invalidatePluginUpdateInventory,
  recordPluginUpdateRun: mocks.recordPluginUpdateRun
}))
vi.mock('../../lib/pluginCompatibility', () => ({
  buildPluginCompatibilityPlan: mocks.buildPluginCompatibilityPlan,
  getPluginCompatibilityPlan: mocks.getPluginCompatibilityPlan,
  getApprovedPluginPlan: mocks.getApprovedPluginPlan,
  invalidatePluginCompatibilityPlans: mocks.invalidatePluginCompatibilityPlans
}))

vi.mock('../../lib/pluginEnvironmentBackup', () => ({
  beginPluginTransaction: mocks.beginPluginTransaction,
  writePluginJournal: mocks.writePluginJournal,
  restorePluginTransaction: mocks.restorePluginTransaction,
  finishPluginTransaction: mocks.finishPluginTransaction,
  recoverInterruptedPluginUpdate: mocks.recoverInterruptedPluginUpdate
}))
vi.mock('../../lib/pluginSourceManifest', () => ({ verifyPluginSource: mocks.verifyPluginSource }))
vi.mock('../../lib/pluginWheelInstall', () => ({
  prepareApprovedWheels: mocks.prepareApprovedWheels,
  installApprovedWheels: mocks.installApprovedWheels
}))
import { handleCompatiblePluginUpdate, handlePluginUpdate } from './pluginUpdateAction'

function installation(): InstallationRecord {
  return {
    id: 'inst-1',
    name: 'Next',
    sourceId: 'standalone',
    installPath: 'C:\\test',
    createdAt: '2026-09-27T00:00:00.000Z'
  }
}

function item(overrides: Partial<PluginUpdateItem> = {}): PluginUpdateItem {
  return {
    id: 'cnr-node',
    dirName: 'cnr-node',
    enabled: true,
    sourceType: 'cnr',
    repository: 'https://github.com/example/cnr-node',
    branch: null,
    upstream: null,
    localCommit: null,
    remoteCommit: null,
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    ahead: null,
    behind: 1,
    dirty: false,
    status: 'update-available',
    updateable: true,
    reasonCode: null,
    reason: null,
    hasRequirements: true,
    hasInstallScript: false,
    hasCompiledDependencies: false,
    ...overrides
  }
}

function inventory(items: PluginUpdateItem[]): PluginUpdateInventory {
  return {
    installationId: 'inst-1',
    checkedAt: '2026-09-27T00:00:00.000Z',
    mutable: true,
    mutationBlockedReason: null,
    lastRun: null,
    items,
    summary: {
      total: items.length,
      updateAvailable: items.filter((entry) => entry.status === 'update-available').length,
      attention: 0,
      unsupported: 0
    }
  }
}

function compatibilityPlan(
  overrides: Partial<PluginCompatibilityPlan> = {}
): PluginCompatibilityPlan {
  return {
    installationId: 'inst-1',
    pluginId: 'cnr-node',
    dirName: 'cnr-node',
    sourceType: 'cnr',
    currentRef: '1.0.0',
    targetRef: '1.1.0',
    targetSource: 'Comfy Registry',
    provenance: 'https://api.comfy.org/nodes/cnr-node/install?version=1.1.0',
    generatedAt: '2026-09-27T00:00:00.000Z',
    environmentFingerprint: 'a'.repeat(64),
    planDigest: 'b'.repeat(64),
    environment: {
      pythonVersion: '3.12.10',
      pythonArchitecture: 'AMD64',
      torchVersion: '2.8.0+cu128',
      cudaVersion: 'cu128',
      numpyVersion: '2.2.6',
      compiledPackages: { 'onnxruntime-gpu': '1.22.0' }
    },
    currentDependencies: [],
    targetDependencies: [],
    dependencyDifferences: [],
    compiledDependencyDifferences: [],
    protectedStackDifferences: [],
    installHookDifferences: [],
    nativeBinaryFiles: [],
    nativeBinaryChanges: [],
    preexistingPipCheckIssues: [],
    executionMode: 'source-only',
    sourceFiles: [],
    installedPackages: { torch: '2.8.0+cu128', numpy: '2.2.6', 'onnxruntime-gpu': '1.22.0' },
    verdict: 'ready',
    blockers: [],
    warnings: [],
    proposedChanges: [],
    ...overrides
  }
}

function tools() {
  return {
    update: vi.fn(async () => {}),
    sendProgress: vi.fn(),
    sendOutput: vi.fn()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getApprovedPluginPlan.mockReturnValue(compatibilityPlan())
  mocks.beginPluginTransaction.mockResolvedValue({
    environment: { prepared: true },
    sourceBackups: {}
  })
  mocks.restorePluginTransaction.mockResolvedValue([])
  mocks.recoverInterruptedPluginUpdate.mockResolvedValue(false)
  mocks.prepareApprovedWheels.mockResolvedValue('locked-wheels.txt')
  mocks.saveSnapshot.mockResolvedValue('snapshot.json')
  mocks.loadSnapshot.mockResolvedValue({ pipPackages: {} })
  mocks.getSnapshotCount.mockResolvedValue(1)
  mocks.restorePipPackages.mockResolvedValue({ errors: [] })
  mocks.preparePluginSourceBackups.mockResolvedValue({
    root: 'backup',
    manifestPath: 'backup/transaction.json',
    entries: []
  })
  mocks.restorePluginSourceBackups.mockResolvedValue([])
  mocks.runLoggedProcess.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' })
  mocks.pipFreeze.mockResolvedValue({
    torch: '2.8.0+cu128',
    numpy: '2.2.6',
    'onnxruntime-gpu': '1.22.0'
  })
  mocks.getPluginCompatibilityPlan.mockImplementation(async (_inst, dirName, _refresh, checked) => {
    const node = checked?.items.find((node: PluginUpdateItem) => node.dirName === dirName)
    return compatibilityPlan(
      node
        ? {
            dirName,
            pluginId: node.id,
            sourceType: node.sourceType,
            currentRef: node.sourceType === 'git' ? node.localCommit : node.installedVersion,
            targetRef: node.sourceType === 'git' ? node.remoteCommit : node.latestVersion
          }
        : {}
    )
  })
})

describe('handleCompatiblePluginUpdate', () => {
  const request = {
    dirName: 'cnr-node',
    targetVersion: '1.1.0',
    planDigest: 'b'.repeat(64)
  }

  function compiled(overrides: Partial<PluginUpdateItem> = {}): PluginUpdateItem {
    return item({
      updateable: false,
      hasCompiledDependencies: true,
      reasonCode: 'compiled-dependencies',
      reason: 'Compiled dependencies require a compatibility update.',
      ...overrides
    })
  }

  function wheelPlan(): PluginCompatibilityPlan {
    return compatibilityPlan({
      verdict: 'approval-required',
      executionMode: 'wheel-update',
      packageChanges: [
        {
          name: 'new-package',
          from: null,
          to: '2.0',
          kind: 'added',
          compiled: false,
          protected: false,
          reason: 'direct',
          wheel: {
            filename: 'new_package-2.0-py3-none-any.whl',
            url: 'https://files.pythonhosted.org/packages/new_package.whl',
            sha256: 'd'.repeat(64),
            size: 100,
            tags: ['py3-none-any']
          }
        }
      ]
    })
  }

  it('rejects an expired approval before rechecking or changing files', async () => {
    mocks.getApprovedPluginPlan.mockReturnValue(null)
    const result = await handleCompatiblePluginUpdate(installation(), request, tools())
    expect(result.message).toContain('expired')
    expect(mocks.getPluginCompatibilityPlan).not.toHaveBeenCalled()
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
  })

  it('does not misclassify a failed dependency checker as preexisting package conflicts', async () => {
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))
    mocks.runLoggedProcess.mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: 'invalid Python environment'
    })
    const result = await handleCompatiblePluginUpdate(installation(), request, tools())
    expect(result.message).toContain('invalid Python environment')
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
  })

  it('requires explicit dependency approval for a complete wheel plan', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(wheelPlan())
    const result = await handleCompatiblePluginUpdate(installation(), request, tools())
    expect(result.ok).toBe(false)
    expect(mocks.prepareApprovedWheels).not.toHaveBeenCalled()
    expect(mocks.runLoggedProcess).not.toHaveBeenCalled()
  })

  it('installs only approved wheels after source verification and verifies exact package state', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(wheelPlan())
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([compiled()]))
      .mockResolvedValueOnce(inventory([compiled({ installedVersion: '1.1.0' })]))
    mocks.pipFreeze
      .mockResolvedValue({ ...compatibilityPlan().installedPackages, 'new-package': '2.0' })
      .mockResolvedValueOnce(compatibilityPlan().installedPackages!)
    const result = await handleCompatiblePluginUpdate(
      installation(),
      { ...request, approveDependencies: true },
      tools()
    )
    expect(result.ok).toBe(true)
    expect(mocks.installApprovedWheels).toHaveBeenCalledWith(
      installation(),
      'locked-wheels.txt',
      expect.any(Function)
    )
    expect(mocks.verifyPluginSource.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installApprovedWheels.mock.invocationCallOrder[0]!
    )
    expect(mocks.beginPluginTransaction).toHaveBeenCalledWith(
      installation(),
      expect.any(Object),
      'b'.repeat(64),
      true,
      expect.any(Function)
    )
  })

  it('does not update source if the wheel download or hash check fails', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(wheelPlan())
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))
    mocks.prepareApprovedWheels.mockRejectedValue(new Error('hash mismatch'))
    const result = await handleCompatiblePluginUpdate(
      installation(),
      { ...request, approveDependencies: true },
      tools()
    )
    expect(result.message).toContain('hash mismatch')
    expect(mocks.preparePluginSourceBackups).not.toHaveBeenCalled()
    expect(
      mocks.runLoggedProcess.mock.calls.some((call) => call[1].includes('update-node-now'))
    ).toBe(false)
  })

  it('restores the offline backup when dependency installation fails', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(wheelPlan())
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))
    mocks.installApprovedWheels.mockRejectedValue(new Error('wheel installation failed'))
    const result = await handleCompatiblePluginUpdate(
      installation(),
      { ...request, approveDependencies: true },
      tools()
    )
    expect(result.ok).toBe(false)
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.finishPluginTransaction).toHaveBeenCalledWith(
      installation(),
      expect.any(Object),
      false
    )
  })

  it('refuses an isolated-review plan even when the caller supplies approval', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(
      compatibilityPlan({ verdict: 'review-required', executionMode: 'isolated-review' })
    )
    const result = await handleCompatiblePluginUpdate(
      installation(),
      { ...request, approveDependencies: true },
      tools()
    )
    expect(result.ok).toBe(false)
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
  })

  it('keeps the recovery journal if offline rollback fails', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(wheelPlan())
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))
    mocks.installApprovedWheels.mockRejectedValue(new Error('install failed'))
    mocks.restorePluginTransaction.mockResolvedValue(['environment backup unavailable'])
    const result = await handleCompatiblePluginUpdate(
      installation(),
      { ...request, approveDependencies: true },
      tools()
    )
    expect(result.message).toContain('Rollback needs attention')
    expect(mocks.finishPluginTransaction).not.toHaveBeenCalled()
  })

  it('restores source before installing any packages when the target manifest does not match', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(wheelPlan())
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))
    mocks.verifyPluginSource.mockRejectedValue(new Error('source differs from approved archive'))
    const result = await handleCompatiblePluginUpdate(
      installation(),
      { ...request, approveDependencies: true },
      tools()
    )
    expect(result.ok).toBe(false)
    expect(mocks.installApprovedWheels).not.toHaveBeenCalled()
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
  })

  it('rejects a stale compatibility digest before mutating the plugin', async () => {
    mocks.getPluginCompatibilityPlan.mockResolvedValue(
      compatibilityPlan({ planDigest: 'c'.repeat(64) })
    )

    const result = await handleCompatiblePluginUpdate(installation(), request, tools())

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('stale')
    expect(mocks.runLoggedProcess).not.toHaveBeenCalled()
  })

  it('detects package drift caused by successful plugin import validation', async () => {
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([compiled()]))
      .mockResolvedValueOnce(inventory([compiled({ installedVersion: '1.1.0' })]))
    mocks.pipFreeze
      .mockResolvedValueOnce(compatibilityPlan().installedPackages!)
      .mockResolvedValueOnce(compatibilityPlan().installedPackages!)
      .mockResolvedValueOnce({ ...compatibilityPlan().installedPackages, torch: '2.9.0' })
    const result = await handleCompatiblePluginUpdate(installation(), request, tools())
    expect(result.message).toContain('validation changed packages')
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
  })

  it('uses Manager v4 source-only mode and commits only after all compatibility checks pass', async () => {
    const before = compiled()
    const after = compiled({ installedVersion: '1.1.0', status: 'current', behind: 0 })
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([before]))
      .mockResolvedValueOnce(inventory([after]))

    const result = await handleCompatiblePluginUpdate(installation(), request, tools())

    expect(result.ok).toBe(true)
    expect(mocks.runLoggedProcess.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['update-node-now', '--source-only', '--expected-target', '1.1.0'])
    )
    expect(mocks.runLoggedProcess.mock.calls[3]?.[1]).toContain('import-smoke')
    expect(mocks.runLoggedProcess.mock.calls[4]?.[1]).toContain('inspect-node')
    expect(mocks.runLoggedProcess.mock.calls[4]?.[1]).toEqual(
      expect.arrayContaining([
        '--plugin-dir',
        'C:\\test\\ComfyUI\\custom_nodes\\cnr-node',
        '--expected-version',
        '1.1.0'
      ])
    )
    expect(mocks.recordPluginUpdateRun).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        ok: true,
        items: [
          expect.objectContaining({
            status: 'updated',
            planDigest: 'b'.repeat(64),
            validation: expect.objectContaining({
              packageStateVerified: true,
              importSmokeVerified: true,
              managerStateVerified: true
            })
          })
        ]
      })
    )
  })

  it('updates and verifies a registered Git plugin by path even when its Manager id differs', async () => {
    const before = compiled({
      id: 'minimax-h3-audio-T8',
      dirName: 'minimax-h3-audio-T8',
      sourceType: 'git',
      installedVersion: null,
      latestVersion: null,
      localCommit: '1'.repeat(40),
      remoteCommit: '2'.repeat(40)
    })
    const after = { ...before, localCommit: '2'.repeat(40), status: 'current' as const }
    mocks.getPluginCompatibilityPlan.mockResolvedValue(
      compatibilityPlan({
        pluginId: before.id,
        dirName: before.dirName,
        sourceType: 'git',
        currentRef: before.localCommit,
        targetRef: before.remoteCommit
      })
    )
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([before]))
      .mockResolvedValueOnce(inventory([after]))

    const result = await handleCompatiblePluginUpdate(
      installation(),
      {
        dirName: before.dirName,
        targetCommit: before.remoteCommit,
        planDigest: 'b'.repeat(64)
      },
      tools()
    )

    expect(result.ok).toBe(true)
    const updateArgs = mocks.runLoggedProcess.mock.calls[1]?.[1]
    const inspectArgs = mocks.runLoggedProcess.mock.calls[4]?.[1]
    for (const args of [updateArgs, inspectArgs]) {
      expect(args).toEqual(
        expect.arrayContaining([
          '--plugin-dir',
          'C:\\test\\ComfyUI\\custom_nodes\\minimax-h3-audio-T8'
        ])
      )
      expect(args).not.toContain('--node-spec')
      expect(args).not.toContain('minimax-h3-audio-T8@unknown')
    }
    expect(updateArgs).toContain('--source-only')
    expect(updateArgs).toEqual(expect.arrayContaining(['--expected-commit', before.remoteCommit]))
    expect(inspectArgs).not.toContain('--expected-version')
  })

  it('rolls back when Manager cannot recognize the actual updated path', async () => {
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([compiled()]))
      .mockResolvedValueOnce(inventory([compiled({ installedVersion: '1.1.0' })]))
    mocks.runLoggedProcess.mockImplementation(async (_cmd, args: string[]) =>
      args.includes('inspect-node')
        ? { exitCode: 1, stdout: '', stderr: 'ERROR: no matching active update record' }
        : { exitCode: 0, stdout: '{}', stderr: '' }
    )

    const result = await handleCompatiblePluginUpdate(installation(), request, tools())

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no longer recognizes')
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
  })

  it('rolls source and dependencies back when an unplanned package change is detected', async () => {
    const before = compiled()
    const after = compiled({ installedVersion: '1.1.0', status: 'current', behind: 0 })
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([before]))
      .mockResolvedValueOnce(inventory([after]))
    mocks.pipFreeze
      .mockResolvedValueOnce({ torch: '2.8.0+cu128', numpy: '2.2.6', 'onnxruntime-gpu': '1.22.0' })
      .mockResolvedValueOnce({ torch: '2.9.0+cu128', numpy: '2.2.6', 'onnxruntime-gpu': '1.22.0' })

    const result = await handleCompatiblePluginUpdate(installation(), request, tools())

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('changed Python packages')
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.recordPluginUpdateRun).toHaveBeenLastCalledWith(
      'inst-1',
      expect.objectContaining({
        ok: false,
        items: [expect.objectContaining({ status: 'failed' })]
      })
    )
  })
})

describe('handlePluginUpdate', () => {
  it('backs up CNR source, records the per-plugin result, and commits on success', async () => {
    const before = item()
    const after = item({
      installedVersion: '1.1.0',
      status: 'current',
      updateable: false,
      behind: 0
    })
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([before]))
      .mockResolvedValueOnce(inventory([after]))
    const actionTools = tools()

    const result = await handlePluginUpdate(
      installation(),
      { pluginIds: ['cnr-node'] },
      actionTools
    )

    expect(result.ok).toBe(true)
    expect(mocks.preparePluginSourceBackups).toHaveBeenCalledWith('C:\\test', 'C:\\test\\ComfyUI', [
      'cnr-node'
    ])
    expect(
      mocks.runLoggedProcess.mock.calls.filter((call) => call[1].includes('update-node-now'))
    ).toHaveLength(1)
    expect(
      mocks.runLoggedProcess.mock.calls.find((call) => call[1].includes('update-node-now'))?.[1]
    ).toEqual(expect.arrayContaining(['--plugin-dir', 'C:\\test\\ComfyUI\\custom_nodes\\cnr-node']))
    expect(mocks.finishPluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.recordPluginUpdateRun).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        ok: true,
        items: [expect.objectContaining({ status: 'updated', from: '1.0.0', to: '1.1.0' })]
      })
    )
    expect(actionTools.sendProgress).toHaveBeenCalledWith(
      'plugin-update-0',
      expect.objectContaining({ percent: 100, status: 'cnr-node updated.' })
    )
  })

  it('passes a Git installation path rather than a guessed Manager specification', async () => {
    const before = item({
      id: 'local-name',
      dirName: 'renamed-folder',
      sourceType: 'git',
      installedVersion: null,
      latestVersion: null,
      localCommit: '1'.repeat(40),
      remoteCommit: '2'.repeat(40)
    })
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([before]))
      .mockResolvedValueOnce(inventory([{ ...before, localCommit: '2'.repeat(40) }]))

    const result = await handlePluginUpdate(
      installation(),
      { pluginIds: [before.dirName] },
      tools()
    )

    expect(result.ok).toBe(true)
    const args = mocks.runLoggedProcess.mock.calls.find((call) =>
      call[1].includes('update-node-now')
    )?.[1]
    expect(args).toEqual(
      expect.arrayContaining(['--plugin-dir', 'C:\\test\\ComfyUI\\custom_nodes\\renamed-folder'])
    )
    expect(args).not.toContain('--node-spec')
    expect(args).toEqual(expect.arrayContaining(['--expected-commit', before.remoteCommit]))
  })

  it('restores the whole Git source backup when the Manager helper fails', async () => {
    const before = item({
      id: 'git-node',
      dirName: 'git-node',
      sourceType: 'git',
      localCommit: '1'.repeat(40),
      remoteCommit: '2'.repeat(40)
    })
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([before]))
    mocks.runLoggedProcess.mockImplementation(async (_cmd, args: string[]) =>
      args.includes('update-node-now')
        ? { exitCode: 1, stdout: '', stderr: 'ERROR: Git source update did not complete' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )
    const result = await handlePluginUpdate(installation(), { pluginIds: ['git-node'] }, tools())
    expect(result.ok).toBe(false)
    expect(mocks.preparePluginSourceBackups).toHaveBeenCalledWith('C:\\test', 'C:\\test\\ComfyUI', [
      'git-node'
    ])
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.saveSnapshot).toHaveBeenCalledTimes(1)
  })

  it('restores the local CNR backup and records rolled-back, failed, and not-run items', async () => {
    const cnr = item()
    const git = item({
      id: 'git-node',
      dirName: 'git-node',
      sourceType: 'git',
      installedVersion: null,
      latestVersion: null,
      localCommit: '1111111111111111111111111111111111111111',
      remoteCommit: '2222222222222222222222222222222222222222',
      branch: 'main',
      upstream: 'origin/main'
    })
    const notRun = item({ id: 'later-node', dirName: 'later-node' })
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([cnr, git, notRun]))
    mocks.runLoggedProcess.mockImplementation(async (_cmd, args: string[]) =>
      args.includes('update-node-now') && args.some((arg) => arg.endsWith('git-node'))
        ? { exitCode: 1, stdout: '', stderr: 'ERROR: update failed' }
        : { exitCode: 0, stdout: '{}', stderr: '' }
    )

    const result = await handlePluginUpdate(
      installation(),
      { pluginIds: ['cnr-node', 'git-node', 'later-node'] },
      tools()
    )

    expect(result.ok).toBe(false)
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.preparePluginSourceBackups).toHaveBeenCalledWith('C:\\test', 'C:\\test\\ComfyUI', [
      'cnr-node',
      'git-node',
      'later-node'
    ])
    const recorded = mocks.recordPluginUpdateRun.mock.calls.at(-1)?.[1]
    expect(recorded).toMatchObject({
      ok: false,
      items: [
        { id: 'cnr-node', status: 'rolled-back' },
        { id: 'git-node', status: 'failed' },
        { id: 'later-node', status: 'not-run' }
      ]
    })
  })

  it('rolls source and dependencies back when the post-update snapshot cannot be committed', async () => {
    const before = item()
    const after = item({
      installedVersion: '1.1.0',
      status: 'current',
      updateable: false,
      behind: 0
    })
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([before]))
      .mockResolvedValueOnce(inventory([after]))
    mocks.saveSnapshot
      .mockResolvedValueOnce('pre-snapshot.json')
      .mockRejectedValueOnce(new Error('disk full'))

    const result = await handlePluginUpdate(installation(), { pluginIds: ['cnr-node'] }, tools())

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('post-update snapshot')
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.recordPluginUpdateRun).toHaveBeenLastCalledWith(
      'inst-1',
      expect.objectContaining({
        ok: false,
        items: [expect.objectContaining({ status: 'rolled-back' })]
      })
    )
  })
})
