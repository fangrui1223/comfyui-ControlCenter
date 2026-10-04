import fs from 'node:fs'
import path from 'node:path'
import type { InstallationRecord } from '../../installations'
import type {
  PluginCompatibilityPlan,
  PluginCompatibilityValidation,
  PluginUpdateItem,
  PluginUpdateRunItem
} from '../../../types/ipc'
import * as snapshots from '../../lib/snapshots'
import { getActivePythonPath, getActiveUvPath } from '../../lib/pythonEnv'
import { pipFreeze } from '../../lib/pip'
import { getBundledScriptPath } from '../../lib/bundledScript'
import {
  getPluginMutationPolicy,
  getPluginUpdateInventory,
  invalidatePluginUpdateInventory,
  recordPluginUpdateRun,
  resolveComfyUIPath
} from '../../lib/pluginUpdates'
import {
  getPluginCompatibilityPlan,
  getApprovedPluginPlan,
  invalidatePluginCompatibilityPlans
} from '../../lib/pluginCompatibility'
import { normalizePythonPackageName, isProtectedDependency } from '../../lib/pluginDependencyPolicy'
import {
  discardPluginSourceBackups,
  preparePluginSourceBackups
} from '../../lib/pluginUpdateBackup'
import {
  beginPluginTransaction,
  writePluginJournal,
  restorePluginTransaction,
  finishPluginTransaction,
  recoverInterruptedPluginUpdate,
  type PluginTransactionJournal
} from '../../lib/pluginEnvironmentBackup'
import { prepareApprovedWheels, installApprovedWheels } from '../../lib/pluginWheelInstall'
import { pluginSourceManifest, verifyPluginSource } from '../../lib/pluginSourceManifest'
import { assertPluginPath } from '../../lib/pluginFilesystem'
import { runLoggedProcess, withOutputTail } from '../../lib/logged-process'
import { releaseInstallTerminalForFsOp } from '../../lib/popoutWindows'
import type { ActionResult, ActionTools } from '../../types/sources'

function requestedPluginIds(actionData: Record<string, unknown> | undefined): string[] {
  const raw = actionData?.pluginIds
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((value): value is string => typeof value === 'string'))]
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 200 && !/[\\/\0]/.test(value))
    .slice(0, 100)
}

function installedRef(item: PluginUpdateItem): string | null {
  return item.sourceType === 'cnr' ? item.installedVersion : item.localCommit
}

function targetRef(item: PluginUpdateItem): string | null {
  return item.sourceType === 'cnr' ? item.latestVersion : item.remoteCommit
}

interface PluginUpdateTransactionOptions {
  compatibilityPlan?: PluginCompatibilityPlan
  compatibilityPlans?: PluginCompatibilityPlan[]
}

interface CompatibilityBaseline {
  packages: Record<string, string>
  pipCheckIssues: string[]
}

function normalizedPackageState(
  packages: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(packages).map(([name, version]) => [normalizePythonPackageName(name), version])
  )
}

function packageStateDifferences(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): string[] {
  const left = normalizedPackageState(before)
  const right = normalizedPackageState(after)
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return names
    .filter((name) => left[name] !== right[name])
    .map((name) => `${name}: ${left[name] ?? '(absent)'} -> ${right[name] ?? '(absent)'}`)
}

function pipCheckLines(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^checked\s+/i.test(line))
}

async function captureCompatibilityBaseline(
  installation: InstallationRecord,
  pythonPath: string,
  sendOutput: ActionTools['sendOutput']
): Promise<CompatibilityBaseline> {
  const uvPath = getActiveUvPath(installation)
  if (!fs.existsSync(uvPath)) throw new Error('The active uv executable was not found.')
  const packages = await pipFreeze(uvPath, pythonPath)
  const checked = await runLoggedProcess(uvPath, ['pip', 'check', '--python', pythonPath], {
    cwd: installation.installPath,
    sendOutput
  })
  if (checked.exitCode !== 0 && checked.exitCode !== 1)
    throw new Error(checked.stderr || 'Python dependency checking could not run.')
  return { packages, pipCheckIssues: pipCheckLines(checked.stdout, checked.stderr) }
}

