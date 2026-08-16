import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FrModelCapabilityProfile,
  FrWorkflowBenchmarkRecord
} from '../../shared/frModelCapabilities'
import {
  FR_MODEL_CAPABILITY_CATALOG,
  FR_MODEL_PERFORMANCE_CATALOG,
  buildModelCapabilityReport,
  evaluateModelCapability,
  indexModelLibrary
} from './frModelCapabilities'

const roots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-model-capabilities-'))
  roots.push(root)
  return root
}

function write(root: string, relative: string, contents = 'marker'): void {
  const file = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('FR model capability catalog', () => {
  it('keeps local, API and future capabilities separate', () => {
    expect(FR_MODEL_CAPABILITY_CATALOG.schemaVersion).toBe(1)
    expect(FR_MODEL_CAPABILITY_CATALOG.profiles.length).toBeGreaterThanOrEqual(14)
    expect(
      FR_MODEL_CAPABILITY_CATALOG.profiles.find((profile) => profile.id === 'flux3-official-api')
    ).toMatchObject({ supportMode: 'official-api', modelRequirements: [] })
    expect(
      FR_MODEL_CAPABILITY_CATALOG.profiles.find((profile) => profile.id === 'flux3-local-watcher')
    ).toMatchObject({ supportMode: 'watcher', confidence: 'future-unverified' })
  })

  it('defines a safe RTX 5090 daily preset and isolates SageAttention to lab', () => {
    expect(
      FR_MODEL_CAPABILITY_CATALOG.performancePresets.find(
        (preset) => preset.id === 'next-daily-performance'
      )
    ).toMatchObject({
      environment: 'next',
      attentionBackend: 'pytorch-sdpa',
      tritonBackend: 'enabled',
      dynamicVram: 'automatic'
    })
    expect(
      FR_MODEL_CAPABILITY_CATALOG.performancePresets.find(
        (preset) => preset.id === 'lab-sageattention3-blackwell'
      )
    ).toMatchObject({ environment: 'lab', qualityGate: 'workflow-comparison' })
  })

  it('defines three honest tiers for every capability without inventing VRAM floors', () => {
    const profileIds = new Set(FR_MODEL_CAPABILITY_CATALOG.profiles.map((profile) => profile.id))
    expect(FR_MODEL_PERFORMANCE_CATALOG.targetHardware).toEqual({
      gpu: 'NVIDIA GeForce RTX 5090',
      vramMiB: 32607
    })
    expect(
      FR_MODEL_PERFORMANCE_CATALOG.profiles.map((profile) => profile.profileId).sort()
    ).toEqual([...profileIds].sort())
    for (const profile of FR_MODEL_PERFORMANCE_CATALOG.profiles) {
      expect(profile.tiers.map((tier) => tier.id)).toEqual(['quality', 'balanced', 'speed'])
      expect(profile.vramGuidance).toHaveProperty('minimumVramMiB')
      expect(profile.vramGuidance).toHaveProperty('recommendedVramMiB')
    }
  })

  it('does not follow model-library links', () => {
    const root = temporaryRoot()
    const outside = temporaryRoot()
    write(root, 'vae/qwen_image_vae.safetensors')
    write(outside, 'secret.safetensors')
    const link = path.join(root, 'linked')
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }

    expect(indexModelLibrary(root)).toMatchObject({
      files: ['vae/qwen_image_vae.safetensors'],
      skippedReparsePoints: ['linked']
    })
  })

  it('requires every native Core marker and model group', () => {
    const core = temporaryRoot()
    const modelRoot = temporaryRoot()
    write(core, 'comfy/supported_models.py', 'class Krea2')
    write(core, 'comfy/text_encoders/krea2.py', 'KREA2_TAP_LAYERS qwen3vl_4b')
    write(modelRoot, 'diffusion_models/krea2/krea2_turbo_fp8_scaled.safetensors')
    write(modelRoot, 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors')
    write(modelRoot, 'vae/qwen_image_vae.safetensors')

    const report = buildModelCapabilityReport(core, modelRoot, [], '2026-08-16T00:00:00.000Z')
    expect(report.results.find((result) => result.id === 'krea2-turbo')).toMatchObject({
      coreSupported: true,
      state: 'ready',
      missingRequiredRequirementIds: []
    })

    fs.rmSync(path.join(modelRoot, 'vae/qwen_image_vae.safetensors'))
    expect(
      buildModelCapabilityReport(core, modelRoot).results.find((r) => r.id === 'krea2-turbo')
    ).toMatchObject({ state: 'partial', missingRequiredRequirementIds: ['vae'] })
  })

  it('holds plugin-local models until the exact plugin is installed', () => {
    const profile: FrModelCapabilityProfile = {
      id: 'plugin-model',
      label: 'Plugin model',
      family: 'Test',
      supportMode: 'plugin-local',
      confidence: 'upstream-declared',
      coreMarkers: [],
      modelRequirements: [
        {
          id: 'model',
          label: 'Model',
          required: true,
          oneOfPatterns: ['^plugin/model\\.bin$']
        }
      ],
      requiredPluginIds: ['Required-Plugin'],
      performancePresetIds: [],
      evidence: [],
      notes: []
    }

    expect(evaluateModelCapability(profile, '', ['plugin/model.bin'])).toMatchObject({
      state: 'plugin-required',
      missingRequiredPluginIds: ['Required-Plugin']
    })
    expect(
      evaluateModelCapability(profile, '', ['plugin/model.bin'], ['required-plugin'])
    ).toMatchObject({ state: 'ready', missingRequiredPluginIds: [] })
  })

  it('promotes a tier only after a passed matching workflow benchmark', () => {
    const core = temporaryRoot()
    write(core, 'comfy/supported_models.py', 'class Krea2')
    write(core, 'comfy/text_encoders/krea2.py', 'KREA2_TAP_LAYERS qwen3vl_4b')
    const profile = FR_MODEL_CAPABILITY_CATALOG.profiles.find(
      (candidate) => candidate.id === 'krea2-turbo'
    )!
    const files = [
      'diffusion_models/krea2/krea2_turbo_fp8.safetensors',
      'text_encoders/qwen3vl_4b_fp8_scaled.safetensors',
      'vae/qwen_image_vae.safetensors'
    ]
    expect(
      evaluateModelCapability(profile, core, files).performanceTiers.find(
        (tier) => tier.id === 'balanced'
      )
    ).toMatchObject({ inventoryAvailable: true, mainEnvironmentRecommended: false })

    const record: FrWorkflowBenchmarkRecord = {
      schemaVersion: 1,
      profileId: 'krea2-turbo',
      tierId: 'balanced',
      runtimeProfileId: 'win-nvidia-py313-torch2121-cu130',
      coreCommit: '72865f4f',
      gpu: 'NVIDIA GeForce RTX 5090',
      workflowId: 'official-krea2-turbo-t2i',
      capturedAt: '2026-08-16T00:00:00.000Z',
      coldStartMs: 1000,
      warmStartMs: 500,
      firstOutputMs: 2000,
      totalMs: 3000,
      peakVramMiB: 20000,
      peakRamMiB: 10000,
      compiledCacheHit: true,
      outputComparison: 'pass',
      passed: true
    }
    expect(
      evaluateModelCapability(profile, core, files, [], [record]).performanceTiers.find(
        (tier) => tier.id === 'balanced'
      )
    ).toMatchObject({ mainEnvironmentRecommended: true, benchmark: record })
  })

  it('validates every catalog regex and unique identifier', () => {
    const ids = FR_MODEL_CAPABILITY_CATALOG.profiles.map((profile) => profile.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const profile of FR_MODEL_CAPABILITY_CATALOG.profiles) {
      for (const requirement of profile.modelRequirements) {
        for (const pattern of requirement.oneOfPatterns)
          expect(() => new RegExp(pattern, 'i')).not.toThrow()
      }
    }
  })
})
