import path from 'node:path'
import type {
  FrDataRemovalInput,
  FrDataRemovalPlan,
  FrMigrationSafetyInput,
  FrMigrationSafetyPlan,
  FrReleaseReadinessCheck,
  FrReleaseReadinessInput,
  FrReleaseReadinessReport
} from '../../shared/frReleaseSafety'

function check(
  id: string,
  scope: FrReleaseReadinessCheck['scope'],
  passed: boolean,
  passedSummary: string,
  blockedSummary: string
): FrReleaseReadinessCheck {
  return {
    id,
    scope,
    status: passed ? 'pass' : 'blocked',
    summary: passed ? passedSummary : blockedSummary
  }
}

export function evaluateFrReleaseReadiness(
  input: FrReleaseReadinessInput,
  evaluatedAt = new Date().toISOString()
): FrReleaseReadinessReport {
  const shaValid = input.installerSha256 === null || /^[A-F0-9]{64}$/i.test(input.installerSha256)
  const checks: FrReleaseReadinessCheck[] = [
    check(
      'identity',
      'internal',
      input.productName === 'FR ComfyUI Control Center' &&
        input.appId === 'ai.fr.comfyui.controlcenter' &&
        input.artifactName.startsWith('FR-ComfyUI-ControlCenter-'),
      'FR product identity and artifact namespace are isolated.',
      'Product identity or artifact namespace is not isolated.'
    ),
    check(
      'unit-tests',
      'internal',
      input.unitTestsPassed,
      'Unit tests passed.',
      'Unit tests have not passed.'
    ),
    check(
      'integration-tests',
      'internal',
      input.integrationTestsPassed,
      'Integration tests passed.',
      'Integration tests have not passed.'
    ),
    check(
      'windows-e2e',
      'internal',
      input.windowsE2ePassed,
      'Windows E2E passed.',
      'Windows E2E has not passed.'
    ),
    check(
      'production-build',
      'internal',
      input.productionBuildPassed,
      'Production build passed.',
      'Production build has not passed.'
    ),
    check(
      'installer',
      'internal',
      input.installerBuilt && Boolean(input.installerSha256) && shaValid,
      'Installer exists and has a valid SHA-256 digest.',
      'Installer or its SHA-256 digest is missing or invalid.'
    ),
    check(
      'recovery-manual',
      'internal',
      input.recoveryManualPresent,
      'Recovery manual is present.',
      'Recovery manual is missing.'
    ),
    check(
      'source-license',
      'public',
      input.licenseReviewApproved,
      `${input.sourceLicenseMode.toUpperCase()} release path was reviewed.`,
      `${input.sourceLicenseMode.toUpperCase()} release path requires legal/license review.`
    ),
    check(
      'third-party-notices',
      'public',
      input.thirdPartyNoticesGenerated,
      'Complete generated third-party notices are included.',
      'Complete generated transitive third-party notices are missing.'
    ),
    check(
      'code-signing',
      'public',
      input.signingCertificateConfigured && input.publisherNameConfigured,
      'Windows signing identity and publisher are configured.',
      'Windows signing certificate or publisher is not configured.'
    ),
    check(
      'update-provider',
      'public',
      input.updateProviderConfigured,
      'FR update provider is configured.',
      'FR update provider is not configured; upstream channels remain disabled.'
    ),
    check(
      'origin',
      'public',
      input.userOriginConfigured && input.upstreamPushProtected,
      'User-owned origin exists and upstream push is protected.',
      'User-owned origin or upstream push protection is missing.'
    )
  ]
  const internalBlocked = checks.some(
    (item) => item.scope === 'internal' && item.status === 'blocked'
  )
  const publicBlockers = checks
    .filter((item) => item.scope === 'public' && item.status === 'blocked')
    .map((item) => item.id)
  return {
    schemaVersion: 1,
    evaluatedAt,
    version: input.version,
    status: internalBlocked
      ? 'blocked'
      : publicBlockers.length > 0
        ? 'internal-unsigned-candidate'
        : 'public-release-ready',
    checks,
    publicBlockers
  }
}

function sameOrWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function buildFrMigrationSafetyPlan(input: FrMigrationSafetyInput): FrMigrationSafetyPlan {
  const sourceAndTargetSeparate =
    !sameOrWithin(input.sourceRoot, input.targetRoot) &&
    !sameOrWithin(input.targetRoot, input.sourceRoot)
  const modelsOutsideTarget = !sameOrWithin(input.sharedModelsRoot, input.targetRoot)
  const checks: FrReleaseReadinessCheck[] = [
    check(
      'source-exists',
      'internal',
      input.sourceExists,
      'Source environment exists.',
      'Source environment is missing.'
    ),
    check(
      'path-separation',
      'internal',
      sourceAndTargetSeparate && modelsOutsideTarget,
      'Source, target and shared models are separate.',
      'Source, target or shared-model paths overlap.'
    )
  ]
  if (input.mode === 'copy-to-next') {
    checks.push(
      check(
        'source-stopped',
        'internal',
        !input.sourceRunning,
        'Source is stopped for a consistent read.',
        'Source must be stopped before migration.'
      ),
      check(
        'target-owned',
        'internal',
        input.targetState === 'missing' || input.targetState === 'fr-owned',
        'Target is missing or FR-owned.',
        'Target contains unowned data.'
      ),
      check(
        'restore-point',
        'internal',
        input.targetRestorePointAvailable,
        'Target restore point is available.',
        'Target restore point is required.'
      )
    )
  }
  return {
    schemaVersion: 1,
    mode: input.mode,
    blocked: checks.some((item) => item.status === 'blocked'),
    checks,
    actions:
      input.mode === 'track-read-only'
        ? ['register source metadata as read-only']
        : [
            'create target safety snapshot',
            'copy selected workflows and user configuration into staging',
            'generate model mapping without copying model files',
            'selectively reinstall reviewed plugins',
            'run target startup and representative workflow gates',
            'atomically publish target staging layout'
          ],
    invariants: [
      'source environment is never renamed, deleted, repaired or upgraded',
      'shared model files are never copied, moved or rewritten',
      'Python, custom_nodes, Manager state and compiled caches are never copied',
      'failed migration leaves the source launchable and rolls target staging back'
    ]
  }
}

export function buildFrDataRemovalPlan(input: FrDataRemovalInput): FrDataRemovalPlan {
  const protectedPaths = [path.resolve(input.stableRoot), path.resolve(input.sharedModelsRoot)]
  const candidates = [
    { role: 'next' as const, root: input.nextRoot },
    { role: 'lab' as const, root: input.labRoot },
    { role: 'cache' as const, root: input.cacheRoot }
  ]
  const checks = candidates.map((candidate) =>
    check(
      `ownership-${candidate.role}`,
      'internal',
      input.mode === 'keep-environments' || input.ownership[candidate.role],
      input.mode === 'keep-environments'
        ? `${candidate.role} is preserved by default.`
        : `${candidate.role} has an FR ownership marker.`,
      `${candidate.role} is not FR-owned and cannot be removed.`
    )
  )
  const removablePaths =
    input.mode === 'remove-fr-managed-data'
      ? candidates
          .filter((candidate) => input.ownership[candidate.role])
          .map((candidate) => path.resolve(candidate.root))
      : []
  return {
    schemaVersion: 1,
    mode: input.mode,
    blocked: checks.some((item) => item.status === 'blocked'),
    protectedPaths,
    removablePaths,
    checks
  }
}