async function validateCompatibleUpdate(
  installation: InstallationRecord,
  item: PluginUpdateItem,
  comfyuiDir: string,
  pythonPath: string,
  managerOperationsScript: string,
  compatibilityProbeScript: string,
  baseline: CompatibilityBaseline,
  plan: PluginCompatibilityPlan,
  sendOutput: ActionTools['sendOutput']
): Promise<{ validation: PluginCompatibilityValidation; failure: string | null }> {
  const validation: PluginCompatibilityValidation = {
    sourceRevisionVerified: true,
    packageStateVerified: false,
    protectedStackVerified: false,
    pipCheckVerified: false,
    importSmokeVerified: false,
    managerStateVerified: false,
    details: []
  }
  const uvPath = getActiveUvPath(installation)
  const afterPackages = await pipFreeze(uvPath, pythonPath)
  const expected = normalizedPackageState(baseline.packages)
  for (const change of plan.packageChanges ?? []) {
    if (isProtectedDependency(change.name) || change.kind === 'removed')
      throw new Error('Invalid approved package scope.')
    expected[change.name] = change.to
  }
  const packageDiff = packageStateDifferences(expected, afterPackages)
  if (packageDiff.length > 0) {
    validation.details.push(`Unexpected package changes: ${packageDiff.join('; ')}`)
    return {
      validation,
      failure: 'The compatibility update changed Python packages outside the approved plan.'
    }
  }
  validation.packageStateVerified = true
  const protectedBefore = Object.fromEntries(
    Object.entries(normalizedPackageState(baseline.packages)).filter(([name]) =>
      isProtectedDependency(name)
    )
  )
  const protectedAfter = Object.fromEntries(
    Object.entries(normalizedPackageState(afterPackages)).filter(([name]) =>
      isProtectedDependency(name)
    )
  )
  if (packageStateDifferences(protectedBefore, protectedAfter).length)
    return { validation, failure: 'The protected runtime changed.' }
  validation.protectedStackVerified = true
  validation.details.push(
    'Python package state matches the approved plan; protected stack is unchanged.'
  )

  const pipCheck = await runLoggedProcess(uvPath, ['pip', 'check', '--python', pythonPath], {
    cwd: installation.installPath,
    sendOutput
  })
  if (pipCheck.exitCode !== 0 && pipCheck.exitCode !== 1)
    return { validation, failure: 'Python dependency validation could not run.' }
  const beforeIssues = new Set(baseline.pipCheckIssues)
  const newIssues = pipCheckLines(pipCheck.stdout, pipCheck.stderr).filter(
    (issue) => !beforeIssues.has(issue)
  )
  if (newIssues.length > 0) {
    validation.details.push(`New pip check issues: ${newIssues.join('; ')}`)
    return { validation, failure: 'The update introduced new Python environment conflicts.' }
  }
  validation.pipCheckVerified = true
  validation.details.push('pip check introduced no new issues.')

  const pluginDir = path.join(comfyuiDir, 'custom_nodes', item.dirName)
  const validationCache = path.join(
    installation.installPath,
    '.launcher',
    'plugin-validation-cache',
    plan.planDigest
  )
  await assertPluginPath(installation.installPath, validationCache)
  const importResult = await runLoggedProcess(
    pythonPath,
    [
      '-s',
      '-B',
      compatibilityProbeScript,
      'import-smoke',
      '--comfyui-dir',
      comfyuiDir,
      '--plugin-dir',
      pluginDir
    ],
    {
      cwd: comfyuiDir,
      env: {
        ...process.env,
        COMFYUI_PATH: comfyuiDir,
        PYTHONIOENCODING: 'utf-8',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        TORCH_EXTENSIONS_DIR: path.join(validationCache, 'torch-extensions'),
        TRITON_CACHE_DIR: path.join(validationCache, 'triton'),
        NUMBA_CACHE_DIR: path.join(validationCache, 'numba')
      },
      sendOutput
    }
  )
  if (importResult.exitCode !== 0) {
    validation.details.push(withOutputTail('Plugin import smoke failed.', importResult.stderr))
    return { validation, failure: `${item.id} failed its import smoke test.` }
  }
  validation.importSmokeVerified = true
  validation.details.push('Plugin import smoke passed.')

  const managerResult = await runLoggedProcess(
    pythonPath,
    [
      '-s',
      managerOperationsScript,
      'inspect-node',
      '--comfyui-dir',
      comfyuiDir,
      '--user-dir',
      path.join(comfyuiDir, 'user'),
      '--plugin-dir',
      pluginDir,
      ...(item.sourceType === 'cnr' && targetRef(item)
        ? ['--expected-version', targetRef(item)!]
        : [])
    ],
    { cwd: comfyuiDir, env: { ...process.env, COMFYUI_PATH: comfyuiDir }, sendOutput }
  )
  if (managerResult.exitCode !== 0) {
    validation.details.push(withOutputTail('Manager v4 status check failed.', managerResult.stderr))
    return { validation, failure: 'Manager v4 no longer recognizes the updated plugin.' }
  }
  validation.managerStateVerified = true
  validation.details.push('Manager v4 recognizes the updated plugin.')
  // Importing custom nodes executes their Python code. Recheck after it so an
  // import-time dependency installer cannot bypass the approved package scope.
  const finalPackages = await pipFreeze(uvPath, pythonPath)
  if (packageStateDifferences(expected, finalPackages).length) {
    validation.packageStateVerified = false
    validation.protectedStackVerified = false
    return { validation, failure: 'Plugin validation changed packages outside the approved plan.' }
  }
  const finalCheck = await runLoggedProcess(uvPath, ['pip', 'check', '--python', pythonPath], {
    cwd: installation.installPath,
    sendOutput
  })
  if (finalCheck.exitCode !== 0 && finalCheck.exitCode !== 1) {
    validation.pipCheckVerified = false
    return { validation, failure: 'Final Python dependency validation could not run.' }
  }
  if (
    pipCheckLines(finalCheck.stdout, finalCheck.stderr).some((issue) => !beforeIssues.has(issue))
  ) {
    validation.pipCheckVerified = false
    return { validation, failure: 'Plugin validation introduced new environment conflicts.' }
  }
  return { validation, failure: null }
}

