import fs from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import type { InstallationRecord } from '../installations'
import type { FrEnvironmentProfileView } from '../../shared/frEnvironmentProfiles'
import type {
  PluginUpdateInventory,
  PluginUpdateItem,
  PluginUpdateReasonCode,
  PluginUpdateRunSummary,
  PluginUpdateStatus
} from '../../types/ipc'
import { listFrEnvironmentProfiles } from './frEnvironmentProfiles'
import { inspectGitUpdate, lsRemoteRef, tryConfigurePygit2Fallback } from './git'
import { scanCustomNodes, type ScannedNode } from './nodes'
import { getCnrInstallInfo } from './cnr'
import { containsCompiledDependencyDeclaration } from './pluginDependencyPolicy'

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { expiresAt: number; inventory: PluginUpdateInventory }>()
const lastRuns = new Map<string, PluginUpdateRunSummary>()

export interface PluginGitState {
  detached: boolean
  dirty: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  fetchError: string | null
}

export function classifyPluginGitState(state: PluginGitState): PluginUpdateStatus {
  if (state.dirty) return 'dirty'
  if (state.detached) return 'detached'
  if (!state.upstream) return 'no-upstream'
  if (state.fetchError) return 'unreachable'
  if ((state.ahead ?? 0) > 0 && (state.behind ?? 0) > 0) return 'diverged'
  if ((state.behind ?? 0) > 0) return 'update-available'
  if ((state.ahead ?? 0) > 0) return 'ahead'
  return 'current'
}

export function classifyCnrVersionState(
  installedVersion: string | null,
  latestVersion: string | null
): PluginUpdateStatus {
  if (!installedVersion) return 'unsupported'
  if (!latestVersion) return 'unreachable'
  if (installedVersion === latestVersion) return 'current'

  const installed =
    semver.valid(installedVersion, { loose: true }) ?? semver.coerce(installedVersion)
  const latest = semver.valid(latestVersion, { loose: true }) ?? semver.coerce(latestVersion)
  if (!installed || !latest) return 'unreachable'
  if (semver.eq(installed, latest)) return 'current'
  return semver.lt(installed, latest) ? 'update-available' : 'ahead'
}

interface CnrRegistryEntry {
  id: string
  repository: string | null
  latestVersion: string | null
}

function readManagerCnrRegistry(comfyuiDir: string): Map<string, CnrRegistryEntry> {
  const result = new Map<string, CnrRegistryEntry>()
  const cacheDir = path.join(comfyuiDir, 'user', '__manager', 'cache')
  let candidates: fs.Dirent[]
  try {
    candidates = fs
      .readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('_nodes.json'))
      .sort((left, right) => {
        try {
          return (
            fs.statSync(path.join(cacheDir, right.name)).mtimeMs -
            fs.statSync(path.join(cacheDir, left.name)).mtimeMs
          )
        } catch {
          return 0
        }
      })
  } catch {
    return result
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, candidate.name), 'utf-8')) as {
        nodes?: unknown[]
      }
      if (!Array.isArray(parsed.nodes)) continue
      for (const raw of parsed.nodes) {
        if (!raw || typeof raw !== 'object') continue
        const node = raw as Record<string, unknown>
        if (typeof node.id !== 'string') continue
        const latest = node.latest_version as Record<string, unknown> | undefined
        result.set(node.id.toLocaleLowerCase('en-US'), {
          id: node.id,
          repository: typeof node.repository === 'string' ? node.repository : null,
          latestVersion: typeof latest?.version === 'string' ? latest.version : null
        })
      }
      if (result.size > 0) break
    } catch {
      // Try the next Manager cache candidate.
    }
  }
  return result
}

