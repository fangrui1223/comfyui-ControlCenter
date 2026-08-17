import { extractFile, listPackage } from '@electron/asar'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = Object.freeze([
  'node_modules/@todesktop/runtime/package.json',
  'node_modules/electron-updater/package.json',
  'node_modules/fs-extra/package.json',
  'node_modules/graceful-fs/package.json',
  'node_modules/jsonfile/package.json',
  'node_modules/universalify/package.json',
])

export const PACKAGED_RUNTIME_ROOTS = Object.freeze(['@todesktop/runtime', 'electron-updater'])

function normalizeAsarEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '')
}

export function findMissingPackagedRuntimeEntries(
  entries,
  requiredEntries = REQUIRED_PACKAGED_RUNTIME_ENTRIES,
) {
  const packaged = new Set(entries.map(normalizeAsarEntry))
  return requiredEntries.filter((entry) => !packaged.has(normalizeAsarEntry(entry)))
}

function packageJsonEntry(packageName) {
  return `node_modules/${packageName}/package.json`
}

function resolvePackagedDependencyEntry(ownerEntry, dependencyName, packaged) {
  const nested = `${path.posix.dirname(ownerEntry)}/node_modules/${dependencyName}/package.json`
  const root = packageJsonEntry(dependencyName)
  if (packaged.has(nested)) return nested
  if (packaged.has(root)) return root
  return undefined
}

export function findMissingPackagedDependencyClosure({
  entries,
  readPackageJson,
  rootPackages = PACKAGED_RUNTIME_ROOTS,
}) {
  const packaged = new Set(entries.map(normalizeAsarEntry))
  const queue = []
  const missing = []
  const visited = new Set()

  for (const packageName of rootPackages) {
    const entry = packageJsonEntry(packageName)
    if (packaged.has(entry)) queue.push(entry)
    else missing.push(`root -> ${packageName}`)
  }

  while (queue.length > 0) {
    const entry = queue.shift()
    if (!entry || visited.has(entry)) continue
    visited.add(entry)

    const manifest = readPackageJson(entry)
    const owner = String(manifest.name ?? entry)
    for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
      const dependencyEntry = resolvePackagedDependencyEntry(entry, dependencyName, packaged)
      if (!dependencyEntry) {
        missing.push(`${owner} -> ${dependencyName}`)
        continue
      }
      if (!visited.has(dependencyEntry)) queue.push(dependencyEntry)
    }
  }

  return [...new Set(missing)].sort()
}

export function verifyPackagedRuntime(asarPath) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged runtime verification failed: app.asar not found at ${asarPath}`)
  }

  const entries = listPackage(asarPath)
  const missingEntries = findMissingPackagedRuntimeEntries(entries)
  const missingDependencies = findMissingPackagedDependencyClosure({
    entries,
    readPackageJson: (entry) =>
      JSON.parse(extractFile(asarPath, entry.replaceAll('/', '\\')).toString('utf8')),
  })
  const missing = [...missingEntries, ...missingDependencies]
  if (missing.length > 0) {
    throw new Error(
      `Packaged runtime verification failed: app.asar is missing ${missing.join(', ')}`,
    )
  }

  console.log(
    `Packaged runtime verification passed: updater dependency closure is present in ${asarPath}.`,
  )
}

function main() {
  const asarPath = path.resolve(
    process.argv[2] ?? 'dist/win-unpacked/resources/app.asar',
  )
  verifyPackagedRuntime(asarPath)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()
