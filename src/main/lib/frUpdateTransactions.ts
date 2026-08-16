import crypto from 'node:crypto'
import path from 'node:path'
import type {
  FrUpdateChannelPolicy,
  FrUpdateFacts,
  FrUpdatePlan,
  FrUpdateRequest
} from '../../shared/frUpdateTransactions'
import { FR_UPDATE_POLICY_VERSION } from '../../shared/frUpdateTransactions'

export const FR_UPDATE_CHANNEL_POLICIES: readonly FrUpdateChannelPolicy[] = [
  {
    role: 'stable',
    allowedChannels: [],
    mutable: false,
    purpose: 'Existing user installation; observe only.'
  },
  {
    role: 'next',
    allowedChannels: ['stable'],
    mutable: true,
    purpose: 'Daily production environment; verified stable releases only.'
  },
  {
    role: 'lab',
    allowedChannels: ['stable', 'preview', 'experimental'],
    mutable: true,
    purpose: 'Disposable major-version and accelerator experiments.'
  }
]

const GATES: Record<FrUpdateRequest['component'], string[]> = {
  core: ['git-clean', 'core-quick-test', 'manager-v4-startup', 'runtime-smoke'],
  frontend: ['package-lock-capture', 'frontend-load', 'core-api-compatibility'],
  manager: ['manager-config-backup', 'manager-v4-api-probe', 'plugin-catalog-refresh'],
  runtime: ['whole-runtime-stage', 'hardware-probe', 'numerical-probe', 'core-quick-test'],
  plugin: ['plugin-snapshot', 'python-import', 'startup-import', 'representative-workflow'],
  'model-mapping': ['mapping-dry-run', 'collision-check', 'core-quick-test', 'zero-model-write']
}

const ROLLBACK: Record<FrUpdateRequest['component'], string> = {
  core: 'restore pinned Core commit from the offline git bundle',
  frontend: 'restore the frozen frontend package set and lock snapshot',
  manager: 'restore the Manager wheel set, config and Manager state snapshot',
  runtime: 'atomically rename the previous whole runtime back into place',
  plugin: 'restore the plugin snapshot and previous environment dependency lock',
  'model-mapping': 'restore or remove the mapping config using its undo manifest'
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function policyFor(role: FrUpdateRequest['environmentRole']): FrUpdateChannelPolicy {
  return FR_UPDATE_CHANNEL_POLICIES.find((policy) => policy.role === role)!
}

export function buildFrUpdatePlan(
  request: FrUpdateRequest,
  facts: FrUpdateFacts,
  transactionId: string
): FrUpdatePlan {
  const checks: FrUpdatePlan['checks'] = []
  const policy = policyFor(request.environmentRole)
  checks.push({
    id: 'environment-ownership',
    status: policy.mutable && facts.environmentOwned ? 'pass' : 'blocked',
    summary:
      policy.mutable && facts.environmentOwned ? 'Environment is FR-managed.' : policy.purpose
  })
  checks.push({
    id: 'channel-policy',
    status: policy.allowedChannels.includes(request.channel) ? 'pass' : 'blocked',
    summary: policy.allowedChannels.includes(request.channel)
      ? `${request.channel} is allowed for ${request.environmentRole}.`
      : `${request.channel} is not allowed for ${request.environmentRole}.`
  })
  checks.push({
    id: 'process-stopped',
    status: facts.processStopped ? 'pass' : 'blocked',
    summary: facts.processStopped ? 'Environment is stopped.' : 'Environment must be stopped.'
  })
  checks.push({
    id: 'restore-point',
    status: facts.restorePointAvailable ? 'pass' : 'blocked',
    summary: facts.restorePointAvailable
      ? 'Committed restore point is available.'
      : 'A restore point must be committed first.'
  })
  checks.push({
    id: 'target-provenance',
    status: facts.targetResolved && request.targetProvenance.length > 0 ? 'pass' : 'blocked',
    summary:
      facts.targetResolved && request.targetProvenance.length > 0
        ? 'Target version and provenance are resolved.'
        : 'Target version or provenance is unresolved.'
  })
  if (request.component === 'core') {
    checks.push({
      id: 'working-tree',
      status: facts.workingTreeClean ? 'pass' : 'blocked',
      summary: facts.workingTreeClean
        ? 'Core working tree is clean.'
        : 'Core update refuses a dirty or unreadable working tree.'
    })
  }
  if (request.component === 'runtime') {
    checks.push({
      id: 'staged-runtime',
      status: facts.artifactStaged ? 'pass' : 'blocked',
      summary: facts.artifactStaged
        ? 'Candidate runtime is staged outside the live environment.'
        : 'Runtime updates require a staged candidate.'
    })
    checks.push({
      id: 'capability-probe',
      status: facts.capabilityProbePassed ? 'pass' : 'blocked',
      summary: facts.capabilityProbePassed
        ? 'Candidate passed the target hardware probe.'
        : 'Candidate has not passed the target hardware probe.'
    })
  }

  const base = {
    version: FR_UPDATE_POLICY_VERSION,
    ...request,
    transactionId,
    mode: 'dry-run' as const,
    blocked: checks.some((check) => check.status === 'blocked'),
    checks,
    requiredGates: [...GATES[request.component]],
    rollbackStrategy: ROLLBACK[request.component]
  }
  const planDigest = crypto.createHash('sha256').update(stableJson(base)).digest('hex')
  return { ...base, planDigest }
}

export function isPathInsideInstall(installRoot: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(installRoot), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
