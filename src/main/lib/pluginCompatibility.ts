import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InstallationRecord } from '../installations'
import type {
  PluginCompatibilityEnvironment,
  PluginCompatibilityPlan,
  PluginUpdateInventory,
  PluginDependencyDeclaration,
  PluginDependencyDifference,
  PluginInstallHookDifference,
  PluginUpdateItem
} from '../../types/ipc'
import { getActivePythonPath, getActiveUvPath } from './pythonEnv'
import { getActiveVenvDir } from './pythonEnv'
import { pluginSourceManifest } from './pluginSourceManifest'
import {
  DependencyPlanningError,
  classifyDeclarations,
  runDependencyHelper,
  resolvePluginWheels,
  type PluginDependencyAnalysis
} from './pluginDependencyPlan'
import { pipFreeze } from './pip'
import { getCnrInstallInfo } from './cnr'
import { download } from './download'
import { extract } from './extract'
import { gitExportTree } from './git'
import { evaluateDedicatedInstallPolicy, evaluateManagerV4Policy } from './frPluginLifecycle'
import { directoryByteSize } from './pluginEnvironmentBackup'
import { assertPluginPath } from './pluginFilesystem'
import {
  DEFAULT_MANAGER_NETWORK_MODE,
  DEFAULT_MANAGER_SECURITY_LEVEL,
  isManagerNetworkMode,
  isManagerSecurityLevel
} from './managerConfig'
import {
  isCompiledDependency,
  isProtectedDependency,
  normalizePythonPackageName
} from './pluginDependencyPolicy'
import {
  getPluginMutationPolicy,
  getPluginUpdateInventory,
  resolveComfyUIPath
} from './pluginUpdates'

const PLAN_CACHE_TTL_MS = 10 * 60 * 1000
const planCache = new Map<string, { expiresAt: number; plan: PluginCompatibilityPlan }>()
const INSTALL_HOOKS = [
  'install.py',
  'setup.py',
  'install.bat',
  'install.sh',
  'prestartup_script.py'
] as const
const NATIVE_BINARY_EXTENSIONS = new Set(['.pyd', '.dll', '.so', '.dylib', '.node', '.exe'])

export interface CompatibilityInspectionInput {
  installationId: string
  item: PluginUpdateItem
  currentRoot: string
  targetRoot: string
  targetSource: string
  provenance: string
  environment: PluginCompatibilityEnvironment
  installedPackages: Record<string, string>
  preexistingPipCheckIssues: string[]
  managerPolicyAllowed: boolean
  managerPolicyReason: string | null
  dependencyAnalysis: PluginDependencyAnalysis
}

interface StagedTarget {
  root: string
  targetSource: string
  provenance: string
  cleanup: () => Promise<void>
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

function normalizedInstalledPackages(
  packages: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(packages).map(([name, version]) => [normalizePythonPackageName(name), version])
  )
}

function declarationKey(item: PluginDependencyDeclaration): string {
  return `${item.normalizedName};${[...(item.extras ?? [])].sort().join(',')};${item.active !== false}`
}

function declarationValue(item: PluginDependencyDeclaration): string {
  return item.constraint ?? ''
}

function mergedDeclarations(
  declarations: readonly PluginDependencyDeclaration[]
): PluginDependencyDeclaration[] {
  const groups = new Map<string, PluginDependencyDeclaration>()
  for (const item of declarations.filter(
    (entry) => !entry.sourceFile.startsWith('installed-metadata:')
  )) {
    const key = declarationKey(item)
    const previous = groups.get(key)
    const constraints = [
      ...new Set(
        [...(previous?.constraint ?? '').split(','), ...(item.constraint ?? '').split(',')].filter(
          Boolean
        )
      )
    ].sort()
    groups.set(key, {
      ...item,
      constraint: constraints.join(',') || null,
      sourceFiles: [...new Set([...(previous?.sourceFiles ?? []), item.sourceFile])].sort()
    })
  }
  return [...groups.values()].sort((a, b) =>
    declarationKey(a).localeCompare(declarationKey(b), 'en-US')
  )
}

