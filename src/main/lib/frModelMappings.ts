import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type {
  FrCoreModelMappingPlan,
  FrModelDirectoryRecord,
  FrModelLibraryInventory,
  FrPluginModelLinkDeclaration,
  FrPluginModelLinkPlan
} from '../../shared/frModelMappings'
import { writeFileSafe } from './safe-file'

const OWNER_DIR = '.fr-control-center'
const MAPPING_DIR = 'model-mappings'

interface CoreCategoryDiscovery {
  categories: Set<string>
  aliases: Map<string, string>
}

interface ScanTotals {
  bytes: number
  files: number
  directories: number
  errors: Array<{ path: string; message: string }>
}

function canonical(input: string): string {
  const resolved = path.resolve(input)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function isWithin(candidate: string, parent: string): boolean {
  const childKey = canonical(candidate)
  const parentKey = canonical(parent)
  return childKey === parentKey || childKey.startsWith(parentKey + path.sep)
}

function isReparsePoint(stats: fs.Stats): boolean {
  return stats.isSymbolicLink() || (stats.mode & fs.constants.S_IFMT) === fs.constants.S_IFLNK
}

export function discoverCoreModelCategories(folderPathsSource: string): CoreCategoryDiscovery {
  const categories = new Set<string>()
  const aliases = new Map<string, string>()
  const assignment = /folder_names_and_paths\[\s*["']([^"']+)["']\s*\]\s*=/g
  for (const match of folderPathsSource.matchAll(assignment)) {
    if (match[1]) categories.add(match[1])
  }
  const legacyBlock = /legacy\s*=\s*\{([\s\S]*?)\}/m.exec(folderPathsSource)?.[1] ?? ''
  const aliasPair = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g
  for (const match of legacyBlock.matchAll(aliasPair)) {
    if (match[1] && match[2]) aliases.set(match[1], match[2])
  }
  return { categories, aliases }
}

function scanDirectory(root: string): ScanTotals {
  const totals: ScanTotals = { bytes: 0, files: 0, directories: 0, errors: [] }
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      totals.errors.push({
        path: current,
        message: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      try {
        if (entry.isSymbolicLink()) {
          totals.errors.push({ path: fullPath, message: 'Nested reparse point was not followed' })
        } else if (entry.isDirectory()) {
          totals.directories++
          pending.push(fullPath)
        } else if (entry.isFile()) {
          totals.files++
          totals.bytes += fs.statSync(fullPath).size
        }
      } catch (error) {
        totals.errors.push({
          path: fullPath,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
  return totals
}

export function scanSharedModelLibrary(input: {
  sharedRoot: string
  folderPathsFile: string
  coreSourceCommit: string
  scannedAt?: Date
}): FrModelLibraryInventory {
  const sharedRoot = path.resolve(input.sharedRoot)
  const source = fs.readFileSync(input.folderPathsFile, 'utf8')
  const { categories, aliases } = discoverCoreModelCategories(source)
  const topLevel = fs.readdirSync(sharedRoot, { withFileTypes: true })
  const seen = new Set<string>()
  const records: FrModelDirectoryRecord[] = []
  const errors: FrModelLibraryInventory['errors'] = []
  for (const entry of topLevel.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const key = entry.name.toLocaleLowerCase('en-US')
    const physicalPath = path.join(sharedRoot, entry.name)
    if (seen.has(key)) {
      records.push({
        name: entry.name,
        physicalPath,
        bytes: 0,
        files: 0,
        directories: 0,
        reparsePoint: false,
        disposition: 'blocked',
        logicalCategory: null,
        referencedBy: ['stable'],
        warning: 'Case-insensitive top-level collision'
      })
      continue
    }
    seen.add(key)
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(physicalPath)
    } catch (error) {
      errors.push({
        path: physicalPath,
        message: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    const reparsePoint = isReparsePoint(stats) || entry.isSymbolicLink()
    const isDirectory = stats.isDirectory()
    const logicalCategory = categories.has(entry.name)
      ? entry.name
      : (aliases.get(entry.name) ?? null)
    const totals =
      isDirectory && !reparsePoint
        ? scanDirectory(physicalPath)
        : { bytes: 0, files: 0, directories: 0, errors: [] }
    errors.push(...totals.errors)
    records.push({
      name: entry.name,
      physicalPath,
      bytes: totals.bytes,
      files: totals.files,
      directories: totals.directories,
      reparsePoint,
      disposition:
        !isDirectory || reparsePoint
          ? 'blocked'
          : logicalCategory
            ? 'core-extra-path'
            : 'plugin-verification-required',
      logicalCategory,
      referencedBy: ['stable'],
      ...(!isDirectory
        ? { warning: 'Top-level model entry is not a directory' }
        : reparsePoint
          ? { warning: 'Existing reparse point was not followed' }
          : {})
    })
  }
  return {
    schemaVersion: 1,
    scannedAt: (input.scannedAt ?? new Date()).toISOString(),
    sharedRoot,
    coreSourceCommit: input.coreSourceCommit,
    totalBytes: records.reduce((total, record) => total + record.bytes, 0),
    totalFiles: records.reduce((total, record) => total + record.files, 0),
    records,
    errors
  }
}

function planDigest(plan: Omit<FrCoreModelMappingPlan, 'digest'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

function transactionId(now = new Date()): string {
  return `models-${now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`
}

export function buildCoreModelMappingPlan(input: {
  inventory: FrModelLibraryInventory
  environmentRoot: string
  now?: Date
}): FrCoreModelMappingPlan {
  const now = input.now ?? new Date()
  const environmentRoot = path.resolve(input.environmentRoot)
  const mappingRoot = path.join(environmentRoot, OWNER_DIR, MAPPING_DIR)
  const categoryPaths: Record<string, string[]> = {}
  const excluded: FrCoreModelMappingPlan['excluded'] = []
  for (const record of input.inventory.records) {
    if (record.disposition !== 'core-extra-path' || !record.logicalCategory) {
      excluded.push({
        name: record.name,
        reason:
          record.disposition === 'plugin-verification-required'
            ? 'Requires an installed plugin declaration before a junction can be considered'
            : (record.warning ?? 'Blocked inventory entry')
      })
      continue
    }
    ;(categoryPaths[record.logicalCategory] ??= []).push(record.physicalPath)
  }
  for (const paths of Object.values(categoryPaths)) paths.sort((a, b) => a.localeCompare(b, 'en'))

  const collisions: FrCoreModelMappingPlan['collisions'] = []
  const configPath = path.join(mappingRoot, 'extra_model_paths.yaml')
  const manifestPath = path.join(mappingRoot, 'manifest.json')
  const undoManifestPath = path.join(mappingRoot, 'undo.json')
  for (const candidate of [configPath, manifestPath, undoManifestPath]) {
    if (fs.existsSync(candidate)) {
      collisions.push({ path: candidate, reason: 'Existing mapping transaction output' })
    }
  }
  const unsigned: Omit<FrCoreModelMappingPlan, 'digest'> = {
    schemaVersion: 1,
    transactionId: transactionId(now),
    createdAt: now.toISOString(),
    sharedRoot: input.inventory.sharedRoot,
    environmentRoot,
    configPath,
    manifestPath,
    undoManifestPath,
    coreSourceCommit: input.inventory.coreSourceCommit,
    categoryPaths,
    excluded,
    collisions,
    blocked: collisions.length > 0 || input.inventory.errors.length > 0
  }
  return { ...unsigned, digest: planDigest(unsigned) }
}

export function renderExtraModelPaths(plan: FrCoreModelMappingPlan): string {
  const config: Record<string, unknown> = { is_default: false }
  for (const [category, paths] of Object.entries(plan.categoryPaths)) {
    config[category] = paths.join('\n')
  }
  return YAML.stringify({ fr_shared_models: config }, { lineWidth: 0 })
}

export function executeCoreModelMappingPlan(plan: FrCoreModelMappingPlan): void {
  const { digest: _digest, ...unsigned } = plan
  if (planDigest(unsigned) !== plan.digest)
    throw new Error('Model mapping plan digest does not match')
  if (plan.blocked) throw new Error('Model mapping plan is blocked')
  for (const paths of Object.values(plan.categoryPaths)) {
    for (const source of paths) {
      if (!isWithin(source, plan.sharedRoot))
        throw new Error(`Model source escaped shared root: ${source}`)
      const stats = fs.lstatSync(source)
      if (!stats.isDirectory() || isReparsePoint(stats)) {
        throw new Error(`Model source changed after inventory: ${source}`)
      }
    }
  }
  const mappingRoot = path.dirname(plan.configPath)
  fs.mkdirSync(mappingRoot, { recursive: true })
  const created: string[] = []
  try {
    // Reserve every output with create-if-absent before publishing content.
    // A path appearing after dry-run can never be overwritten by the safe
    // rename writer below; a crash leaves an obvious blocked reservation.
    for (const file of [plan.configPath, plan.manifestPath, plan.undoManifestPath]) {
      fs.writeFileSync(file, `FR mapping transaction reservation: ${plan.transactionId}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      })
      created.push(file)
    }
    writeFileSafe(plan.configPath, renderExtraModelPaths(plan))
    writeFileSafe(plan.manifestPath, JSON.stringify(plan, null, 2) + '\n')
    const undo = {
      schemaVersion: 1,
      transactionId: plan.transactionId,
      createdFiles: [...created],
      createdJunctions: []
    }
    writeFileSafe(plan.undoManifestPath, JSON.stringify(undo, null, 2) + '\n')
  } catch (error) {
    for (const file of created.reverse()) {
      try {
        fs.unlinkSync(file)
      } catch {}
    }
    throw error
  }
}

function readJunctionTarget(target: string): string | null {
  try {
    const stats = fs.lstatSync(target)
    if (!stats.isSymbolicLink()) return null
    return path.resolve(path.dirname(target), fs.readlinkSync(target))
  } catch {
    return null
  }
}

export function planPluginModelLink(input: {
  declaration: FrPluginModelLinkDeclaration
  sharedRoot: string
  environmentRoot: string
}): FrPluginModelLinkPlan {
  const source = path.resolve(input.sharedRoot, input.declaration.sharedFolder)
  const modelsRoot = path.resolve(input.environmentRoot, 'ComfyUI', 'models')
  const target = path.resolve(modelsRoot, input.declaration.targetRelativePath)
  const base = { ...input.declaration, source, target }
  if (!isWithin(source, input.sharedRoot) || source === path.resolve(input.sharedRoot)) {
    return { ...base, status: 'blocked', reason: 'Shared source escaped the model library' }
  }
  if (!isWithin(target, modelsRoot) || target === modelsRoot) {
    return {
      ...base,
      status: 'blocked',
      reason: 'Plugin target escaped the environment model root'
    }
  }
  try {
    const sourceStats = fs.lstatSync(source)
    if (!sourceStats.isDirectory() || isReparsePoint(sourceStats)) {
      return { ...base, status: 'blocked', reason: 'Shared source is not a physical directory' }
    }
  } catch {
    return { ...base, status: 'blocked', reason: 'Shared source does not exist' }
  }
  if (fs.existsSync(target)) {
    const linked = readJunctionTarget(target)
    return linked && canonical(linked) === canonical(source)
      ? { ...base, status: 'already-mapped' }
      : { ...base, status: 'blocked', reason: 'Plugin target already exists or points elsewhere' }
  }
  return { ...base, status: 'ready' }
}

export function executePluginModelLink(plan: FrPluginModelLinkPlan): void {
  if (plan.status === 'already-mapped') return
  if (plan.status !== 'ready') throw new Error(plan.reason ?? 'Plugin model link is blocked')
  if (fs.existsSync(plan.target)) throw new Error('Plugin model target changed after dry-run')
  fs.mkdirSync(path.dirname(plan.target), { recursive: true })
  fs.symlinkSync(plan.source, plan.target, process.platform === 'win32' ? 'junction' : 'dir')
}

export const __testing = { canonical, isWithin, scanDirectory }
