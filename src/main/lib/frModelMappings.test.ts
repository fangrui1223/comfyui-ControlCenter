import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCoreModelMappingPlan,
  discoverCoreModelCategories,
  executeCoreModelMappingPlan,
  planPluginModelLink,
  renderExtraModelPaths,
  scanSharedModelLibrary
} from './frModelMappings'

describe('FR model mapping broker', () => {
  let root = ''
  let sharedRoot = ''
  let environmentRoot = ''
  let folderPathsFile = ''

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-model-map-'))
    sharedRoot = path.join(root, 'shared-models')
    environmentRoot = path.join(root, 'next')
    folderPathsFile = path.join(root, 'folder_paths.py')
    fs.mkdirSync(path.join(sharedRoot, 'checkpoints'), { recursive: true })
    fs.mkdirSync(path.join(sharedRoot, 'clip'), { recursive: true })
    fs.mkdirSync(path.join(sharedRoot, 'plugin-private'), { recursive: true })
    fs.writeFileSync(path.join(sharedRoot, 'checkpoints', 'model.safetensors'), '12345')
    fs.writeFileSync(
      folderPathsFile,
      [
        'folder_names_and_paths["checkpoints"] = (["models/checkpoints"], set())',
        'folder_names_and_paths["text_encoders"] = (["models/text_encoders"], set())',
        'legacy = {"clip": "text_encoders", "unet": "diffusion_models"}'
      ].join('\n')
    )
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('discovers core categories and legacy aliases from the pinned Core source', () => {
    const result = discoverCoreModelCategories(fs.readFileSync(folderPathsFile, 'utf8'))
    expect([...result.categories]).toEqual(['checkpoints', 'text_encoders'])
    expect(Object.fromEntries(result.aliases)).toEqual({
      clip: 'text_encoders',
      unet: 'diffusion_models'
    })
  })

  it('inventories physical folders without following plugin-private paths', () => {
    const inventory = scanSharedModelLibrary({
      sharedRoot,
      folderPathsFile,
      coreSourceCommit: 'abc123',
      scannedAt: new Date('2026-08-16T00:00:00Z')
    })
    expect(inventory.totalBytes).toBe(5)
    expect(inventory.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'checkpoints',
          disposition: 'core-extra-path',
          logicalCategory: 'checkpoints'
        }),
        expect.objectContaining({
          name: 'clip',
          disposition: 'core-extra-path',
          logicalCategory: 'text_encoders'
        }),
        expect.objectContaining({
          name: 'plugin-private',
          disposition: 'plugin-verification-required'
        })
      ])
    )
  })

  it('renders and commits a reversible standard-category YAML transaction', () => {
    const inventory = scanSharedModelLibrary({
      sharedRoot,
      folderPathsFile,
      coreSourceCommit: 'abc123'
    })
    const plan = buildCoreModelMappingPlan({ inventory, environmentRoot })
    expect(plan.blocked).toBe(false)
    const parsed = YAML.parse(renderExtraModelPaths(plan)) as Record<string, Record<string, string>>
    expect(parsed.fr_shared_models!.checkpoints).toBe(path.join(sharedRoot, 'checkpoints'))
    expect(parsed.fr_shared_models!.text_encoders!.split('\n')).toContain(
      path.join(sharedRoot, 'clip')
    )

    executeCoreModelMappingPlan(plan)
    expect(fs.existsSync(plan.configPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(plan.undoManifestPath, 'utf8'))).toMatchObject({
      transactionId: plan.transactionId,
      createdJunctions: []
    })
  })

  it('fails closed instead of overwriting an existing mapping output', () => {
    const inventory = scanSharedModelLibrary({
      sharedRoot,
      folderPathsFile,
      coreSourceCommit: 'abc123'
    })
    const first = buildCoreModelMappingPlan({ inventory, environmentRoot })
    fs.mkdirSync(path.dirname(first.configPath), { recursive: true })
    fs.writeFileSync(first.configPath, 'user-owned')

    const second = buildCoreModelMappingPlan({ inventory, environmentRoot })
    expect(second.blocked).toBe(true)
    expect(() => executeCoreModelMappingPlan(second)).toThrow('blocked')
    expect(fs.readFileSync(first.configPath, 'utf8')).toBe('user-owned')
  })

  it('requires a provenance-rich plugin declaration before planning a junction', () => {
    const plan = planPluginModelLink({
      declaration: {
        pluginId: 'example/plugin',
        sharedFolder: 'plugin-private',
        targetRelativePath: 'plugin-private',
        provenance: {
          repository: 'https://example.invalid/plugin',
          commit: 'abc123',
          evidenceFile: 'nodes.py',
          evidenceLine: 42
        }
      },
      sharedRoot,
      environmentRoot
    })
    expect(plan).toMatchObject({ status: 'ready', source: path.join(sharedRoot, 'plugin-private') })
  })

  it('blocks plugin targets that escape or collide with the next environment', () => {
    const declaration = {
      pluginId: 'example/plugin',
      sharedFolder: 'plugin-private',
      targetRelativePath: '..\\outside',
      provenance: {
        repository: 'https://example.invalid/plugin',
        commit: 'abc123',
        evidenceFile: 'nodes.py',
        evidenceLine: 42
      }
    }
    expect(planPluginModelLink({ declaration, sharedRoot, environmentRoot })).toMatchObject({
      status: 'blocked'
    })

    declaration.targetRelativePath = 'plugin-private'
    fs.mkdirSync(path.join(environmentRoot, 'ComfyUI', 'models', 'plugin-private'), {
      recursive: true
    })
    expect(planPluginModelLink({ declaration, sharedRoot, environmentRoot })).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('already exists')
    })
  })
})
