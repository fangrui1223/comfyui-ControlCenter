import fs from 'node:fs'
import path from 'node:path'
import type {
  FrDedicatedInstallPolicyInput,
  FrManagerPolicyDecision,
  FrManagerPolicyInput,
  FrPluginCatalog,
  FrPluginCatalogEntry
} from '../../shared/frPluginLifecycle'
import { FR_PLUGIN_CATALOG_VERSION } from '../../shared/frPluginLifecycle'
import { hasGitDir, readGitHead, readGitRemoteUrl } from './git'

const COMPILED_DEPENDENCY_PATTERNS = [
  /tensorrt/i,
  /onnxruntime/i,
  /flash[_-]?attn/i,
  /sageattention/i,
  /xformers/i,
  /triton/i,
  /torch[-_]?tensorrt/i,
  /bitsandbytes/i,
  /llama[-_]?cpp/i
]

const RETIRE_CANDIDATE_PATTERNS = [
  /^comfyui-manager$/i,
  /^comfyui[_-]memory[_-]cleanup$/i,
  /^intelligentvramnode$/i,
  /^comfyui[_-]reservedvram$/i
]

function safeIso(timestampMs: number): string | null {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null
}

function readTextIfPresent(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

function listRequirementFiles(pluginPath: string): string[] {
  const candidates = ['requirements.txt', 'pyproject.toml', 'install.py', 'setup.py']
  return candidates.filter((name) => fs.existsSync(path.join(pluginPath, name)))
}

function hasFrontendExtension(pluginPath: string): boolean {
  return ['web', 'js', 'dist', 'src'].some((name) => fs.existsSync(path.join(pluginPath, name)))
}

function hasCompiledDependency(pluginPath: string, requirementFiles: readonly string[]): boolean {
  const corpus = requirementFiles
    .map((name) => readTextIfPresent(path.join(pluginPath, name)))
    .join('\n')
  return COMPILED_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(corpus))
}

function pluginId(pluginPath: string): string {
  const pyproject = readTextIfPresent(path.join(pluginPath, 'pyproject.toml'))
  const match = /^name\s*=\s*["']([^"']+)["']/m.exec(pyproject)
  return match?.[1] ?? path.basename(pluginPath)
}

function pluginVersion(pluginPath: string): string | null {
  const pyproject = readTextIfPresent(path.join(pluginPath, 'pyproject.toml'))
  return /^version\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? null
}

function scanPluginEntry(
  sourceRoot: string,
  entry: fs.Dirent,
  enabled: boolean
): FrPluginCatalogEntry | null {
  if (entry.name.startsWith('.') || entry.name === '__pycache__') return null
  const pluginPath = path.join(sourceRoot, entry.name)
  if (!entry.isDirectory() && !entry.name.endsWith('.py')) return null

  const requirementFiles = entry.isDirectory() ? listRequirementFiles(pluginPath) : []
  const managerReplacement = /comfyui-manager/i.test(entry.name)
  const retireCandidate = RETIRE_CANDIDATE_PATTERNS.some((pattern) => pattern.test(entry.name))
  const compiled = entry.isDirectory()
    ? hasCompiledDependency(pluginPath, requirementFiles) ||
      COMPILED_DEPENDENCY_PATTERNS.some((p) => p.test(entry.name))
    : false
  let stat: fs.Stats | null = null
  try {
    stat = fs.statSync(pluginPath)
  } catch {}

  const reasons = ['Existing plugin is held back from the clean Python 3.13 environment.']
  if (compiled)
    reasons.push('Compiled or ABI-sensitive dependency requires a target-runtime probe.')
  if (managerReplacement) reasons.push('Legacy Manager node is replaced by the Manager v4 package.')
  if (retireCandidate) reasons.push('Function overlaps Core or Control Center resource management.')

  return {
    id: entry.isDirectory() ? pluginId(pluginPath) : entry.name,
    directoryName: entry.name,
    sourceRoot,
    enabled,
    sourceType: !entry.isDirectory()
      ? 'file'
      : fs.existsSync(path.join(pluginPath, '.tracking'))
        ? 'cnr'
        : hasGitDir(pluginPath)
          ? 'git'
          : 'unmanaged',
    repository: entry.isDirectory() ? readGitRemoteUrl(pluginPath) : null,
    commit: entry.isDirectory() ? readGitHead(pluginPath) : null,
    version: entry.isDirectory() ? pluginVersion(pluginPath) : null,
    lastWriteAt: stat ? safeIso(stat.mtimeMs) : null,
    requirements: requirementFiles,
    hasCompiledDependencies: compiled,
    hasFrontendExtension: entry.isDirectory() && hasFrontendExtension(pluginPath),
    lifecycle: managerReplacement ? 'replaced' : retireCandidate ? 'retired' : 'held-back',
    migrationDisposition: managerReplacement
      ? 'manager-v4-replaces-legacy'
      : retireCandidate
        ? 'retire-candidate'
        : compiled
          ? 'clean-install-required'
          : 'review-required',
    reasons
  }
}