function diffDependencies(
  current: readonly PluginDependencyDeclaration[],
  target: readonly PluginDependencyDeclaration[]
): PluginDependencyDifference[] {
  const currentMap = new Map(
    mergedDeclarations(current).map((item) => [declarationKey(item), item])
  )
  const targetMap = new Map(mergedDeclarations(target).map((item) => [declarationKey(item), item]))
  const keys = [...new Set([...currentMap.keys(), ...targetMap.keys()])].sort()
  const result: PluginDependencyDifference[] = []
  for (const key of keys) {
    const from = currentMap.get(key)
    const to = targetMap.get(key)
    if (!from && to) {
      result.push({
        name: to.name,
        kind: 'added',
        from: null,
        to: declarationValue(to),
        compiled: to.compiled,
        protected: to.protected
      })
    } else if (from && !to) {
      result.push({
        name: from.name,
        kind: 'removed',
        from: declarationValue(from),
        to: null,
        compiled: from.compiled,
        protected: from.protected
      })
    } else if (from && to && declarationValue(from) !== declarationValue(to)) {
      result.push({
        name: to.name,
        kind: 'changed',
        from: declarationValue(from),
        to: declarationValue(to),
        compiled: from.compiled || to.compiled,
        protected: from.protected || to.protected
      })
    }
  }
  return result
}

function fileHash(filePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function compareInstallHooks(
  currentRoot: string,
  targetRoot: string
): PluginInstallHookDifference[] {
  const result: PluginInstallHookDifference[] = []
  for (const name of INSTALL_HOOKS) {
    const current = fileHash(path.join(currentRoot, name))
    const target = fileHash(path.join(targetRoot, name))
    if (!current && !target) continue
    result.push({
      path: name,
      kind: !current ? 'added' : !target ? 'removed' : current === target ? 'unchanged' : 'changed'
    })
  }
  return result
}

function scanNativeBinaries(root: string): Map<string, string> {
  const result = new Map<string, string>()
  const walk = (directory: string, relative: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const childPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        result.set(`symlink:${childRelative}`, 'symlink')
      } else if (entry.isDirectory()) {
        walk(childPath, childRelative)
      } else if (
        entry.isFile() &&
        NATIVE_BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        const hash = fileHash(childPath)
        if (hash) result.set(childRelative, hash)
      }
    }
  }
  walk(root, '')
  return result
}

function dependencyShape(items: readonly PluginDependencyDeclaration[]): unknown[] {
  return items.map((item) => ({
    name: item.normalizedName,
    constraint: item.constraint,
    marker: item.marker,
    extras: item.extras,
    active: item.active,
    sourceFile: item.sourceFile,
    compiled: item.compiled,
    protected: item.protected,
    installedVersion: item.compiled || item.protected ? item.installedVersion : null
  }))
}

function itemCurrentRef(item: PluginUpdateItem): string | null {
  return item.sourceType === 'cnr' ? item.installedVersion : item.localCommit
}

function itemTargetRef(item: PluginUpdateItem): string | null {
  return item.sourceType === 'cnr' ? item.latestVersion : item.remoteCommit
}

