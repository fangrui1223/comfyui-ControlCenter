import { describe, expect, it } from 'vitest'
import {
  findMissingPackagedDependencyClosure,
  findMissingPackagedRuntimeEntries,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES
} from '../../../scripts/fr-verify-packaged-runtime.mjs'

describe('packaged runtime dependency gate', () => {
  it('accepts the updater dependency closure with either ASAR path separator', () => {
    const entries = REQUIRED_PACKAGED_RUNTIME_ENTRIES.map((entry, index) =>
      index % 2 === 0 ? `\\${entry.replaceAll('/', '\\')}` : `/${entry}`
    )

    expect(findMissingPackagedRuntimeEntries(entries)).toEqual([])
  })

  it('reports fs-extra and its transitive dependencies when packaging drops them', () => {
    const entries = [
      '\\node_modules\\@todesktop\\runtime\\package.json',
      '\\node_modules\\electron-updater\\package.json'
    ]

    expect(findMissingPackagedRuntimeEntries(entries)).toEqual([
      'node_modules/fs-extra/package.json',
      'node_modules/graceful-fs/package.json',
      'node_modules/jsonfile/package.json',
      'node_modules/universalify/package.json'
    ])
  })

  it('walks the packaged production dependency closure recursively', () => {
    const manifests: Record<string, { name: string; dependencies?: Record<string, string> }> = {
      'node_modules/electron-updater/package.json': {
        name: 'electron-updater',
        dependencies: { 'fs-extra': '^10.1.0', 'builder-util-runtime': '9.5.1' }
      },
      'node_modules/fs-extra/package.json': {
        name: 'fs-extra',
        dependencies: { universalify: '^2.0.0' }
      },
      'node_modules/universalify/package.json': { name: 'universalify' }
    }

    expect(
      findMissingPackagedDependencyClosure({
        entries: Object.keys(manifests),
        readPackageJson: (entry) => manifests[entry]!,
        rootPackages: ['electron-updater']
      })
    ).toEqual(['electron-updater -> builder-util-runtime'])
  })
})
