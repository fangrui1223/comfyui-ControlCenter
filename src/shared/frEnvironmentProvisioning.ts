import type { FrEnvironmentRole } from './frEnvironmentProfiles'

export const FR_LAYOUT_PLAN_VERSION = 1 as const

export type FrManagedEnvironmentRole = Exclude<FrEnvironmentRole, 'stable'>
export type FrLayoutTargetKind = FrManagedEnvironmentRole | 'cache'
export type FrPreflightStatus = 'pass' | 'warning' | 'blocked'

export interface FrPreflightCheck {
  id: string
  status: FrPreflightStatus
  summary: string
  detail?: string
}

export interface FrPathSnapshot {
  path: string
  state: 'missing' | 'empty-directory' | 'owned-directory' | 'occupied' | 'inaccessible'
  freeBytes: number | null
  ownerRole: FrLayoutTargetKind | null
  detail?: string
}

export interface FrLayoutAction {
  kind: 'create-directory' | 'write-owner-marker' | 'atomic-rename'
  target: string
  description: string
  reversible: true
}

export interface FrLayoutTargetPlan {
  kind: FrLayoutTargetKind
  root: string
  stagingRoot: string | null
  directories: string[]
  snapshot: FrPathSnapshot
  actions: FrLayoutAction[]
}

export interface FrLayoutPlan {
  version: typeof FR_LAYOUT_PLAN_VERSION
  transactionId: string
  createdAt: string
  expiresAt: string
  mode: 'dry-run'
  stableRoot: string
  sharedModelsRoot: string
  targets: FrLayoutTargetPlan[]
  checks: FrPreflightCheck[]
  blocked: boolean
  planDigest: string
}

export interface FrLayoutExecutionResult {
  transactionId: string
  status: 'committed' | 'rolled-back' | 'failed'
  startedAt: string
  finishedAt: string
  createdRoots: string[]
  journalPath: string
  error?: string
}
