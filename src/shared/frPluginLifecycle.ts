export const FR_PLUGIN_CATALOG_VERSION = 1 as const

export type FrPluginLifecycleState =
  | 'active'
  | 'frozen'
  | 'held-back'
  | 'quarantined'
  | 'replaced'
  | 'retired'

export type FrPluginMigrationDisposition =
  | 'clean-install-required'
  | 'manager-v4-replaces-legacy'
  | 'review-required'
  | 'retire-candidate'

export type FrManagerRiskLevel = 'block' | 'high+' | 'high' | 'middle+' | 'middle' | 'low'
export type FrManagerSecurityLevel = 'strong' | 'normal' | 'normal-' | 'weak'
export type FrManagerNetworkMode = 'public' | 'private' | 'offline' | 'personal_cloud'

export interface FrManagerPolicyInput {
  risk: FrManagerRiskLevel
  securityLevel: FrManagerSecurityLevel
  networkMode: FrManagerNetworkMode
  listenAddress: string
}

export interface FrManagerPolicyDecision {
  allowed: boolean
  reason:
    | 'allowed'
    | 'blocked-risk'
    | 'security-level'
    | 'network-position'
    | 'network-and-security'
}

export interface FrDedicatedInstallPolicyInput {
  enabled: boolean
  networkMode: FrManagerNetworkMode
  listenAddress: string
}

export interface FrPluginCatalogEntry {
  id: string
  directoryName: string
  sourceRoot: string
  enabled: boolean
  sourceType: 'cnr' | 'git' | 'unmanaged' | 'file'
  repository: string | null
  commit: string | null
  version: string | null
  lastWriteAt: string | null
  requirements: string[]
  hasCompiledDependencies: boolean
  hasFrontendExtension: boolean
  lifecycle: FrPluginLifecycleState
  migrationDisposition: FrPluginMigrationDisposition
  reasons: string[]
}

export interface FrPluginCatalog {
  version: typeof FR_PLUGIN_CATALOG_VERSION
  generatedAt: string
  sourceInstall: string
  targetInstall: string
  strategy: 'clean-room-selective-reinstall'
  entries: FrPluginCatalogEntry[]
  summary: {
    total: number
    heldBack: number
    compiledDependencyCandidates: number
    frontendExtensionCandidates: number
    managerReplacementCandidates: number
    retireCandidates: number
  }
}