function requestedCompatiblePlugin(actionData: Record<string, unknown> | undefined): {
  dirName: string
  targetRef: string
  planDigest: string
} | null {
  const dirName = actionData?.dirName
  const targetVersion = actionData?.targetVersion
  const targetCommit = actionData?.targetCommit
  const planDigest = actionData?.planDigest
  const targetRef = typeof targetVersion === 'string' ? targetVersion : targetCommit
  if (
    typeof dirName !== 'string' ||
    !dirName ||
    dirName.length > 200 ||
    /[\\/\0]/.test(dirName) ||
    typeof targetRef !== 'string' ||
    !targetRef ||
    typeof planDigest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(planDigest)
  ) {
    return null
  }
  return { dirName, targetRef, planDigest: planDigest.toLocaleLowerCase('en-US') }
}

async function runPluginUpdateTransaction(
  installation: InstallationRecord,
  selectedItems: PluginUpdateItem[],
  { update, sendProgress, sendOutput }: ActionTools,
  options: PluginUpdateTransactionOptions = {}
): Promise<ActionResult> {
  if (!selectedItems.length) return { ok: false, message: 'No plugins were selected.' }
  const policy = getPluginMutationPolicy(installation)
  if (!policy.mutable)
    return { ok: false, message: policy.reason ?? 'This environment is read-only.' }
  const comfyuiDir = resolveComfyUIPath(installation)
  const pythonPath = getActivePythonPath(installation)
  if (!comfyuiDir || !pythonPath || !fs.existsSync(pythonPath))
    return { ok: false, message: 'The active ComfyUI environment was not found.' }
  const managerScript = getBundledScriptPath('manager_operations.py')
  const probeScript = getBundledScriptPath('plugin_compatibility_probe.py')
  if (!fs.existsSync(managerScript) || (options.compatibilityPlan && !fs.existsSync(probeScript)))
    return { ok: false, message: 'The bundled update adapter was not found.' }
  const plan = options.compatibilityPlan
  const plans = options.compatibilityPlans ?? (plan ? [plan] : [])
  const runItems: PluginUpdateRunItem[] = selectedItems.map((item) => ({
    id: item.id,
    dirName: item.dirName,
    sourceType: item.sourceType,
    from: installedRef(item),
    to: targetRef(item),
    status: 'not-run',
    message: null,
    ...(plans.find((plan) => plan.dirName === item.dirName)
      ? {
          planDigest: plans.find((plan) => plan.dirName === item.dirName)!.planDigest,
          validation: null
        }
      : {})
  }))
  let journal: PluginTransactionJournal | null = null
  let baseline: CompatibilityBaseline | null = null
  let preSnapshotFile: string | null = null
  releaseInstallTerminalForFsOp(installation.id)
  sendProgress('steps', {
    steps: [
      { phase: 'plugin-preflight', label: 'Check approved plan and download wheels', weight: 2 },
      { phase: 'plugin-snapshot', label: 'Save restore point', weight: 1 },
      { phase: 'plugin-backup', label: 'Back up source and Python environment', weight: 3 },
      ...selectedItems.map((item, index) => ({
        phase: `plugin-update-${index}`,
        label: `Update ${item.id}`,
        weight: 3
      })),
      { phase: 'plugin-dependencies', label: 'Install approved local wheels', weight: 3 },
      {
        phase: 'plugin-verify',
        label: 'Verify source, dependencies, import and Manager state',
        weight: 4
      },
      { phase: 'plugin-rollback', label: 'Rollback if needed', weight: 2 },
      { phase: 'plugin-post-snapshot', label: 'Commit update snapshot', weight: 1 }
    ]
  })
  try {
    let requirements: string | null = null
    if (plans.length) {
      baseline = await captureCompatibilityBaseline(installation, pythonPath, sendOutput)
      for (const approved of plans) {
        if (
          !approved.installedPackages ||
          !approved.sourceFiles ||
          packageStateDifferences(approved.installedPackages, baseline.packages).length
        )
          throw new Error('The approved environment changed. Check compatibility again.')
      }
      if (plan?.executionMode === 'wheel-update')
        requirements = await prepareApprovedWheels(installation, plan)
    }
    sendProgress('plugin-preflight', { percent: 100, status: 'Update preflight completed.' })
    const preFile = await snapshots.saveSnapshot(
      installation.installPath,
      installation,
      'pre-update',
      `Before plugin update (${selectedItems.length})`
    )
    preSnapshotFile = preFile
    await update({
      lastSnapshot: preFile,
      snapshotCount: await snapshots.getSnapshotCount(installation.installPath)
    })
    sendProgress('plugin-snapshot', { percent: 100, status: 'Pre-update snapshot saved.' })
    sendProgress('plugin-backup', {
      percent: -1,
      status: 'Creating source and full Python environment backups…'
    })
    const backups = await preparePluginSourceBackups(
      installation.installPath,
      comfyuiDir,
      selectedItems.map((item) => item.dirName)
    )
    if (!backups) throw new Error('No source rollback backup was created.')
    try {
      // Import validation executes plugin code. Preserve the environment even
      // for source-only updates so an unexpected side effect can be rolled back.
      journal = await beginPluginTransaction(
        installation,
        backups,
        plan?.planDigest ?? null,
        true,
        (percent) =>
          sendProgress('plugin-backup', { percent, status: 'Backing up the Python environment…' })
      )
    } catch (error) {
      await recoverInterruptedPluginUpdate(installation, sendOutput).catch(() => {})
      await discardPluginSourceBackups(backups).catch(() => {})
      throw error
    }
    sendProgress('plugin-backup', { percent: 100, status: 'Offline rollback backups are ready.' })
    await writePluginJournal(installation, journal, 'applying-source')
    for (let index = 0; index < selectedItems.length; index++) {
      const item = selectedItems[index]!
      const itemPlan = plans.find((plan) => plan.dirName === item.dirName)
      const runItem = runItems[index]!
      if (itemPlan?.currentSourceFiles) {
        const currentFiles = await pluginSourceManifest(
          path.join(comfyuiDir, 'custom_nodes', item.dirName)
        )
        if (JSON.stringify(currentFiles) !== JSON.stringify(itemPlan.currentSourceFiles))
          throw new Error('Plugin source changed after approval. Check compatibility again.')
      }
      sendProgress(`plugin-update-${index}`, {
        percent: 0,
        status: `Updating ${item.id} (${index + 1}/${selectedItems.length})…`
      })
      const result = await runLoggedProcess(
        pythonPath,
        [
          '-s',
          managerScript,
          'update-node-now',
          '--comfyui-dir',
          comfyuiDir,
          '--user-dir',
          path.join(comfyuiDir, 'user'),
          '--plugin-dir',
          path.join(comfyuiDir, 'custom_nodes', item.dirName),
          ...(item.sourceType === 'git' && item.remoteCommit
            ? ['--expected-commit', item.remoteCommit]
            : []),
          ...(itemPlan ? ['--source-only'] : []),
          ...(itemPlan && item.sourceType === 'cnr'
            ? ['--expected-target', itemPlan.targetRef ?? '']
            : [])
        ],
        { cwd: comfyuiDir, env: { ...process.env, COMFYUI_PATH: comfyuiDir }, sendOutput }
      )
      const output = `${result.stdout}\n${result.stderr}`
      if (result.exitCode !== 0 || /(^|\n)\s*(?:ERROR:|\[bold red\]ERROR)/i.test(output)) {
        runItem.status = 'failed'
        throw new Error(withOutputTail(`Manager v4 could not update ${item.id}.`, output))
      }
      runItem.status = 'updated'
      runItem.message = 'Manager v4 source update completed.'
      if (itemPlan)
        await verifyPluginSource(
          path.join(comfyuiDir, 'custom_nodes', item.dirName),
          itemPlan.sourceFiles!
        )
      sendProgress(`plugin-update-${index}`, { percent: 100, status: `${item.id} updated.` })
    }
    if (requirements) {
      await writePluginJournal(installation, journal, 'applying-dependencies')
      sendProgress('plugin-dependencies', {
        percent: 0,
        status: 'Installing the approved local wheels…'
      })
      await installApprovedWheels(installation, requirements, sendOutput)
    }
    sendProgress('plugin-dependencies', {
      percent: 100,
      status: requirements ? 'Approved wheels installed.' : 'Python packages retained.'
    })
    await writePluginJournal(installation, journal, 'validating')
    invalidatePluginUpdateInventory(installation.id)
    const verified = await getPluginUpdateInventory(installation, true)
    for (const item of selectedItems) {
      const current = verified.items.find((candidate) => candidate.dirName === item.dirName)
      if (!current || installedRef(current) !== targetRef(item))
        throw new Error(`${item.id} did not reach its upstream revision.`)
    }
    if (baseline) {
      for (const approved of plans) {
        const index = selectedItems.findIndex((item) => item.dirName === approved.dirName)
        const checked = await validateCompatibleUpdate(
          installation,
          selectedItems[index]!,
          comfyuiDir,
          pythonPath,
          managerScript,
          probeScript,
          baseline,
          approved,
          sendOutput
        )
        runItems[index]!.validation = checked.validation
        if (checked.failure) {
          runItems[index]!.status = 'failed'
          throw new Error(checked.failure)
        }
      }
    }
    sendProgress('plugin-verify', { percent: 100, status: 'Compatibility validation passed.' })
    const postFile = await snapshots
      .saveSnapshot(
        installation.installPath,
        installation,
        'post-update',
        `After plugin update (${selectedItems.length})`
      )
      .catch((error) => {
        throw new Error(`Could not commit the post-update snapshot: ${(error as Error).message}`)
      })
    await update({
      lastSnapshot: postFile,
      snapshotCount: await snapshots.getSnapshotCount(installation.installPath)
    })
    // If durable commit fails, recovery still has both complete backups.
    await writePluginJournal(installation, journal, 'committed')
  } catch (error) {
    const failure = (error as Error).message
    const rollbackErrors: string[] = []
    if (journal) {
      sendProgress('plugin-rollback', {
        percent: 0,
        status: 'Restoring the offline pre-update backup…'
      })
      try {
        rollbackErrors.push(...(await restorePluginTransaction(installation, journal, sendOutput)))
        if (!rollbackErrors.length) await finishPluginTransaction(installation, journal, false)
      } catch (rollbackError) {
        rollbackErrors.push((rollbackError as Error).message)
      }
      for (const item of runItems) if (item.status === 'updated') item.status = 'rolled-back'
    }
    const failed = runItems.find((item) => item.status === 'failed') ?? runItems[0]!
    if (failed.status === 'not-run') failed.status = 'failed'
    failed.message = failure
    recordPluginUpdateRun(installation.id, {
      completedAt: new Date().toISOString(),
      ok: false,
      items: runItems
    })
    invalidatePluginUpdateInventory(installation.id)
    invalidatePluginCompatibilityPlans(installation.id)
    await update(
      preSnapshotFile
        ? {
            lastSnapshot: preSnapshotFile,
            snapshotCount: await snapshots.getSnapshotCount(installation.installPath)
          }
        : {}
    ).catch(() => {})
    return {
      ok: false,
      message: rollbackErrors.length
        ? `${failure}\n\nRollback needs attention:\n${rollbackErrors.join('\n')}`
        : journal
          ? `${failure}\n\nThe pre-update state was restored.`
          : failure
    }
  }
  try {
    await finishPluginTransaction(installation, journal!, true)
  } catch (error) {
    sendOutput(`Committed backup cleanup will be retried: ${(error as Error).message}\n`)
  }
  recordPluginUpdateRun(installation.id, {
    completedAt: new Date().toISOString(),
    ok: true,
    items: runItems
  })
  invalidatePluginUpdateInventory(installation.id)
  invalidatePluginCompatibilityPlans(installation.id)
  sendProgress('plugin-post-snapshot', { percent: 100, status: 'Update snapshot committed.' })
  sendProgress('done', {
    percent: 100,
    status: 'Plugin update complete; instance remains stopped.'
  })
  return { ok: true, navigate: 'detail' }
}