export function buildPluginCompatibilityPlan(
  input: CompatibilityInspectionInput
): PluginCompatibilityPlan {
  const analysis = input.dependencyAnalysis
  const current = { declarations: classifyDeclarations(analysis.current) }
  const target = { declarations: classifyDeclarations(analysis.target) }
  const dependencyDifferences = diffDependencies(current.declarations, target.declarations)
  const compiledDependencyDifferences = dependencyDifferences.filter((item) => item.compiled)
  const protectedStackDifferences = dependencyDifferences.filter(
    (item) =>
      item.protected &&
      target.declarations.some(
        (declaration) =>
          declaration.normalizedName === normalizePythonPackageName(item.name) &&
          declaration.active !== false &&
          declaration.satisfied === false
      )
  )
  const installHookDifferences = compareInstallHooks(input.currentRoot, input.targetRoot)
  const currentNative = scanNativeBinaries(input.currentRoot)
  const targetNative = scanNativeBinaries(input.targetRoot)
  const nativeBinaryChanges = [...targetNative.entries()]
    .filter(([name, hash]) => currentNative.get(name) !== hash)
    .map(([name]) => name)
    .sort()
  const nativeBinaryFiles = [...targetNative.keys()].sort()
  const blockers: string[] = []
  const warnings = analysis.issues.map((issue) => `Dependency analysis requires review: ${issue}`)

  if (!input.managerPolicyAllowed) {
    blockers.push(input.managerPolicyReason ?? 'Manager v4 policy does not allow this update.')
  }
  for (const dependency of target.declarations.filter((item) => item.active !== false)) {
    if (dependency.protected && dependency.satisfied === false) {
      blockers.push(
        `${dependency.name}${dependency.constraint ?? ''} is not satisfied by the current environment.`
      )
    } else if (dependency.satisfied === null) {
      warnings.push(`The constraint for ${dependency.name} requires manual verification.`)
    }
  }
  const changedHooks = installHookDifferences.filter((item) => item.kind !== 'unchanged')
  if (changedHooks.length > 0) {
    warnings.push('Install or startup hooks changed and require review or Lab validation.')
  }
  if (nativeBinaryChanges.length > 0) {
    warnings.push('The target adds or changes native binary files and requires ABI review.')
  }
  if (input.preexistingPipCheckIssues.length > 0) {
    warnings.push(
      'Existing pip check issues are reported separately and are not attributed to this update.'
    )
  }

  const isolatedReview =
    changedHooks.length > 0 ||
    nativeBinaryChanges.length > 0 ||
    analysis.issues.length > 0 ||
    target.declarations.some(
      (dependency) => dependency.active !== false && dependency.satisfied === null
    )
  const needsPackages = target.declarations.some(
    (dependency) =>
      dependency.active !== false && !dependency.protected && dependency.satisfied === false
  )
  const executionMode = isolatedReview
    ? 'isolated-review'
    : needsPackages
      ? 'wheel-update'
      : 'source-only'
  const verdict: PluginCompatibilityPlan['verdict'] = blockers.length
    ? 'blocked'
    : isolatedReview || needsPackages
      ? 'review-required'
      : 'ready'

  const currentRef = itemCurrentRef(input.item)
  const targetRef = itemTargetRef(input.item)
  const environmentFingerprint = digest({
    environment: input.environment,
    installedPackages: analysis.installedPackages,
    installedRequirements: analysis.installedRequirements,
    markerEnvironment: analysis.markerEnvironment,
    currentRef,
    targetRef,
    targetDependencies: dependencyShape(target.declarations)
  })
  const planDigest = digest({
    installationId: input.installationId,
    pluginId: input.item.id,
    dirName: input.item.dirName,
    sourceType: input.item.sourceType,
    currentRef,
    targetRef,
    provenance: input.provenance,
    environmentFingerprint,
    currentDependencies: dependencyShape(current.declarations),
    targetDependencies: dependencyShape(target.declarations),
    dependencyDifferences,
    installHookDifferences,
    nativeBinaryFiles,
    nativeBinaryChanges,
    verdict,
    blockers,
    warnings
  })

  return {
    installationId: input.installationId,
    pluginId: input.item.id,
    dirName: input.item.dirName,
    sourceType: input.item.sourceType,
    currentRef,
    targetRef,
    targetSource: input.targetSource,
    provenance: input.provenance,
    generatedAt: new Date().toISOString(),
    environmentFingerprint,
    planDigest,
    environment: input.environment,
    currentDependencies: current.declarations,
    targetDependencies: target.declarations,
    dependencyDifferences,
    compiledDependencyDifferences,
    protectedStackDifferences,
    installHookDifferences,
    nativeBinaryFiles,
    nativeBinaryChanges,
    preexistingPipCheckIssues: input.preexistingPipCheckIssues,
    verdict,
    blockers,
    warnings,
    proposedChanges: dependencyDifferences,
    executionMode,
    packageChanges: [],
    installedPackages: analysis.installedPackages
  }
}

