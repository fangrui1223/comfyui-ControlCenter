export type FrCapabilityConfidence = 'verified-official' | 'upstream-declared' | 'experimental'
export type FrRuntimeChannel = 'stable' | 'preview' | 'experimental'
export type FrRuntimeEligibility = 'eligible' | 'needs-validation' | 'blocked'

export interface FrCapabilityEvidence {
  title: string
  url: string
  authority: 'official-project' | 'official-vendor' | 'upstream-repository'
  checkedAt: string
}

export interface FrPackagePin {
  name: string
  version: string
  source: string
  optional?: boolean
}

export interface FrRuntimeProfile {
  id: string
  catalogVersion: number
  channel: FrRuntimeChannel
  label: string
  confidence: FrCapabilityConfidence
  platform: 'win32'
  accelerator: 'nvidia'
  python: string
  packages: FrPackagePin[]
  minComputeCapability: number
  minDriver: string
  compiledCachePolicy: 'per-environment'
  installSource: {
    kind: 'comfy-standalone' | 'python-index'
    url: string
    releaseTag?: string
    expectedBytes?: number
  }
  evidence: FrCapabilityEvidence[]
  notes: string[]
}

export interface FrOptionalAcceleratorProfile {
  id: string
  label: string
  channel: FrRuntimeChannel
  confidence: FrCapabilityConfidence
  package: FrPackagePin
  torchConstraint: string
  pythonConstraint: string
  cudaConstraint: string
  computeCapabilities: string
  activation: 'automatic' | 'explicit-launch-flag' | 'per-workflow'
  compiledCachePolicy: 'per-environment'
  qualityGate: 'smoke' | 'numerical-comparison' | 'workflow-comparison'
  targetDisposition: 'recommended' | 'lab-only' | 'blocked-on-target'
  evidence: FrCapabilityEvidence[]
  notes: string[]
}

export interface FrGpuProbe {
  name: string
  driverVersion: string
  memoryMiB: number
  computeCapability: number
}

export interface FrRuntimeProbe {
  capturedAt: string
  platform: string
  arch: string
  longPathsEnabled: boolean | null
  gpu: FrGpuProbe | null
  packageVersions: Record<string, string | null>
}

export interface FrRuntimeEvaluation {
  profileId: string
  eligibility: FrRuntimeEligibility
  checks: Array<{
    id: string
    status: 'pass' | 'warning' | 'blocked'
    summary: string
  }>
}