export async function handlePluginUpdate(
  installation: InstallationRecord,
  actionData: Record<string, unknown> | undefined,
  tools: ActionTools
): Promise<ActionResult> {
  const pluginIds = requestedPluginIds(actionData)
  if (pluginIds.length === 0) return { ok: false, message: 'No plugins were selected.' }
  const inventory = await getPluginUpdateInventory(installation, true)
  const selected = pluginIds.map((id) => inventory.items.find((item) => item.dirName === id))
  const missing = selected.findIndex((item) => item == null)
  if (missing >= 0) {
    return { ok: false, message: `Plugin "${pluginIds[missing]}" is no longer installed.` }
  }
  const selectedItems = selected.filter((item): item is PluginUpdateItem => item != null)
  const blocked = selectedItems.find((item) => !item.updateable)
  if (blocked) {
    return {
      ok: false,
      message: `${blocked.id} cannot be updated: ${blocked.reason ?? blocked.status}`
    }
  }
  const plans: PluginCompatibilityPlan[] = []
  for (const item of selectedItems) {
    const plan = await getPluginCompatibilityPlan(installation, item.dirName, true, inventory)
    if (
      plan.verdict !== 'ready' ||
      plan.executionMode !== 'source-only' ||
      plan.targetRef !== targetRef(item)
    ) {
      return {
        ok: false,
        message: `${item.id}: ${plan.blockers[0] ?? 'Open the compatibility report to review this update before execution.'}`
      }
    }
    plans.push(plan)
  }
  return runPluginUpdateTransaction(installation, selectedItems, tools, {
    compatibilityPlans: plans
  })
}