function execText(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '')
        })
      }
    )
  })
}

async function inspectEnvironment(installation: InstallationRecord): Promise<{
  environment: PluginCompatibilityEnvironment
  installedPackages: Record<string, string>
  pipCheckIssues: string[]
}> {
  const pythonPath = getActivePythonPath(installation)
  const uvPath = getActiveUvPath(installation)
  if (!pythonPath || !fs.existsSync(pythonPath)) throw new Error('The active Python was not found.')
  if (!fs.existsSync(uvPath)) throw new Error('The active uv executable was not found.')
  const probe = await execText(pythonPath, [
    '-I',
    '-c',
    "import json,platform,sys; print(json.dumps({'version': platform.python_version(), 'architecture': platform.machine() or platform.architecture()[0]}))"
  ])
  if (probe.code !== 0) throw new Error(probe.stderr.trim() || 'Python environment probe failed.')
  const runtime = JSON.parse(probe.stdout.trim()) as { version: string; architecture: string }
  const rawPackages = await pipFreeze(uvPath, pythonPath)
  const installedPackages = normalizedInstalledPackages(rawPackages)
  const pipCheck = await execText(uvPath, ['pip', 'check', '--python', pythonPath])
  if (pipCheck.code !== 0 && pipCheck.code !== 1)
    throw new Error(pipCheck.stderr.trim() || 'Python dependency checking could not run.')
  const pipCheckIssues = `${pipCheck.stdout}\n${pipCheck.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^checked\s+/i.test(line))
  const compiledPackages = Object.fromEntries(
    Object.entries(installedPackages).filter(([name]) => isCompiledDependency(name))
  )
  const torchVersion = installedPackages.torch ?? null
  const cudaMatch = torchVersion?.match(/\+cu(\d+)/i)
  const cudaVersion = cudaMatch
    ? `cu${cudaMatch[1]}`
    : (Object.keys(installedPackages).find((name) => name.startsWith('nvidia-cuda-runtime-cu')) ??
      null)
  return {
    environment: {
      pythonVersion: runtime.version,
      pythonArchitecture: runtime.architecture,
      torchVersion,
      cudaVersion,
      numpyVersion: installedPackages.numpy ?? null,
      compiledPackages
    },
    installedPackages,
    pipCheckIssues
  }
}

function readManagerConfig(comfyuiDir: string): Record<string, string> {
  const configPath = path.join(comfyuiDir, 'user', '__manager', 'config.ini')
  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return {}
  }
  const result: Record<string, string> = {}
  let inDefault = false
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[([^\]]+)\]/.exec(line)
    if (section) {
      inDefault = section[1] === 'default'
      continue
    }
    if (!inDefault) continue
    const option = /^([^=:]+)[=:](.*)$/.exec(line)
    if (option) result[option[1]!.trim().toLocaleLowerCase('en-US')] = option[2]!.trim()
  }
  return result
}

export function managerListenAddress(launchArgs: unknown): string {
  if (typeof launchArgs !== 'string') return '127.0.0.1'
  const explicit = /(?:^|\s)--listen(?:=|\s+)("[^"]+"|'[^']+'|[^\s-][^\s]*)/.exec(launchArgs)
  if (explicit) return explicit[1]!.replace(/^['"]|['"]$/g, '')
  return /(?:^|\s)--listen(?:\s|$)/.test(launchArgs) ? '0.0.0.0' : '127.0.0.1'
}

function managerPolicy(
  installation: InstallationRecord,
  comfyuiDir: string,
  item: PluginUpdateItem,
  installPackages = false
): { allowed: boolean; reason: string | null } {
  const config = readManagerConfig(comfyuiDir)
  const securityCandidate = config.security_level ?? installation.managerSecurityLevel
  const networkCandidate = config.network_mode ?? installation.managerNetworkMode
  const securityLevel = isManagerSecurityLevel(securityCandidate)
    ? securityCandidate
    : DEFAULT_MANAGER_SECURITY_LEVEL
  const networkMode = isManagerNetworkMode(networkCandidate)
    ? networkCandidate
    : DEFAULT_MANAGER_NETWORK_MODE
  if (networkMode === 'offline') {
    return { allowed: false, reason: 'Manager v4 is configured for offline network mode.' }
  }
  if (item.sourceType !== 'cnr' && item.sourceType !== 'git') {
    return { allowed: false, reason: 'This plugin source is not managed by Manager v4.' }
  }
  if (
    installPackages &&
    !evaluateDedicatedInstallPolicy({
      enabled: /^(true|1|yes)$/i.test(config.allow_pip_install ?? 'false'),
      networkMode,
      listenAddress: managerListenAddress(installation.launchArgs)
    })
  )
    return {
      allowed: false,
      reason: 'Manager v4 pip installation permission is disabled for this instance.'
    }
  const decision = evaluateManagerV4Policy({
    risk: item.sourceType === 'cnr' ? 'middle' : 'middle+',
    securityLevel,
    networkMode,
    listenAddress: managerListenAddress(installation.launchArgs)
  })
  return decision.allowed
    ? { allowed: true, reason: null }
    : {
        allowed: false,
        reason: `Manager v4 policy denied this ${item.sourceType === 'cnr' ? 'middle' : 'middle+'} action (${decision.reason}).`
      }
}

async function stageTarget(item: PluginUpdateItem, currentRoot: string): Promise<StagedTarget> {
  const stagingRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fr-plugin-compat-'))
  const targetRoot = path.join(stagingRoot, 'target')
  await fs.promises.mkdir(targetRoot)
  const cleanup = () => fs.promises.rm(stagingRoot, { recursive: true, force: true })
  try {
    if (item.sourceType === 'cnr') {
      if (!item.latestVersion) throw new Error('The exact target CNR version is unavailable.')
      const info = await getCnrInstallInfo(item.id, item.latestVersion, {
        refresh: true,
        timeoutMs: 20_000
      })
      if (!info || info.version !== item.latestVersion) {
        throw new Error('Comfy Registry did not return the requested exact target version.')
      }
      const archivePath = path.join(stagingRoot, 'target.zip')
      await download(info.downloadUrl, archivePath, null)
      await extract(archivePath, targetRoot)
      return {
        root: targetRoot,
        targetSource: 'Comfy Registry',
        provenance: `https://api.comfy.org/nodes/${encodeURIComponent(item.id)}/install?version=${encodeURIComponent(info.version)}`,
        cleanup
      }
    }
    if (item.sourceType === 'git') {
      if (!item.remoteCommit) throw new Error('The exact target Git commit is unavailable.')
      await gitExportTree(currentRoot, item.remoteCommit, targetRoot)
      return {
        root: targetRoot,
        targetSource: item.repository ?? 'Git upstream',
        provenance: `${item.repository ?? 'Git upstream'}#${item.remoteCommit}`,
        cleanup
      }
    }
    throw new Error('This plugin source cannot be inspected for a compatible update.')
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}