function normalize(candidate: string): string {
  const resolved = path.resolve(candidate)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function matchesInstallRoot(registeredRoot: string, installRoot: string): boolean {
  return (
    normalize(registeredRoot) === installRoot ||
    normalize(path.join(registeredRoot, 'ComfyUI')) === installRoot
  )
}

export function evaluatePluginMutationPolicy(
  installation: InstallationRecord,
  profiles: readonly FrEnvironmentProfileView[]
): {
  mutable: boolean
  reason: string | null
} {
  if (installation.sourceId !== 'standalone') {
    return {
      mutable: false,
      reason: 'This installation layout is available for inspection only.'
    }
  }

  const installRoot = normalize(installation.installPath)
  const stablePath = profiles.find((profile) => profile.role === 'stable')?.suggestedPath
  if (stablePath && matchesInstallRoot(stablePath, installRoot)) {
    return {
      mutable: false,
      reason: 'The FR Stable environment is protected and can only be inspected.'
    }
  }

  const registered = profiles.find(
    (profile) => profile.path != null && matchesInstallRoot(profile.path, installRoot)
  )
  if (registered) {
    if (registered.role === 'stable') {
      return {
        mutable: false,
        reason: 'The FR Stable environment is protected and can only be inspected.'
      }
    }
    if (registered.mode !== 'managed') {
      return {
        mutable: false,
        reason: `The ${registered.role} environment is not authorized for managed changes.`
      }
    }
  }
  return { mutable: true, reason: null }
}

export function getPluginMutationPolicy(installation: InstallationRecord): {
  mutable: boolean
  reason: string | null
} {
  try {
    if (
      fs.existsSync(installation.installPath) &&
      fs.lstatSync(installation.installPath).isSymbolicLink()
    ) {
      return {
        mutable: false,
        reason: 'Linked installation roots are available for inspection only.'
      }
    }
    return evaluatePluginMutationPolicy(installation, listFrEnvironmentProfiles())
  } catch (error) {
    return {
      mutable: false,
      reason: `Environment authorization could not be verified: ${(error as Error).message}`
    }
  }
}

export function resolveComfyUIPath(installation: InstallationRecord): string | null {
  const candidates = [installation.installPath, path.join(installation.installPath, 'ComfyUI')]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'folder_paths.py'))) return candidate
  }
  return null
}

function pluginPath(comfyuiDir: string, node: ScannedNode): string {
  return path.join(comfyuiDir, 'custom_nodes', ...(node.enabled ? [] : ['.disabled']), node.dirName)
}

function dependencyFlags(
  nodePath: string
): Pick<PluginUpdateItem, 'hasRequirements' | 'hasInstallScript' | 'hasCompiledDependencies'> {
  const requirementFiles = ['requirements.txt', 'pyproject.toml', 'setup.py'].filter((name) =>
    fs.existsSync(path.join(nodePath, name))
  )
  const installFiles = ['install.py', 'install.bat', 'install.sh'].filter((name) =>
    fs.existsSync(path.join(nodePath, name))
  )
  const corpus = [...requirementFiles, ...installFiles]
    .map((name) => {
      try {
        return fs.readFileSync(path.join(nodePath, name), 'utf-8')
      } catch {
        return ''
      }
    })
    .join('\n')
  return {
    hasRequirements: requirementFiles.length > 0,
    hasInstallScript: installFiles.length > 0,
    hasCompiledDependencies: containsCompiledDependencyDeclaration(corpus)
  }
}

function reasonForStatus(status: PluginUpdateStatus): string | null {
  switch (status) {
    case 'dirty':
      return 'Uncommitted changes must be handled before updating.'
    case 'ahead':
      return 'The local branch contains commits that are not on its upstream.'
    case 'diverged':
      return 'The local and upstream branches have diverged.'
    case 'detached':
      return 'Detached HEAD cannot be updated automatically.'
    case 'no-upstream':
      return 'No upstream branch is configured.'
    case 'unreachable':
      return 'The remote could not be refreshed; showing the last local comparison.'
    case 'unsupported':
      return 'No Git or Manager v4 CNR metadata was found for this node.'
    default:
      return null
  }
}

function reasonCodeForGitStatus(status: PluginUpdateStatus): PluginUpdateReasonCode | null {
  switch (status) {
    case 'dirty':
      return 'dirty'
    case 'ahead':
      return 'ahead'
    case 'diverged':
      return 'diverged'
    case 'detached':
      return 'detached'
    case 'no-upstream':
      return 'no-upstream'
    case 'unreachable':
      return 'remote-unreachable'
    default:
      return null
  }
}

