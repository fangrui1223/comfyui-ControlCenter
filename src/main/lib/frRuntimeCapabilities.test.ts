import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FrRuntimeProbe } from '../../shared/frRuntimeCapabilities'
import {
  FR_OPTIONAL_ACCELERATORS,
  FR_RUNTIME_PROFILES,
  compareVersions,
  evaluateRuntimeProfile,
  inspectDistInfoVersions,
  parseNvidiaSmiCsv
} from './frRuntimeCapabilities'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('FR runtime capability catalog', () => {
  it('pins the official ComfyUI Blackwell stable tuple', () => {
    const stable = FR_RUNTIME_PROFILES.find((profile) => profile.channel === 'stable')!
    expect(stable).toMatchObject({
      python: '3.13.12',
      minComputeCapability: 12,
      minDriver: '580.88',
      compiledCachePolicy: 'per-environment'
    })
    expect(stable.packages.map(({ name, version }) => [name, version])).toEqual([
      ['torch', '2.12.1+cu130'],
      ['torchvision', '0.27.1+cu130'],
      ['torchaudio', '2.11.0+cu130']
    ])
  })

  it('never promotes compiled optional accelerators without a quality gate', () => {
    expect(FR_OPTIONAL_ACCELERATORS.length).toBeGreaterThanOrEqual(4)
    expect(
      FR_OPTIONAL_ACCELERATORS.every(
        (profile) =>
          profile.compiledCachePolicy === 'per-environment' && Boolean(profile.qualityGate)
      )
    ).toBe(true)
    expect(
      FR_OPTIONAL_ACCELERATORS.find((profile) => profile.id === 'sageattention3-blackwell')
    ).toMatchObject({ channel: 'experimental', activation: 'per-workflow' })
    expect(
      FR_OPTIONAL_ACCELERATORS.find((profile) => profile.id === 'xformers-0.0.35-cu130')
    ).toMatchObject({ channel: 'experimental', targetDisposition: 'blocked-on-target' })
  })

  it('parses the RTX 5090 NVIDIA probe and version ordering', () => {
    expect(parseNvidiaSmiCsv('NVIDIA GeForce RTX 5090, 610.47, 32607, 12.0\r\n')).toEqual({
      name: 'NVIDIA GeForce RTX 5090',
      driverVersion: '610.47',
      memoryMiB: 32607,
      computeCapability: 12
    })
    expect(compareVersions('610.47', '580.88')).toBeGreaterThan(0)
    expect(compareVersions('580.80', '580.88')).toBeLessThan(0)
  })

  it('reads package tuples without importing or executing the environment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-dist-info-'))
    tempRoots.push(root)
    fs.mkdirSync(path.join(root, 'torch-2.12.1+cu130.dist-info'))
    fs.mkdirSync(path.join(root, 'triton_windows-3.7.1.post27.dist-info'))

    expect(inspectDistInfoVersions(root, ['torch', 'triton_windows', 'xformers'])).toEqual({
      torch: '2.12.1+cu130',
      triton_windows: '3.7.1.post27',
      xformers: null
    })
  })

  it('accepts the target hardware but blocks an old driver', () => {
    const profile = FR_RUNTIME_PROFILES[0]!
    const probe: FrRuntimeProbe = {
      capturedAt: '2026-08-16T00:00:00.000Z',
      platform: 'win32',
      arch: 'x64',
      longPathsEnabled: true,
      gpu: {
        name: 'NVIDIA GeForce RTX 5090',
        driverVersion: '610.47',
        memoryMiB: 32607,
        computeCapability: 12
      },
      packageVersions: {}
    }
    expect(evaluateRuntimeProfile(profile, probe).eligibility).toBe('eligible')

    probe.gpu!.driverVersion = '570.00'
    expect(evaluateRuntimeProfile(profile, probe)).toMatchObject({
      eligibility: 'blocked',
      checks: expect.arrayContaining([expect.objectContaining({ id: 'driver', status: 'blocked' })])
    })
  })
})
