export type FrReleaseReadinessStatus =
  | 'public-release-ready'
  | 'internal-unsigned-candidate'
  | 'blocked'

export interface FrReleaseReadinessInput {
  version: string
  productName: string
  appId: string
  artifactName: string
  sourceLicenseMode: 'agpl' | 'commercial'
  licenseReviewApproved: boolean
  thirdPartyNoticesGenerated: boolean
  signingCertificateConfigured: boolean
  publisherNameConfigured: boolean
  updateProviderConfigured: boolean
  userOriginConfigured: boolean
  upstreamPushProtected: boolean
  unitTestsPassed: boolean
  integrationTestsPassed: boolean
  windowsE2ePassed: boolean
  productionBuildPassed: boolean
  installerBuilt: boolean
  installerSha256: string | null
  recoveryManualPresent: boolean
}

export interface FrReleaseReadinessCheck {
  id: string
  scope: 'internal' | 'public'
  status: 'pass' | 'blocked'
  summary: string
}

export interface FrReleaseReadinessReport {
  schemaVersion: 1
  evaluatedAt: string
  version: string
  status: FrReleaseReadinessStatus
  checks: FrReleaseReadinessCheck[]
  publicBlockers: string[]
}

export type FrMigrationMode = 'track-read-only' | 'copy-to-next'

export interface FrMigrationSafetyInput {
  mode: FrMigrationMode
  sourceRoot: string
  targetRoot: string
  sharedModelsRoot: string
  sourceExists: boolean
  sourceRunning: boolean
  targetState: 'missing' | 'fr-owned' | 'occupied'
  targetRestorePointAvailable: boolean
}

export interface FrMigrationSafetyPlan {
  schemaVersion: 1
  mode: FrMigrationMode
  blocked: boolean
  checks: FrReleaseReadinessCheck[]
  actions: string[]
  invariants: string[]
}

export type FrDataRemovalMode = 'keep-environments' | 'remove-fr-managed-data'

export interface FrDataRemovalInput {
  mode: FrDataRemovalMode
  stableRoot: string
  sharedModelsRoot: string
  nextRoot: string
  labRoot: string
  cacheRoot: string
  ownership: {
    next: boolean
    lab: boolean
    cache: boolean
  }
}

export interface FrDataRemovalPlan {
  schemaVersion: 1
  mode: FrDataRemovalMode
  blocked: boolean
  protectedPaths: string[]
  removablePaths: string[]
  checks: FrReleaseReadinessCheck[]
}
