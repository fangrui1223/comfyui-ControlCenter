import fs from 'node:fs'
import path from 'node:path'
import rawCatalog from '../../../resources/fr-model-capabilities.v1.json'
import rawPerformanceCatalog from '../../../resources/fr-model-performance-profiles.v1.json'
import type {
  FrCoreMarkerResult,
  FrModelCapabilityCatalog,
  FrModelCapabilityProfile,
  FrModelCapabilityReport,
  FrModelCapabilityResult,
  FrModelCapabilityState,
  FrModelFileRequirement,
  FrModelLibraryIndex,
  FrModelPerformanceCatalog,
  FrModelPerformanceProfile,
  FrModelPerformanceTierResult,
  FrModelRequirementResult,
  FrWorkflowBenchmarkRecord
} from '../../shared/frModelCapabilities'

export const FR_MODEL_CAPABILITY_CATALOG = rawCatalog as FrModelCapabilityCatalog
export const FR_MODEL_PERFORMANCE_CATALOG = rawPerformanceCatalog as FrModelPerformanceCatalog

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function walkModelLibrary(
  root: string,
  current: string,
  files: string[],
  skippedReparsePoints: string[]
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(current, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    const relative = normalizeRelativePath(path.relative(root, absolute))
    if (entry.isSymbolicLink()) {
      skippedReparsePoints.push(relative)
      continue
    }
    if (entry.isDirectory()) {
      walkModelLibrary(root, absolute, files, skippedReparsePoints)
      continue
    }
    if (entry.isFile()) files.push(relative)
  }
}

export function indexModelLibrary(modelRoot: string): FrModelLibraryIndex {
  const root = path.resolve(modelRoot)
  const files: string[] = []
  const skippedReparsePoints: string[] = []
  walkModelLibrary(root, root, files, skippedReparsePoints)
  files.sort((left, right) => left.localeCompare(right))
  skippedReparsePoints.sort((left, right) => left.localeCompare(right))
  return { root, files, skippedReparsePoints }
}

function matchesRequirement(
  requirement: FrModelFileRequirement,
  files: readonly string[]
): FrModelRequirementResult {
  const patterns = requirement.oneOfPatterns.map((source) => new RegExp(source, 'i'))
  return {
    id: requirement.id,
    label: requirement.label,
    required: requirement.required,
    matchedFiles: files.filter((file) => patterns.some((pattern) => pattern.test(file)))
  }
}

export function probeCoreMarkers(
  coreRoot: string,
  profile: FrModelCapabilityProfile
): FrCoreMarkerResult[] {
  return profile.coreMarkers.map((marker) => {
    const file = path.join(coreRoot, ...normalizeRelativePath(marker.relativePath).split('/'))
    let contents = ''
    let fileExists = false
    try {
      contents = fs.readFileSync(file, 'utf8')
      fileExists = true
    } catch {}
    const missingTokens = marker.allOfTokens.filter((token) => !contents.includes(token))
    return {
      ...marker,
      fileExists,
      missingTokens,
      passed: fileExists && missingTokens.length === 0
    }
  })
}

function determineState(
  profile: FrModelCapabilityProfile,
  coreSupported: boolean,
  requirements: readonly FrModelRequirementResult[],
  missingRequiredPluginIds: readonly string[]
): FrModelCapabilityState {
  if (profile.supportMode === 'watcher') return 'future-unverified'
  if (!coreSupported && profile.supportMode !== 'plugin-local') return 'core-missing'
  if (profile.supportMode === 'official-api') return 'api-only'
  if (profile.supportMode === 'plugin-local' && missingRequiredPluginIds.length > 0) {
    return 'plugin-required'
  }

  const required = requirements.filter((requirement) => requirement.required)
  if (
    required.length === 0 ||
    required.every((requirement) => requirement.matchedFiles.length > 0)
  ) {
    return 'ready'
  }
  if (required.some((requirement) => requirement.matchedFiles.length > 0)) return 'partial'
  return 'missing-models'
}

