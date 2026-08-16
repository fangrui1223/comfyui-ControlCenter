import { describe, expect, it } from 'vitest'
import type { FrReleaseReadinessInput } from '../../shared/frReleaseSafety'
import {
  buildFrDataRemovalPlan,
  buildFrMigrationSafetyPlan,
  evaluateFrReleaseReadiness
} from './frReleaseSafety'

const releaseInput: FrReleaseReadinessInput = {
  version: '1.0.39',
  productName: 'FR ComfyUI Control Center',
  appId: 'ai.fr.comfyui.controlcenter',
  artifactName: 'FR-ComfyUI-ControlCenter-1.0.39-win-x64.exe',
  sourceLicenseMode: 'agpl',
  licenseReviewApproved: true,
  thirdPartyNoticesGenerated: true,
  signingCertificateConfigured: true,
  publisherNameConfigured: true,
  updateProviderConfigured: true,
  userOriginConfigured: true,
  upstreamPushProtected: true,
  unitTestsPassed: true,
  integrationTestsPassed: true,
  windowsE2ePassed: true,
  productionBuildPassed: true,
  installerBuilt: true,
  installerSha256: 'A'.repeat(64),
  recoveryManualPresent: true
}

describe('FR release readiness', () => {
  it('distinguishes an internal unsigned candidate from a public release', () => {
    const report = evaluateFrReleaseReadiness(
      {
        ...releaseInput,
        licenseReviewApproved: false,
        thirdPartyNoticesGenerated: false,
        signingCertificateConfigured: false,
        publisherNameConfigured: false,
        updateProviderConfigured: false,
        userOriginConfigured: false
      },
      '2026-08-16T00:00:00.000Z'
    )
    expect(report.status).toBe('internal-unsigned-candidate')
    expect(report.publicBlockers).toEqual([
      'source-license',
      'third-party-notices',
      'code-signing',
      'update-provider',
      'origin'
    ])
  })

  it('requires every internal gate before producing any candidate', () => {
    expect(evaluateFrReleaseReadiness({ ...releaseInput, windowsE2ePassed: false }).status).toBe(
      'blocked'
    )
    expect(evaluateFrReleaseReadiness(releaseInput).status).toBe('public-release-ready')
  })
})

describe('FR migration and removal safety', () => {
  it('keeps read-only tracking non-mutating and makes copy migration fail closed', () => {
    const tracked = buildFrMigrationSafetyPlan({
      mode: 'track-read-only',
      sourceRoot: 'C:\\stable',
      targetRoot: 'C:\\next',
      sharedModelsRoot: 'D:\\models',
      sourceExists: true,
      sourceRunning: true,
      targetState: 'occupied',
      targetRestorePointAvailable: false
    })
    expect(tracked).toMatchObject({
      blocked: false,
      actions: ['register source metadata as read-only']
    })

    const copy = buildFrMigrationSafetyPlan({
      mode: 'copy-to-next',
      sourceRoot: 'C:\\stable',
      targetRoot: 'C:\\next',
      sharedModelsRoot: 'D:\\models',
      sourceExists: true,
      sourceRunning: true,
      targetState: 'occupied',
      targetRestorePointAvailable: false
    })
    expect(copy.blocked).toBe(true)
    expect(copy.checks.filter((item) => item.status === 'blocked').map((item) => item.id)).toEqual([
      'source-stopped',
      'target-owned',
      'restore-point'
    ])
    expect(copy.invariants).toContain(
      'source environment is never renamed, deleted, repaired or upgraded'
    )
  })

  it('protects stable and shared models from every uninstall mode', () => {
    const roots = {
      stableRoot: 'C:\\stable',
      sharedModelsRoot: 'C:\\stable\\models',
      nextRoot: 'C:\\next',
      labRoot: 'C:\\lab',
      cacheRoot: 'C:\\cache'
    }
    const keep = buildFrDataRemovalPlan({
      ...roots,
      mode: 'keep-environments',
      ownership: { next: false, lab: false, cache: false }
    })
    expect(keep).toMatchObject({ blocked: false, removablePaths: [] })
    expect(keep.protectedPaths).toEqual([
      expect.stringMatching(/stable$/),
      expect.stringMatching(/stable[\\/]models$/)
    ])

    const purge = buildFrDataRemovalPlan({
      ...roots,
      mode: 'remove-fr-managed-data',
      ownership: { next: true, lab: false, cache: true }
    })
    expect(purge.blocked).toBe(true)
    expect(purge.removablePaths).toEqual([
      expect.stringMatching(/next$/),
      expect.stringMatching(/cache$/)
    ])
    expect(purge.removablePaths.some((value) => /stable/.test(value))).toBe(false)
  })
})
