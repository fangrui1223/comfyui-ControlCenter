import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.dirname(scriptRoot)

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function normalizeRelative(value) {
  return value.replaceAll('\\', '/')
}

function walk(root, current, files, skippedReparsePoints) {
  let entries
  try {
    entries = fs.readdirSync(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    const relative = normalizeRelative(path.relative(root, absolute))
    if (entry.isSymbolicLink()) {
      skippedReparsePoints.push(relative)
    } else if (entry.isDirectory()) {
      walk(root, absolute, files, skippedReparsePoints)
    } else if (entry.isFile()) {
      files.push(relative)
    }
  }
}

function coreMarker(coreRoot, marker) {
  const file = path.join(coreRoot, ...marker.relativePath.split('/'))
  let contents = ''
  let fileExists = false
  try {
    contents = fs.readFileSync(file, 'utf8')
    fileExists = true
  } catch {}
  const missingTokens = marker.allOfTokens.filter((token) => !contents.includes(token))
  return { ...marker, fileExists, missingTokens, passed: fileExists && missingTokens.length === 0 }
}

function profileState(profile, coreSupported, requirements, missingRequiredPluginIds) {
  if (profile.supportMode === 'watcher') return 'future-unverified'
  if (!coreSupported && profile.supportMode !== 'plugin-local') return 'core-missing'
  if (profile.supportMode === 'official-api') return 'api-only'
  if (profile.supportMode === 'plugin-local' && missingRequiredPluginIds.length > 0) {
    return 'plugin-required'
  }
  const required = requirements.filter((item) => item.required)
  if (required.length === 0 || required.every((item) => item.matchedFiles.length > 0))
    return 'ready'
  return required.some((item) => item.matchedFiles.length > 0) ? 'partial' : 'missing-models'
}

const catalogPath = argument(
  '--catalog',
  path.join(repositoryRoot, 'resources', 'fr-model-capabilities.v1.json')
)
const performanceCatalogPath = argument(
  '--performance-catalog',
  path.join(repositoryRoot, 'resources', 'fr-model-performance-profiles.v1.json')
)
const coreRoot = path.resolve(argument('--core', 'C:\\FR_comfyui_next\\ComfyUI'))
const modelRoot = path.resolve(argument('--models', 'C:\\FR_comfyui\\models'))
const output = path.resolve(
  argument('--output', 'C:\\FR_comfyui_cache\\catalogs\\model-capabilities.json')
)
const plugins = argument('--plugins', '')
  .split(',')
  .map((value) => value.trim().toLocaleLowerCase())
  .filter(Boolean)
const installedPlugins = new Set(plugins)

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const performanceCatalog = JSON.parse(fs.readFileSync(performanceCatalogPath, 'utf8'))
const files = []
const skippedReparsePoints = []
walk(modelRoot, modelRoot, files, skippedReparsePoints)
files.sort((left, right) => left.localeCompare(right))

const results = catalog.profiles.map((profile) => {
  const coreMarkers = profile.coreMarkers.map((marker) => coreMarker(coreRoot, marker))
  const coreSupported =
    profile.supportMode === 'plugin-local' ||
    profile.supportMode === 'watcher' ||
    coreMarkers.every((marker) => marker.passed)
  const requirements = profile.modelRequirements.map((requirement) => {
    const patterns = requirement.oneOfPatterns.map((source) => new RegExp(source, 'i'))
    return {
      id: requirement.id,
      label: requirement.label,
      required: requirement.required,
      matchedFiles: files.filter((file) => patterns.some((pattern) => pattern.test(file)))
    }
  })
  const requiredPluginIds = profile.requiredPluginIds ?? []
  const optionalPluginIds = profile.optionalPluginIds ?? []
  const missingRequiredPluginIds = requiredPluginIds.filter(
    (id) => !installedPlugins.has(id.toLocaleLowerCase())
  )
  const missingOptionalPluginIds = optionalPluginIds.filter(
    (id) => !installedPlugins.has(id.toLocaleLowerCase())
  )
  const performanceProfile =
    performanceCatalog.profiles.find((item) => item.profileId === profile.id) ?? null
  const performanceTiers = (performanceProfile?.tiers ?? []).map((tier) => {
    const patterns = tier.modelPatterns.map((source) => new RegExp(source, 'i'))
    const matchingFiles = files.filter((file) => patterns.some((pattern) => pattern.test(file)))
    return {
      ...tier,
      inventoryAvailable:
        tier.basis === 'api-managed' || (patterns.length > 0 && matchingFiles.length > 0),
      matchingFiles,
      benchmark: null,
      mainEnvironmentRecommended: false
    }
  })
  return {
    id: profile.id,
    label: profile.label,
    family: profile.family,
    supportMode: profile.supportMode,
    confidence: profile.confidence,
    state: profileState(profile, coreSupported, requirements, missingRequiredPluginIds),
    coreSupported,
    coreMarkers,
    requirements,
    missingRequiredRequirementIds: requirements
      .filter((item) => item.required && item.matchedFiles.length === 0)
      .map((item) => item.id),
    missingRequiredPluginIds,
    missingOptionalPluginIds,
    performancePresetIds: profile.performancePresetIds,
    vramGuidance: performanceProfile?.vramGuidance ?? null,
    performanceTiers,
    notes: profile.notes
  }
})

const report = {
  schemaVersion: catalog.schemaVersion,
  generatedAt: new Date().toISOString(),
  catalogCheckedAt: catalog.checkedAt,
  catalogPath,
  performanceCatalogPath,
  coreRoot,
  modelRoot,
  output,
  readOnlyModelScan: true,
  modelFileCount: files.length,
  skippedReparsePoints,
  recommendedPerformancePresetId: 'next-daily-performance',
  performancePresets: catalog.performancePresets,
  summary: Object.fromEntries(
    [...new Set(results.map((result) => result.state))].map((state) => [
      state,
      results.filter((result) => result.state === state).length
    ])
  ),
  results
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
if (!process.argv.includes('--quiet')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
