import { describe, expect, it } from 'vitest'
import type { FrUpdateFacts, FrUpdateRequest } from '../../shared/frUpdateTransactions'
import {
  buildFrUpdatePlan,
  FR_UPDATE_CHANNEL_POLICIES,
  isPathInsideInstall
} from './frUpdateTransactions'

const request: FrUpdateRequest = {
  environmentRole: 'next',
  installRoot: 'C:\\FR_comfyui_next',
  component: 'core',
  channel: 'stable',
  currentVersion: 'v0.33.1',
  targetVersion: 'v0.33.2',
  targetProvenance: 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.33.2',
  requestedAt: '2026-08-16T00:00:00.000Z'
}

const facts: FrUpdateFacts = {
  environmentOwned: true,
  processStopped: true,
  workingTreeClean: true,
  restorePointAvailable: true,
  artifactStaged: false,
  capabilityProbePassed: null,
  targetResolved: true
}

describe('FR update transaction planner', () => {
  it('allows one stable Core transaction in next when every preflight passes', () => {
    const plan = buildFrUpdatePlan(request, facts, 'core-1')
    expect(plan.blocked).toBe(false)
    expect(plan.requiredGates).toContain('core-quick-test')
    expect(plan.rollbackStrategy).toContain('offline git bundle')
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('blocks all stable-install mutations and preview changes in next', () => {
    expect(
      buildFrUpdatePlan({ ...request, environmentRole: 'stable' }, facts, 'core-2').blocked
    ).toBe(true)
    expect(buildFrUpdatePlan({ ...request, channel: 'preview' }, facts, 'core-3').blocked).toBe(
      true
    )
  })

  it('allows preview and experimental channels only in lab', () => {
    const lab = buildFrUpdatePlan(
      { ...request, environmentRole: 'lab', channel: 'experimental' },
      facts,
      'core-4'
    )
    expect(lab.blocked).toBe(false)
    expect(
      FR_UPDATE_CHANNEL_POLICIES.find((policy) => policy.role === 'lab')?.allowedChannels
    ).toEqual(['stable', 'preview', 'experimental'])
  })

  it('requires staging and a hardware probe for every runtime transaction', () => {
    const blocked = buildFrUpdatePlan({ ...request, component: 'runtime' }, facts, 'runtime-1')
    expect(blocked.blocked).toBe(true)
    expect(
      blocked.checks.filter((check) => check.status === 'blocked').map((check) => check.id)
    ).toEqual(expect.arrayContaining(['staged-runtime', 'capability-probe']))
  })

  it('detects update artifacts that escape the install boundary', () => {
    expect(isPathInsideInstall('C:\\FR_comfyui_next', 'C:\\FR_comfyui_next\\ComfyUI')).toBe(true)
    expect(isPathInsideInstall('C:\\FR_comfyui_next', 'C:\\FR_comfyui\\models')).toBe(false)
  })
})