function readDirectoryEntries(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
}

export function scanLegacyPluginCatalog(
  sourceInstall: string,
  targetInstall: string,
  generatedAt = new Date().toISOString()
): FrPluginCatalog {
  const customNodesRoot = path.join(sourceInstall, 'custom_nodes')
  const enabled = readDirectoryEntries(customNodesRoot)
    .map((entry) => scanPluginEntry(customNodesRoot, entry, true))
    .filter((entry): entry is FrPluginCatalogEntry => entry !== null)
  const disabledRoot = path.join(customNodesRoot, '.disabled')
  const disabled = readDirectoryEntries(disabledRoot)
    .map((entry) => scanPluginEntry(disabledRoot, entry, false))
    .filter((entry): entry is FrPluginCatalogEntry => entry !== null)
  const entries = [...enabled, ...disabled].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName)
  )

  return {
    version: FR_PLUGIN_CATALOG_VERSION,
    generatedAt,
    sourceInstall,
    targetInstall,
    strategy: 'clean-room-selective-reinstall',
    entries,
    summary: {
      total: entries.length,
      heldBack: entries.filter((entry) => entry.lifecycle === 'held-back').length,
      compiledDependencyCandidates: entries.filter((entry) => entry.hasCompiledDependencies).length,
      frontendExtensionCandidates: entries.filter((entry) => entry.hasFrontendExtension).length,
      managerReplacementCandidates: entries.filter(
        (entry) => entry.migrationDisposition === 'manager-v4-replaces-legacy'
      ).length,
      retireCandidates: entries.filter((entry) => entry.migrationDisposition === 'retire-candidate')
        .length
    }
  }
}

export function isManagerLoopback(address: string): boolean {
  const normalized = address
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  if (normalized === '::1') return true
  const parts = normalized.split('.')
  if (parts.length !== 4) return false
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  return Number(parts[0]) === 127
}

export function evaluateManagerV4Policy(input: FrManagerPolicyInput): FrManagerPolicyDecision {
  const local = isManagerLoopback(input.listenAddress)
  const personalCloud = input.networkMode === 'personal_cloud'
  const level = input.securityLevel
  let allowed = false

  switch (input.risk) {
    case 'block':
      return { allowed: false, reason: 'blocked-risk' }
    case 'high+':
      allowed = local ? level === 'normal-' || level === 'weak' : personalCloud && level === 'weak'
      break
    case 'high':
      allowed = local ? level === 'normal-' || level === 'weak' : level === 'weak'
      break
    case 'middle+':
      allowed =
        (local || personalCloud) && (level === 'normal' || level === 'normal-' || level === 'weak')
      break
    case 'middle':
      allowed = level === 'normal' || level === 'normal-' || level === 'weak'
      break
    case 'low':
      allowed = true
      break
  }

  if (allowed) return { allowed: true, reason: 'allowed' }
  const positionDenied =
    (input.risk === 'middle+' && !local && !personalCloud) ||
    (input.risk === 'high+' && !local && !personalCloud)
  const securityDenied = level === 'strong' || (input.risk.startsWith('high') && level === 'normal')
  return {
    allowed: false,
    reason:
      positionDenied && securityDenied
        ? 'network-and-security'
        : positionDenied
          ? 'network-position'
          : 'security-level'
  }
}

export function evaluateDedicatedInstallPolicy(input: FrDedicatedInstallPolicyInput): boolean {
  return (
    input.enabled &&
    (isManagerLoopback(input.listenAddress) || input.networkMode === 'personal_cloud')
  )
}