export async function handleCompatiblePluginUpdate(
  installation: InstallationRecord,
  actionData: Record<string, unknown> | undefined,
  tools: ActionTools
): Promise<ActionResult> {
  const request = requestedCompatiblePlugin(actionData)
  if (!request) {
    return {
      ok: false,
      message: 'A valid compatibility plan digest and exact target are required.'
    }
  }

  const approved = getApprovedPluginPlan(installation.id, request.dirName, request.planDigest)
  if (!approved)
    return {
      ok: false,
      message: 'The compatibility plan is stale or expired. Check compatibility again.'
    }
  const plan = await getPluginCompatibilityPlan(installation, request.dirName, true)
  if (
    plan.planDigest.toLocaleLowerCase('en-US') !== request.planDigest ||
    plan.targetRef !== request.targetRef
  ) {
    return {
      ok: false,
      message: 'The compatibility plan is stale. Check compatibility again before updating.'
    }
  }
  if (
    plan.verdict !== 'ready' &&
    !(
      plan.verdict === 'approval-required' &&
      actionData?.approveDependencies === true &&
      plan.executionMode === 'wheel-update' &&
      plan.packageChanges?.length
    )
  ) {
    return {
      ok: false,
      message: `Compatibility update refused: ${plan.blockers[0] ?? plan.verdict}`
    }
  }
  if (
    (plan.verdict === 'ready' &&
      (plan.executionMode !== 'source-only' || plan.packageChanges?.length)) ||
    plan.packageChanges?.some(
      (change) => isProtectedDependency(change.name) || change.kind === 'removed'
    )
  ) {
    return { ok: false, message: 'The package scope is not permitted for this plugin update.' }
  }

  const inventory = await getPluginUpdateInventory(installation, false)
  const item = inventory.items.find((candidate) => candidate.dirName === request.dirName)
  if (!item) return { ok: false, message: 'Plugin is no longer installed.' }
  if (
    !item.enabled ||
    item.status !== 'update-available' ||
    (item.sourceType !== 'cnr' && item.sourceType !== 'git') ||
    targetRef(item) !== request.targetRef
  ) {
    return {
      ok: false,
      message: 'The plugin is no longer eligible for this compatibility transaction.'
    }
  }
  return runPluginUpdateTransaction(installation, [item], tools, { compatibilityPlan: plan })
}