function evaluatePerformanceTiers(
  performanceProfile: FrModelPerformanceProfile | null,
  modelFiles: readonly string[],
  benchmarkRecords: readonly FrWorkflowBenchmarkRecord[]
): FrModelPerformanceTierResult[] {
  if (!performanceProfile) return []
  return performanceProfile.tiers.map((tier) => {
    const patterns = tier.modelPatterns.map((source) => new RegExp(source, 'i'))
    const matchingFiles = modelFiles.filter((file) =>
      patterns.some((pattern) => pattern.test(file))
    )
    const inventoryAvailable =
      tier.basis === 'api-managed' || (patterns.length > 0 && matchingFiles.length > 0)
    const benchmark =
      benchmarkRecords
        .filter(
          (record) => record.profileId === performanceProfile.profileId && record.tierId === tier.id
        )
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? null
    return {
      ...tier,
      inventoryAvailable,
      matchingFiles,
      benchmark,
      mainEnvironmentRecommended:
        inventoryAvailable === true &&
        benchmark?.passed === true &&
        benchmark.outputComparison !== 'fail'
    }
  })
}

export function evaluateModelCapability(
  profile: FrModelCapabilityProfile,
  coreRoot: string,
  modelFiles: readonly string[],
  installedPluginIds: readonly string[] = [],
  benchmarkRecords: readonly FrWorkflowBenchmarkRecord[] = []
): FrModelCapabilityResult {
  const coreMarkers = probeCoreMarkers(coreRoot, profile)
  const coreSupported =
    profile.supportMode === 'plugin-local' ||
    profile.supportMode === 'watcher' ||
    coreMarkers.every((marker) => marker.passed)
  const requirements = profile.modelRequirements.map((requirement) =>
    matchesRequirement(requirement, modelFiles)
  )
  const normalizedPlugins = new Set(installedPluginIds.map((id) => id.toLocaleLowerCase()))
  const requiredPluginIds = profile.requiredPluginIds ?? []
  const optionalPluginIds = profile.optionalPluginIds ?? []
  const installedRequiredPluginIds = requiredPluginIds.filter((id) =>
    normalizedPlugins.has(id.toLocaleLowerCase())
  )
  const missingRequiredPluginIds = requiredPluginIds.filter(
    (id) => !normalizedPlugins.has(id.toLocaleLowerCase())
  )
  const missingOptionalPluginIds = optionalPluginIds.filter(
    (id) => !normalizedPlugins.has(id.toLocaleLowerCase())
  )
  const performanceProfile =
    FR_MODEL_PERFORMANCE_CATALOG.profiles.find((item) => item.profileId === profile.id) ?? null
  const state = determineState(profile, coreSupported, requirements, missingRequiredPluginIds)
  const performanceTiers = evaluatePerformanceTiers(
    performanceProfile,
    modelFiles,
    benchmarkRecords
  ).map((tier) => ({
    ...tier,
    mainEnvironmentRecommended:
      state === 'ready' && profile.supportMode !== 'official-api'
        ? tier.mainEnvironmentRecommended
        : false
  }))

  return {
    id: profile.id,
    label: profile.label,
    family: profile.family,
    supportMode: profile.supportMode,
    confidence: profile.confidence,
    state,
    coreSupported,
    coreMarkers,
    requirements,
    missingRequiredRequirementIds: requirements
      .filter((requirement) => requirement.required && requirement.matchedFiles.length === 0)
      .map((requirement) => requirement.id),
    installedRequiredPluginIds,
    missingRequiredPluginIds,
    missingOptionalPluginIds,
    performancePresetIds: profile.performancePresetIds,
    vramGuidance: performanceProfile?.vramGuidance ?? null,
    performanceTiers,
    notes: profile.notes
  }
}

export function buildModelCapabilityReport(
  coreRoot: string,
  modelRoot: string,
  installedPluginIds: readonly string[] = [],
  generatedAt = new Date().toISOString(),
  benchmarkRecords: readonly FrWorkflowBenchmarkRecord[] = []
): FrModelCapabilityReport {
  const index = indexModelLibrary(modelRoot)
  return {
    schemaVersion: FR_MODEL_CAPABILITY_CATALOG.schemaVersion,
    generatedAt,
    catalogCheckedAt: FR_MODEL_CAPABILITY_CATALOG.checkedAt,
    coreRoot: path.resolve(coreRoot),
    modelRoot: index.root,
    modelFileCount: index.files.length,
    skippedReparsePoints: index.skippedReparsePoints,
    recommendedPerformancePresetId: 'next-daily-performance',
    results: FR_MODEL_CAPABILITY_CATALOG.profiles.map((profile) =>
      evaluateModelCapability(profile, coreRoot, index.files, installedPluginIds, benchmarkRecords)
    )
  }
}