async function inspectCnrNode(
  node: ScannedNode,
  flags: Pick<PluginUpdateItem, 'hasRequirements' | 'hasInstallScript' | 'hasCompiledDependencies'>,
  registryEntry: CnrRegistryEntry | undefined,
  remoteLatestVersion: string | null | undefined,
  mutable: boolean
): Promise<PluginUpdateItem> {
  const installedVersion = node.version ?? null
  const latestVersion = remoteLatestVersion ?? registryEntry?.latestVersion ?? null
  const status = classifyCnrVersionState(installedVersion, latestVersion)
  const updateable =
    mutable && node.enabled && !flags.hasCompiledDependencies && status === 'update-available'

  let reasonCode: PluginUpdateReasonCode | null = null
  let reason: string | null = null
  if (!node.enabled) {
    reasonCode = 'disabled'
    reason = 'Disabled plugins are shown but not updated.'
  } else if (!installedVersion) {
    reasonCode = 'cnr-version-missing'
    reason = 'The installed CNR version could not be read from pyproject.toml.'
  } else if (!latestVersion) {
    reasonCode = 'cnr-registry-unavailable'
    reason = 'The latest version is not available from Comfy Registry or the Manager cache.'
  } else if (status === 'ahead') {
    reasonCode = 'cnr-newer-than-registry'
    reason = 'The installed CNR version is newer than the registry version.'
  } else if (flags.hasCompiledDependencies && status === 'update-available') {
    reasonCode = 'compiled-dependencies'
    reason = 'Compiled dependencies require a separate compatibility transaction.'
  } else if (!mutable && status === 'update-available') {
    reasonCode = 'read-only'
    reason = 'This environment is read-only.'
  }

  return {
    id: node.id,
    dirName: node.dirName,
    enabled: node.enabled,
    sourceType: 'cnr',
    repository: node.url ?? registryEntry?.repository ?? null,
    branch: null,
    upstream: null,
    localCommit: null,
    remoteCommit: null,
    installedVersion,
    latestVersion,
    ahead: null,
    behind: status === 'update-available' ? 1 : 0,
    dirty: false,
    status,
    updateable,
    reasonCode,
    reason,
    ...flags
  }
}

async function inspectNode(
  comfyuiDir: string,
  node: ScannedNode,
  fetchRemote: boolean,
  mutable: boolean,
  cnrRegistry: ReadonlyMap<string, CnrRegistryEntry>,
  remoteCnrVersions: ReadonlyMap<string, string | null>
): Promise<PluginUpdateItem> {
  const nodePath = pluginPath(comfyuiDir, node)
  const flags = dependencyFlags(nodePath)
  if (node.type === 'cnr') {
    return inspectCnrNode(
      node,
      flags,
      cnrRegistry.get(node.id.toLocaleLowerCase('en-US')),
      remoteCnrVersions.get(node.id.toLocaleLowerCase('en-US')),
      mutable
    )
  }

  if (node.type !== 'git' || !node.url || !fs.existsSync(path.join(nodePath, '.git'))) {
    const hasGitMetadata = fs.existsSync(path.join(nodePath, '.git'))
    const reasonCode: PluginUpdateReasonCode =
      node.type === 'file' ? 'file-node' : hasGitMetadata ? 'missing-git-remote' : 'manual-install'
    return {
      id: node.id,
      dirName: node.dirName,
      enabled: node.enabled,
      sourceType: node.type === 'file' ? 'file' : hasGitMetadata ? 'git' : 'unmanaged',
      repository: node.url ?? null,
      branch: null,
      upstream: null,
      localCommit: node.commit ?? null,
      remoteCommit: null,
      installedVersion: null,
      latestVersion: null,
      ahead: null,
      behind: null,
      dirty: false,
      status: 'unsupported',
      updateable: false,
      reasonCode,
      reason: reasonForStatus('unsupported'),
      ...flags
    }
  }

  try {
    const inspected = await inspectGitUpdate(nodePath, fetchRemote && mutable)
    // A protected/read-only installation must remain byte-for-byte untouched,
    // including its .git metadata. Query the branch tip directly instead of
    // fetching remote-tracking refs into that repository.
    if (fetchRemote && !mutable && inspected.branch) {
      const remoteCommit = await lsRemoteRef(node.url, `refs/heads/${inspected.branch}`)
      if (remoteCommit) {
        inspected.remoteCommit = remoteCommit
        inspected.fetchError = null
        inspected.ahead = 0
        inspected.behind = remoteCommit === inspected.localCommit ? 0 : 1
      } else {
        inspected.fetchError = 'The remote branch could not be queried.'
      }
    }
    const status = classifyPluginGitState(inspected)
    const updateable =
      mutable && node.enabled && !flags.hasCompiledDependencies && status === 'update-available'
    return {
      id: node.id,
      dirName: node.dirName,
      enabled: node.enabled,
      sourceType: 'git',
      repository: node.url,
      branch: inspected.branch,
      upstream: inspected.upstream,
      localCommit: inspected.localCommit,
      remoteCommit: inspected.remoteCommit,
      installedVersion: null,
      latestVersion: null,
      ahead: inspected.ahead,
      behind: inspected.behind,
      dirty: inspected.dirty,
      status,
      updateable,
      reasonCode: !node.enabled
        ? 'disabled'
        : flags.hasCompiledDependencies && status === 'update-available'
          ? 'compiled-dependencies'
          : !mutable && status === 'update-available'
            ? 'read-only'
            : reasonCodeForGitStatus(status),
      reason: !node.enabled
        ? 'Disabled plugins are shown but not updated.'
        : flags.hasCompiledDependencies && status === 'update-available'
          ? 'Compiled dependencies require a separate compatibility transaction.'
          : !mutable && status === 'update-available'
            ? 'This environment is read-only.'
            : reasonForStatus(status),
      ...flags
    }
  } catch (error) {
    return {
      id: node.id,
      dirName: node.dirName,
      enabled: node.enabled,
      sourceType: 'git',
      repository: node.url,
      branch: null,
      upstream: null,
      localCommit: node.commit ?? null,
      remoteCommit: null,
      installedVersion: null,
      latestVersion: null,
      ahead: null,
      behind: null,
      dirty: false,
      status: 'unreachable',
      updateable: false,
      reasonCode: 'remote-unreachable',
      reason: (error as Error).message,
      ...flags
    }
  }
}