function errorPlan(
  installationId: string,
  item: PluginUpdateItem,
  error: unknown
): PluginCompatibilityPlan {
  const message = error instanceof Error ? error.message : String(error)
  const currentRef = itemCurrentRef(item)
  const targetRef = itemTargetRef(item)
  const environment: PluginCompatibilityEnvironment = {
    pythonVersion: 'unknown',
    pythonArchitecture: 'unknown',
    torchVersion: null,
    cudaVersion: null,
    numpyVersion: null,
    compiledPackages: {}
  }
  const environmentFingerprint = digest({ currentRef, targetRef, error: message })
  return {
    installationId,
    pluginId: item.id,
    dirName: item.dirName,
    sourceType: item.sourceType,
    currentRef,
    targetRef,
    targetSource: item.repository ?? item.sourceType,
    provenance: item.repository ?? item.sourceType,
    generatedAt: new Date().toISOString(),
    environmentFingerprint,
    planDigest: digest({ installationId, dirName: item.dirName, currentRef, targetRef, message }),
    environment,
    currentDependencies: [],
    targetDependencies: [],
    dependencyDifferences: [],
    compiledDependencyDifferences: [],
    protectedStackDifferences: [],
    installHookDifferences: [],
    nativeBinaryFiles: [],
    nativeBinaryChanges: [],
    preexistingPipCheckIssues: [],
    verdict: 'error',
    blockers: [message],
    warnings: [],
    proposedChanges: []
  }
}

