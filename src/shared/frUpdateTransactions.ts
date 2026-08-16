import type { FrEnvironmentRole } from './frEnvironmentProfiles'

export const FR_UPDATE_POLICY_VERSION = 1 as const

export type FrUpdateComponent =
  | 'core'
  | 'frontend'
  | 'manager'
  | 'runtime'
  | 'plugin'
  | 'model-mapping'

export type FrUpdateChannel = 'stable' | 'preview' | 'experimental'

export interface FrUpdateEvidence {
  id: string
  status: 'pass' | 'warning' | 'blocked'
  summary: string
}

export interface FrUpdateRequest {
  environmentRole: FrEnvironmentRole
  installRoot: string
  component: FrUpdateComponent
  channel: FrUpdateChannel
  currentVersion: string | null
  targetVersion: string
  targetProvenance: string
  requestedAt: string
}

export interface FrUpdateFacts {
  environmentOwned: boolean
  processStopped: boolean
  workingTreeClean: boolean | null
  restorePointAvailable: boolean
  artifactStaged: boolean
  capabilityProbePassed: boolean | null
  targetResolved: boolean
}

export interface FrUpdatePlan extends FrUpdateRequest {
  version: typeof FR_UPDATE_POLICY_VERSION
  transactionId: string
  mode: 'dry-run'
  blocked: boolean
  checks: FrUpdateEvidence[]
  requiredGates: string[]
  rollbackStrategy: string
  planDigest: string
}

export interface FrUpdateChannelPolicy {
  role: FrEnvironmentRole
  allowedChannels: FrUpdateChannel[]
  mutable: boolean
  purpose: string
}
