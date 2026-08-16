export type FrModelCapabilityConfidence =
  | 'verified-official'
  | 'upstream-declared'
  | 'experimental'
  | 'future-unverified'

export type FrModelSupportMode =
  | 'native-local'
  | 'native-local-with-optional-preprocessor'
  | 'plugin-local'
  | 'official-api'
  | 'watcher'

export type FrModelCapabilityState =
  | 'ready'
  | 'partial'
  | 'missing-models'
  | 'core-missing'
  | 'plugin-required'
  | 'api-only'
  | 'future-unverified'

export interface FrModelCapabilityEvidence {
  title: string
  url: string
  authority: 'official-project' | 'official-vendor' | 'upstream-repository'
  checkedAt: string
}

export interface FrCoreSourceMarker {
  relativePath: string
  allOfTokens: string[]
}

export interface FrModelFileRequirement {
  id: string
  label: string
  required: boolean
  oneOfPatterns: string[]
}

export interface FrModelCapabilityProfile {
  id: string
  label: string
  family: string
  supportMode: FrModelSupportMode
  confidence: FrModelCapabilityConfidence
  coreMarkers: FrCoreSourceMarker[]
  modelRequirements: FrModelFileRequirement[]
  requiredPluginIds?: string[]
  optionalPluginIds?: string[]
  performancePresetIds: string[]
  evidence: FrModelCapabilityEvidence[]
  notes: string[]
}

export interface FrPerformancePreset {
  id: string
  label: string
  environment: 'next' | 'lab'
  launchArguments: string[]
  dynamicVram: 'automatic' | 'disabled'
  attentionBackend: 'pytorch-sdpa' | 'sageattention'
  tritonBackend: 'enabled' | 'disabled'
  qualityGate: 'runtime-smoke' | 'same-seed-comparison' | 'workflow-comparison'
  notes: string[]
}

export interface FrModelCapabilityCatalog {
  schemaVersion: number
  checkedAt: string
  performancePresets: FrPerformancePreset[]
  profiles: FrModelCapabilityProfile[]
}

export type FrModelPerformanceTierId = 'quality' | 'balanced' | 'speed'

export interface FrModelVramGuidance {
  minimumVramMiB: number | null
  recommendedVramMiB: number | null
  observedPeakVramMiB?: number
  confidence: 'official-observation' | 'target-validation-required' | 'future-unverified'
  sourceUrl?: string
  notes: string[]
}

export interface FrModelPerformanceTier {
  id: FrModelPerformanceTierId
  label: string
  precision: string
  modelPatterns: string[]
  steps: number | null
  attentionPresetId: string | null
  offloadPolicy: 'dynamic-vram' | 'disabled' | 'api-managed' | 'unverified'
  basis: 'official-option' | 'experimental-option' | 'api-managed' | 'future-unverified'
  notes: string[]
}

export interface FrModelPerformanceProfile {
  profileId: string
  vramGuidance: FrModelVramGuidance
  tiers: FrModelPerformanceTier[]
}

export interface FrModelPerformanceCatalog {
  schemaVersion: number
  checkedAt: string
  targetHardware: {
    gpu: string
    vramMiB: number
  }
  profiles: FrModelPerformanceProfile[]
}

export interface FrWorkflowBenchmarkRecord {
  schemaVersion: 1
  profileId: string
  tierId: FrModelPerformanceTierId
  runtimeProfileId: string
  coreCommit: string
  gpu: string
  workflowId: string
  capturedAt: string
  coldStartMs: number
  warmStartMs: number
  firstOutputMs: number
  totalMs: number
  peakVramMiB: number
  peakRamMiB: number
  compiledCacheHit: boolean
  outputComparison: 'pass' | 'warning' | 'fail' | 'not-applicable'
  passed: boolean
}

export interface FrModelPerformanceTierResult extends FrModelPerformanceTier {
  inventoryAvailable: boolean
  matchingFiles: string[]
  benchmark: FrWorkflowBenchmarkRecord | null
  mainEnvironmentRecommended: boolean
}

export interface FrModelRequirementResult {
  id: string
  label: string
  required: boolean
  matchedFiles: string[]
}

export interface FrCoreMarkerResult extends FrCoreSourceMarker {
  fileExists: boolean
  missingTokens: string[]
  passed: boolean
}

export interface FrModelCapabilityResult {
  id: string
  label: string
  family: string
  supportMode: FrModelSupportMode
  confidence: FrModelCapabilityConfidence
  state: FrModelCapabilityState
  coreSupported: boolean
  coreMarkers: FrCoreMarkerResult[]
  requirements: FrModelRequirementResult[]
  missingRequiredRequirementIds: string[]
  installedRequiredPluginIds: string[]
  missingRequiredPluginIds: string[]
  missingOptionalPluginIds: string[]
  performancePresetIds: string[]
  vramGuidance: FrModelVramGuidance | null
  performanceTiers: FrModelPerformanceTierResult[]
  notes: string[]
}

export interface FrModelLibraryIndex {
  root: string
  files: string[]
  skippedReparsePoints: string[]
}

export interface FrModelCapabilityReport {
  schemaVersion: number
  generatedAt: string
  catalogCheckedAt: string
  coreRoot: string
  modelRoot: string
  modelFileCount: number
  skippedReparsePoints: string[]
  recommendedPerformancePresetId: string
  results: FrModelCapabilityResult[]
}