export async function getPluginCompatibilityPlan(
  installation: InstallationRecord,
  dirName: string,
  refresh = false,
  checkedInventory?: PluginUpdateInventory
): Promise<PluginCompatibilityPlan> {
  const cacheKey = `${installation.id}:${dirName.toLocaleLowerCase('en-US')}`
  const cached = planCache.get(cacheKey)
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.plan

  const inventory = checkedInventory ?? (await getPluginUpdateInventory(installation, true))
  const item = inventory.items.find((candidate) => candidate.dirName === dirName)
  if (!item) throw new Error('Plugin is no longer installed.')
  const comfyuiDir = resolveComfyUIPath(installation)
  if (!comfyuiDir) throw new Error('ComfyUI directory could not be located.')
  const mutationPolicy = getPluginMutationPolicy(installation)
  const currentRoot = path.resolve(comfyuiDir, 'custom_nodes', item.dirName)
  const customNodesRoot = path.resolve(comfyuiDir, 'custom_nodes')
  if (!currentRoot.startsWith(customNodesRoot + path.sep)) throw new Error('Invalid plugin path.')

  let plan: PluginCompatibilityPlan
  let staged: StagedTarget | null = null
  try {
    if (!mutationPolicy.mutable)
      throw new Error(mutationPolicy.reason ?? 'This environment is read-only.')
    await assertPluginPath(installation.installPath, currentRoot)
    if (!item.enabled) throw new Error('Disabled plugins cannot be updated.')
    if (item.status !== 'update-available') throw new Error('No exact update target is available.')
    const inspectedEnvironment = await inspectEnvironment(installation)
    staged = await stageTarget(item, currentRoot)
    const pythonPath = getActivePythonPath(installation)!
    const dependencyAnalysis = await runDependencyHelper<PluginDependencyAnalysis>(
      pythonPath,
      'analyze',
      {
        currentRoot,
        targetRoot: staged.root
      }
    )
    const policy = managerPolicy(installation, comfyuiDir, item)
    plan = buildPluginCompatibilityPlan({
      installationId: installation.id,
      item,
      currentRoot,
      targetRoot: staged.root,
      targetSource: staged.targetSource,
      provenance: staged.provenance,
      environment: inspectedEnvironment.environment,
      installedPackages: inspectedEnvironment.installedPackages,
      preexistingPipCheckIssues: inspectedEnvironment.pipCheckIssues,
      managerPolicyAllowed: policy.allowed,
      managerPolicyReason: policy.reason,
      dependencyAnalysis
    })
    plan.sourceFiles = await pluginSourceManifest(staged.root)
    const currentFiles = await pluginSourceManifest(currentRoot)
    plan.currentSourceFiles = currentFiles
    plan.sourceDigest = digest(plan.sourceFiles)
    plan.environmentFingerprint = digest({ previous: plan.environmentFingerprint, currentFiles })
    if (plan.executionMode === 'wheel-update' && plan.verdict !== 'blocked') {
      const pipPolicy = managerPolicy(installation, comfyuiDir, item, true)
      try {
        plan.packageChanges = await resolvePluginWheels(
          pythonPath,
          getActiveUvPath(installation),
          dependencyAnalysis,
          path.join(installation.installPath, '.launcher', 'plugin-wheel-cache')
        )
        const sensitive = plan.packageChanges.some((change) =>
          /^(onnxruntime-gpu|bitsandbytes|insightface|llama-cpp-python)$/.test(change.name)
        )
        if (plan.packageChanges.some((change) => isProtectedDependency(change.name))) {
          plan.blockers.push(
            'The target changes the protected Python, Torch, CUDA, NumPy, or accelerator stack.'
          )
          plan.verdict = 'blocked'
        } else if (sensitive) {
          plan.executionMode = 'isolated-review'
          plan.verdict = 'review-required'
          plan.warnings.push(
            'The compiled runtime needs a verified capability profile before installation.'
          )
        } else {
          plan.verdict = plan.packageChanges.length ? 'approval-required' : 'ready'
          plan.executionMode = plan.packageChanges.length ? 'wheel-update' : 'source-only'
          plan.environmentBackupBytes = plan.packageChanges.length
            ? await directoryByteSize(getActiveVenvDir(installation))
            : 0
          plan.downloadBytes = plan.packageChanges.reduce(
            (sum, change) => sum + change.wheel.size,
            0
          )
        }
      } catch (error) {
        if (error instanceof DependencyPlanningError) {
          plan.dependencyConflicts = error.conflicts
          plan.resolutionDetails = error.details
        }
        plan.blockers.push(
          plan.dependencyConflicts?.length
            ? 'The wheel plan conflicts with retained installed packages.'
            : `Dependency plan could not be prepared: ${(error as Error).message}`
        )
        plan.verdict = 'blocked'
      }
      if (plan.verdict === 'approval-required' && !pipPolicy.allowed) {
        plan.blockers.push(pipPolicy.reason!)
        plan.verdict = 'blocked'
      }
    }
    if (plan.verdict === 'ready' || plan.verdict === 'approval-required') {
      if (
        path.resolve(getActiveVenvDir(installation)) !==
        path.resolve(installation.installPath, 'ComfyUI', '.venv')
      ) {
        plan.verdict = 'blocked'
        plan.blockers.push(
          'This update requires a managed Python environment with offline backup support.'
        )
      } else plan.environmentBackupBytes = await directoryByteSize(getActiveVenvDir(installation))
    }
    plan.expiresAt = new Date(Date.now() + PLAN_CACHE_TTL_MS).toISOString()
    plan.planDigest = digest({
      previous: plan.planDigest,
      sourceDigest: plan.sourceDigest,
      environmentFingerprint: plan.environmentFingerprint,
      packageChanges: plan.packageChanges,
      executionMode: plan.executionMode,
      verdict: plan.verdict,
      blockers: plan.blockers
    })
  } catch (error) {
    plan = errorPlan(installation.id, item, error)
  } finally {
    await staged?.cleanup().catch(() => {})
  }
  planCache.set(cacheKey, { expiresAt: Date.now() + PLAN_CACHE_TTL_MS, plan })
  return plan
}

export function invalidatePluginCompatibilityPlans(installationId: string): void {
  for (const key of planCache.keys()) {
    if (key.startsWith(`${installationId}:`)) planCache.delete(key)
  }
}

export function getApprovedPluginPlan(
  installationId: string,
  dirName: string,
  planDigest: string
): PluginCompatibilityPlan | null {
  const cached = planCache.get(`${installationId}:${dirName.toLocaleLowerCase('en-US')}`)
  return cached && cached.expiresAt > Date.now() && cached.plan.planDigest === planDigest
    ? cached.plan
    : null
}

export const __testing = { planCache, mergedDeclarations, managerPolicy }