export async function getPluginUpdateInventory(
  installation: InstallationRecord,
  refresh = false
): Promise<PluginUpdateInventory> {
  const cached = cache.get(installation.id)
  if (!refresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.inventory, lastRun: lastRuns.get(installation.id) ?? null }
  }

  const comfyuiDir = resolveComfyUIPath(installation)
  if (!comfyuiDir) throw new Error('ComfyUI directory could not be located for this installation.')
  const policy = getPluginMutationPolicy(installation)
  if (policy.mutable) {
    await tryConfigurePygit2Fallback(installation.installPath).catch(() => false)
  }
  const nodes = await scanCustomNodes(comfyuiDir)
  const cnrRegistry = readManagerCnrRegistry(comfyuiDir)
  const remoteCnrVersions = new Map<string, string | null>()
  if (refresh) {
    const cnrNodes = nodes.filter((node) => node.type === 'cnr')
    let cursor = 0
    const workers = Array.from({ length: Math.min(6, cnrNodes.length) }, async () => {
      while (cursor < cnrNodes.length) {
        const node = cnrNodes[cursor++]!
        const info = await getCnrInstallInfo(node.id, undefined, {
          refresh: true,
          timeoutMs: 8_000
        })
        remoteCnrVersions.set(node.id.toLocaleLowerCase('en-US'), info?.version ?? null)
      }
    })
    await Promise.all(workers)
  }
  const items: PluginUpdateItem[] = []
  // Git repositories stay serial because they can share credential helpers and
  // proxy state. CNR metadata above uses a bounded six-request pool.
  for (const node of nodes) {
    items.push(
      await inspectNode(comfyuiDir, node, refresh, policy.mutable, cnrRegistry, remoteCnrVersions)
    )
  }
  items.sort((left, right) => {
    if (left.status === 'update-available' && right.status !== 'update-available') return -1
    if (right.status === 'update-available' && left.status !== 'update-available') return 1
    return left.id.localeCompare(right.id)
  })

  const attentionStatuses = new Set<PluginUpdateStatus>([
    'dirty',
    'ahead',
    'diverged',
    'detached',
    'no-upstream',
    'unreachable'
  ])
  const inventory: PluginUpdateInventory = {
    installationId: installation.id,
    checkedAt: new Date().toISOString(),
    mutable: policy.mutable,
    mutationBlockedReason: policy.reason,
    items,
    lastRun: lastRuns.get(installation.id) ?? null,
    summary: {
      total: items.length,
      updateAvailable: items.filter((item) => item.status === 'update-available').length,
      attention: items.filter((item) => attentionStatuses.has(item.status)).length,
      unsupported: items.filter((item) => item.status === 'unsupported').length
    }
  }
  cache.set(installation.id, { expiresAt: Date.now() + CACHE_TTL_MS, inventory })
  return inventory
}

export function invalidatePluginUpdateInventory(installationId: string): void {
  cache.delete(installationId)
}

export function recordPluginUpdateRun(
  installationId: string,
  result: PluginUpdateRunSummary
): void {
  lastRuns.set(installationId, result)
  invalidatePluginUpdateInventory(installationId)
}

export const __testing = { cache, lastRuns }
