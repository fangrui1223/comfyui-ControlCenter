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

  it('forwards rollback progress and reports backup cleanup before completion', async () => {
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))
    mocks.runLoggedProcess.mockImplementation(async (_cmd, args: string[]) =>
      args.includes('update-node-now')
        ? { exitCode: 1, stdout: '', stderr: 'source update failed' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )
    mocks.restorePluginTransaction.mockImplementation(
      async (_inst, _journal, _output, progress) => {
        progress(45, 'Restoring Python environment from the offline backup…')
        return []
      }
    )
    const actionTools = tools()

    const result = await handleCompatiblePluginUpdate(installation(), request, actionTools)

    expect(result.ok).toBe(false)
    expect(actionTools.sendProgress).toHaveBeenCalledWith('plugin-rollback', {
      percent: 45,
      status: 'Restoring Python environment from the offline backup…'
    })
    expect(actionTools.sendProgress).toHaveBeenCalledWith('plugin-rollback', {
      percent: -1,
      status: 'Removing completed rollback backups…'
    })
    expect(actionTools.sendProgress).toHaveBeenCalledWith('plugin-rollback', {
      percent: 100,
      status: 'The pre-update state was restored.'
    })
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
    expect(result.message).toContain('cnr-node: source differs from approved archive')
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

  it('retains local wheel origins throughout a source-only compatibility update', async () => {
    const packages = {
      ...compatibilityPlan().installedPackages,
      sageattention: 'file:///D:/cache/sageattention.whl#sha256=' + 'a'.repeat(64),
      'llama-cpp-python': 'file:///C:/cache/llama_cpp_python.whl#sha256=' + 'b'.repeat(64)
    }
    mocks.getPluginCompatibilityPlan.mockResolvedValue(
      compatibilityPlan({ installedPackages: packages })
    )
    mocks.pipFreeze.mockResolvedValue(packages)
    mocks.getPluginUpdateInventory
      .mockResolvedValueOnce(inventory([compiled()]))
      .mockResolvedValueOnce(inventory([compiled({ installedVersion: '1.1.0' })]))

    const result = await handleCompatiblePluginUpdate(installation(), request, tools())

    expect(result.ok).toBe(true)
    expect(mocks.pipFreeze).toHaveBeenCalledTimes(3)
    expect(mocks.installApprovedWheels).not.toHaveBeenCalled()
    expect(mocks.restorePluginTransaction).not.toHaveBeenCalled()
  })

  it('rejects changed local wheel origins before creating a snapshot or backup', async () => {
    const approvedReference = 'file:///D:/cache/sageattention.whl#sha256=' + 'a'.repeat(64)
    mocks.getPluginCompatibilityPlan.mockResolvedValue(
      compatibilityPlan({
        installedPackages: {
          ...compatibilityPlan().installedPackages,
          sageattention: approvedReference
        }
      })
    )
    mocks.pipFreeze.mockResolvedValue({
      ...compatibilityPlan().installedPackages,
      sageattention: approvedReference.replace('a'.repeat(64), 'b'.repeat(64))
    })
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory([compiled()]))

    const result = await handleCompatiblePluginUpdate(installation(), request, tools())

    expect(result.ok).toBe(false)
    expect(result.message).toContain('approved environment changed')
    expect(mocks.saveSnapshot).not.toHaveBeenCalled()
    expect(mocks.preparePluginSourceBackups).not.toHaveBeenCalled()
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
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

describe('source-only compatible batches', () => {
  function batch() {
    const nodes = Array.from({ length: 10 }, (_, index) =>
      item({
        id: `node-${index}`,
        dirName: `node-${index}`,
        updateable: index === 0,
        hasCompiledDependencies: index !== 0,
        reasonCode: index === 0 ? null : 'compiled-dependencies',
        reason: index === 0 ? null : 'Check compatibility first.',
        ...(index === 1
          ? {
              sourceType: 'git' as const,
              localCommit: '1'.repeat(40),
              remoteCommit: '2'.repeat(40),
              installedVersion: null,
              latestVersion: null
            }
          : {})
      })
    )
    const plans = new Map(
      nodes.map((node) => [
        node.dirName,
        compatibilityPlan({
          pluginId: node.id,
          dirName: node.dirName,
          sourceType: node.sourceType,
          currentRef: node.sourceType === 'git' ? node.localCommit : node.installedVersion,
          targetRef: node.sourceType === 'git' ? node.remoteCommit : node.latestVersion
        })
      ])
    )
    mocks.getApprovedPluginPlan.mockImplementation((_id, dirName, digest) => {
      const plan = plans.get(dirName)
      return plan?.planDigest === digest ? plan : null
    })
    mocks.getPluginCompatibilityPlan.mockImplementation(async (_inst, dirName) =>
      plans.get(dirName)
    )
    mocks.getPluginUpdateInventory.mockResolvedValueOnce(inventory(nodes)).mockResolvedValueOnce(
      inventory(
        nodes.map((node) => ({
          ...node,
          localCommit: node.sourceType === 'git' ? node.remoteCommit : null,
          installedVersion: node.sourceType === 'cnr' ? node.latestVersion : null,
          status: 'current' as const
        }))
      )
    )
    const request = {
      pluginIds: nodes.map((node) => node.dirName),
      compatibilityPlans: nodes.slice(1).map((node) => ({
        dirName: node.dirName,
        planDigest: plans.get(node.dirName)!.planDigest,
        ...(node.sourceType === 'git'
          ? { targetCommit: node.remoteCommit }
          : { targetVersion: node.latestVersion })
      }))
    }
    return { nodes, plans, request }
  }

  it('updates ten mixed standard and compiled plugins with one environment backup and one commit', async () => {
    const f = batch()
    const actionTools = tools()
    const result = await handlePluginUpdate(installation(), f.request, actionTools)

    expect(result.ok).toBe(true)
    expect(mocks.preparePluginSourceBackups).toHaveBeenCalledExactlyOnceWith(
      'C:\\test',
      'C:\\test\\ComfyUI',
      f.request.pluginIds
    )
    expect(mocks.beginPluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.beginPluginTransaction.mock.calls[0]?.[3]).toBe(true)
    expect(mocks.saveSnapshot).toHaveBeenCalledTimes(2)
    expect(mocks.finishPluginTransaction).toHaveBeenCalledExactlyOnceWith(
      installation(),
      expect.any(Object),
      true
    )
    const updates = mocks.runLoggedProcess.mock.calls.filter((call) =>
      call[1].includes('update-node-now')
    )
    expect(updates).toHaveLength(10)
    for (const call of updates) expect(call[1]).toContain('--source-only')
    expect(
      mocks.runLoggedProcess.mock.calls.filter((call) => call[1].includes('import-smoke'))
    ).toHaveLength(10)
    expect(mocks.verifyPluginSource).toHaveBeenCalledTimes(10)
    expect(mocks.prepareApprovedWheels).not.toHaveBeenCalled()
    expect(mocks.installApprovedWheels).not.toHaveBeenCalled()
    expect(actionTools.sendProgress).toHaveBeenCalledWith('plugin-verify', {
      percent: 90,
      status: 'Verifying node-9 (10/10)…'
    })
    expect(mocks.recordPluginUpdateRun).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        ok: true,
        items: f.nodes.map((node) =>
          expect.objectContaining({ dirName: node.dirName, status: 'updated' })
        )
      })
    )
  })

  it('restores the entire shared batch once when one plugin fails validation', async () => {
    const f = batch()
    mocks.runLoggedProcess.mockImplementation(async (_cmd, args: string[]) =>
      args.includes('import-smoke') && args.some((arg) => arg.endsWith('node-3'))
        ? { exitCode: 1, stdout: '', stderr: 'target import failed' }
        : { exitCode: 0, stdout: '{}', stderr: '' }
    )
    const result = await handlePluginUpdate(installation(), f.request, tools())

    expect(result.ok).toBe(false)
    expect(result.message).toContain('pre-update state was restored')
    expect(mocks.beginPluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.restorePluginTransaction).toHaveBeenCalledOnce()
    expect(mocks.finishPluginTransaction).toHaveBeenCalledExactlyOnceWith(
      installation(),
      expect.any(Object),
      false
    )
    expect(mocks.saveSnapshot).toHaveBeenCalledOnce()
    expect(mocks.recordPluginUpdateRun).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        ok: false,
        items: f.nodes.map((node) =>
          expect.objectContaining({
            dirName: node.dirName,
            status: node.dirName === 'node-3' ? 'failed' : 'rolled-back'
          })
        )
      })
    )
  })

  it('refuses a compiled plugin without a cached approval before backing up', async () => {
    const f = batch()
    const result = await handlePluginUpdate(
      installation(),
      { pluginIds: f.request.pluginIds },
      tools()
    )
    expect(result.ok).toBe(false)
    expect(mocks.getPluginCompatibilityPlan).not.toHaveBeenCalled()
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
    expect(mocks.saveSnapshot).not.toHaveBeenCalled()
  })

  it('refuses expired approvals before snapshots or backups', async () => {
    const f = batch()
    mocks.getApprovedPluginPlan.mockReturnValue(null)
    const result = await handlePluginUpdate(installation(), f.request, tools())
    expect(result.message).toContain('stale or expired')
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
    expect(mocks.saveSnapshot).not.toHaveBeenCalled()
  })

  it('rechecks every approved digest and refuses a changed plan before mutation', async () => {
    const f = batch()
    mocks.getPluginCompatibilityPlan.mockImplementation(async (_inst, dirName) => ({
      ...f.plans.get(dirName),
      ...(dirName === 'node-2' ? { planDigest: 'c'.repeat(64) } : {})
    }))
    const result = await handlePluginUpdate(installation(), f.request, tools())
    expect(result.message).toContain('plan changed')
    expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
    expect(mocks.preparePluginSourceBackups).not.toHaveBeenCalled()
  })

  it.each(['wheel-update', 'isolated-review'] as const)(
    'does not merge %s plans even with a dependency approval flag',
    async (executionMode) => {
      const f = batch()
      f.plans.get('node-1')!.executionMode = executionMode
      const result = await handlePluginUpdate(
        installation(),
        { ...f.request, approveDependencies: true },
        tools()
      )
      expect(result.message).toContain('Only approved source-only updates')
      expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
      expect(mocks.prepareApprovedWheels).not.toHaveBeenCalled()
      expect(mocks.installApprovedWheels).not.toHaveBeenCalled()
    }
  )

  it.each(['disabled', 'dirty', 'current'] as const)(
    'does not bypass a %s plugin restriction with a cached plan',
    async (restriction) => {
      const f = batch()
      Object.assign(
        f.nodes[1]!,
        restriction === 'disabled'
          ? { enabled: false }
          : restriction === 'dirty'
            ? { dirty: true }
            : { status: 'current' }
      )
      const result = await handlePluginUpdate(installation(), f.request, tools())
      expect(result.ok).toBe(false)
      expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
    }
  )

  it.each(['duplicate', 'unselected', 'malformed'] as const)(
    'rejects %s batch approvals before reading the inventory',
    async (kind) => {
      const f = batch()
      const valid = f.request.compatibilityPlans[0]!
      const compatibilityPlans =
        kind === 'duplicate'
          ? [valid, valid]
          : kind === 'unselected'
            ? [{ ...valid, dirName: 'another-plugin' }]
            : [{ ...valid, planDigest: 'invalid' }]
      const result = await handlePluginUpdate(
        installation(),
        { ...f.request, compatibilityPlans },
        tools()
      )
      expect(result.message).toContain('Invalid batch')
      expect(mocks.getPluginUpdateInventory).not.toHaveBeenCalled()
      expect(mocks.beginPluginTransaction).not.toHaveBeenCalled()
    }
  )
})
