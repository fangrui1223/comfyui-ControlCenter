import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FrUpdateFacts, FrUpdateRequest } from '../../shared/frUpdateTransactions'
import { buildFrLayoutPlan, type FrLayoutRoots } from './frEnvironmentProvisioning'
import { buildModelCapabilityReport } from './frModelCapabilities'
import {
  buildCoreModelMappingPlan,
  executeCoreModelMappingPlan,
  scanSharedModelLibrary
} from './frModelMappings'
import { evaluateManagerV4Policy, scanLegacyPluginCatalog } from './frPluginLifecycle'
import { buildFrDataRemovalPlan, buildFrMigrationSafetyPlan } from './frReleaseSafety'
import { buildFrUpdatePlan } from './frUpdateTransactions'

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

describe('FR synthetic lifecycle', () => {
  let root = ''
  let roots: FrLayoutRoots
  let stableSentinel = ''
  let stableDigest = ''
  let folderPathsFile = ''

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-lifecycle-'))
    roots = {
      stableRoot: path.join(root, 'stable'),
      sharedModelsRoot: path.join(root, 'stable', 'models'),
      nextRoot: path.join(root, 'next'),
      labRoot: path.join(root, 'lab'),
      cacheRoot: path.join(root, 'cache')
    }
    stableSentinel = path.join(roots.stableRoot, 'stable-user-data.txt')
    fs.mkdirSync(roots.sharedModelsRoot, { recursive: true })
    fs.writeFileSync(stableSentinel, 'must remain byte-for-byte unchanged')
    stableDigest = digest(stableSentinel)

    for (const category of ['diffusion_models', 'text_encoders', 'vae', 'plugin-private']) {
      fs.mkdirSync(path.join(roots.sharedModelsRoot, category), { recursive: true })
    }
    fs.writeFileSync(
      path.join(roots.sharedModelsRoot, 'diffusion_models', 'krea2_turbo_fp8.safetensors'),
      'synthetic-not-a-model'
    )
    fs.writeFileSync(
      path.join(roots.sharedModelsRoot, 'text_encoders', 'qwen3vl_4b_fp8_scaled.safetensors'),
      'synthetic-not-a-model'
    )
    fs.writeFileSync(
      path.join(roots.sharedModelsRoot, 'vae', 'qwen_image_vae.safetensors'),
      'synthetic-not-a-model'
    )
    folderPathsFile = path.join(root, 'folder_paths.py')
    fs.writeFileSync(
      folderPathsFile,
      [
        'folder_names_and_paths["diffusion_models"] = (["models/diffusion_models"], set())',
        'folder_names_and_paths["text_encoders"] = (["models/text_encoders"], set())',
        'folder_names_and_paths["vae"] = (["models/vae"], set())',
        'legacy = {"clip": "text_encoders", "unet": "diffusion_models"}'
      ].join('\n')
    )
  })

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('preflights isolated next, lab and cache roots without touching stable', () => {
    const plan = buildFrLayoutPlan(roots, new Date('2026-08-16T00:00:00.000Z'))
    expect(plan.blocked).toBe(false)
    expect(plan.targets.map((target) => target.kind)).toEqual(['next', 'lab', 'cache'])
    expect(plan.targets.every((target) => target.snapshot.state === 'missing')).toBe(true)
    expect(digest(stableSentinel)).toBe(stableDigest)
    expect(fs.existsSync(roots.nextRoot)).toBe(false)
  })

  it('commits only mapping metadata and preserves every synthetic model byte', () => {
    fs.mkdirSync(roots.nextRoot, { recursive: true })
    const modelDigestsBefore = Object.fromEntries(
      fs
        .readdirSync(path.join(roots.sharedModelsRoot, 'diffusion_models'))
        .map((name) => [name, digest(path.join(roots.sharedModelsRoot, 'diffusion_models', name))])
    )
    const inventory = scanSharedModelLibrary({
      sharedRoot: roots.sharedModelsRoot,
      folderPathsFile,
      coreSourceCommit: 'synthetic-core'
    })
    const plan = buildCoreModelMappingPlan({ inventory, environmentRoot: roots.nextRoot })
    expect(plan.blocked).toBe(false)
    expect(plan.excluded.map((item) => item.name)).toContain('plugin-private')
    executeCoreModelMappingPlan(plan)

    expect(fs.existsSync(plan.configPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(plan.undoManifestPath, 'utf8')).createdJunctions).toEqual([])
    const modelDigestsAfter = Object.fromEntries(
      fs
        .readdirSync(path.join(roots.sharedModelsRoot, 'diffusion_models'))
        .map((name) => [name, digest(path.join(roots.sharedModelsRoot, 'diffusion_models', name))])
    )
    expect(modelDigestsAfter).toEqual(modelDigestsBefore)
    expect(digest(stableSentinel)).toBe(stableDigest)
  })

  it('holds legacy plugins back and mirrors Manager v4 remote security', () => {
    const plugin = path.join(roots.stableRoot, 'custom_nodes', 'Old-TensorRT-Node')
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(path.join(plugin, 'requirements.txt'), 'tensorrt\n')
    const catalog = scanLegacyPluginCatalog(
      roots.stableRoot,
      roots.nextRoot,
      '2026-08-16T00:00:00.000Z'
    )
    expect(catalog).toMatchObject({
      strategy: 'clean-room-selective-reinstall',
      summary: { total: 1, compiledDependencyCandidates: 1 }
    })
    expect(catalog.entries[0]).toMatchObject({
      lifecycle: 'held-back',
      migrationDisposition: 'clean-install-required'
    })
    expect(
      evaluateManagerV4Policy({
        risk: 'middle+',
        securityLevel: 'weak',
        networkMode: 'public',
        listenAddress: '0.0.0.0'
      })
    ).toEqual({ allowed: false, reason: 'network-position' })
    expect(
      fs.existsSync(path.join(roots.nextRoot, 'ComfyUI', 'custom_nodes', 'Old-TensorRT-Node'))
    ).toBe(false)
  })

  it('blocks unsafe updates and produces explicit rollback gates', () => {
    const request: FrUpdateRequest = {
      environmentRole: 'next',
      installRoot: roots.nextRoot,
      component: 'runtime',
      channel: 'stable',
      currentVersion: 'one',
      targetVersion: 'two',
      targetProvenance: 'https://example.invalid/official-release',
      requestedAt: '2026-08-16T00:00:00.000Z'
    }
    const missingSafety: FrUpdateFacts = {
      environmentOwned: true,
      processStopped: true,
      workingTreeClean: true,
      restorePointAvailable: false,
      artifactStaged: false,
      capabilityProbePassed: false,
      targetResolved: true
    }
    const blocked = buildFrUpdatePlan(request, missingSafety, 'synthetic-runtime')
    expect(blocked.blocked).toBe(true)
    expect(
      blocked.checks.filter((item) => item.status === 'blocked').map((item) => item.id)
    ).toEqual(['restore-point', 'staged-runtime', 'capability-probe'])
    expect(blocked.rollbackStrategy).toContain('previous whole runtime')
    expect(
      buildFrUpdatePlan(
        { ...request, environmentRole: 'stable', installRoot: roots.stableRoot },
        {
          ...missingSafety,
          restorePointAvailable: true,
          artifactStaged: true,
          capabilityProbePassed: true
        },
        'synthetic-stable'
      ).blocked
    ).toBe(true)
  })

  it('recognizes native Krea capability but requires workflow evidence for promotion', () => {
    const core = path.join(root, 'synthetic-core')
    fs.mkdirSync(path.join(core, 'comfy', 'text_encoders'), { recursive: true })
    fs.writeFileSync(path.join(core, 'comfy', 'supported_models.py'), 'class Krea2')
    fs.writeFileSync(
      path.join(core, 'comfy', 'text_encoders', 'krea2.py'),
      'KREA2_TAP_LAYERS qwen3vl_4b'
    )
    const report = buildModelCapabilityReport(
      core,
      roots.sharedModelsRoot,
      [],
      '2026-08-16T00:00:00.000Z'
    )
    const krea = report.results.find((item) => item.id === 'krea2-turbo')!
    expect(krea.state).toBe('ready')
    expect(krea.performanceTiers.find((tier) => tier.id === 'balanced')).toMatchObject({
      inventoryAvailable: true,
      mainEnvironmentRecommended: false,
      benchmark: null
    })
  })

  it('keeps migration and uninstall source-preserving by construction', () => {
    const migration = buildFrMigrationSafetyPlan({
      mode: 'copy-to-next',
      sourceRoot: roots.stableRoot,
      targetRoot: roots.nextRoot,
      sharedModelsRoot: roots.sharedModelsRoot,
      sourceExists: true,
      sourceRunning: false,
      targetState: 'fr-owned',
      targetRestorePointAvailable: true
    })
    expect(migration.blocked).toBe(false)
    expect(migration.invariants).toContain(
      'shared model files are never copied, moved or rewritten'
    )

    const uninstall = buildFrDataRemovalPlan({
      mode: 'keep-environments',
      stableRoot: roots.stableRoot,
      sharedModelsRoot: roots.sharedModelsRoot,
      nextRoot: roots.nextRoot,
      labRoot: roots.labRoot,
      cacheRoot: roots.cacheRoot,
      ownership: { next: true, lab: true, cache: true }
    })
    expect(uninstall).toMatchObject({ blocked: false, removablePaths: [] })
    expect(digest(stableSentinel)).toBe(stableDigest)
  })
})
