import { describe, expect, it, vi } from 'vitest'
import type { InstallationRecord } from '../installations'
import type { FrEnvironmentProfileView } from '../../shared/frEnvironmentProfiles'

vi.mock('./cnr', () => ({ getCnrInstallInfo: vi.fn() }))

import {
  classifyCnrVersionState,
  classifyPluginGitState,
  evaluatePluginMutationPolicy
} from './pluginUpdates'

const base = {
  detached: false,
  dirty: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  fetchError: null
}

describe('classifyPluginGitState', () => {
  it.each([
    [{}, 'current'],
    [{ behind: 2 }, 'update-available'],
    [{ ahead: 1 }, 'ahead'],
    [{ ahead: 1, behind: 1 }, 'diverged'],
    [{ dirty: true, behind: 2 }, 'dirty'],
    [{ detached: true }, 'detached'],
    [{ upstream: null }, 'no-upstream'],
    [{ fetchError: 'offline', behind: 2 }, 'unreachable']
  ] as const)('classifies %o as %s', (overrides, expected) => {
    expect(classifyPluginGitState({ ...base, ...overrides })).toBe(expected)
  })
})

describe('classifyCnrVersionState', () => {
  it.each([
    ['1.1.0', '1.1.0', 'current'],
    ['1.0.0', '1.1.0', 'update-available'],
    ['1.2.0', '1.1.0', 'ahead'],
    ['1.0', '1.0.0', 'current'],
    [null, '1.0.0', 'unsupported'],
    ['1.0.0', null, 'unreachable']
  ] as const)('classifies %s → %s as %s', (installed, latest, expected) => {
    expect(classifyCnrVersionState(installed, latest)).toBe(expected)
  })
})

function installation(installPath: string, sourceId = 'standalone'): InstallationRecord {
  return {
    id: 'inst-1',
    name: 'test',
    createdAt: '2026-09-27T00:00:00.000Z',
    installPath,
    sourceId
  }
}

function profiles(): FrEnvironmentProfileView[] {
  return [
    {
      role: 'stable',
      mode: 'unregistered',
      path: null,
      updatedAt: null,
      managedAuthorizedAt: null,
      suggestedPath: '/fr/stable',
      folderState: 'not-checked'
    },
    {
      role: 'next',
      mode: 'read-only',
      path: '/fr/next',
      updatedAt: null,
      managedAuthorizedAt: null,
      suggestedPath: '/fr/next',
      folderState: 'directory'
    },
    {
      role: 'lab',
      mode: 'managed',
      path: '/fr/lab',
      updatedAt: null,
      managedAuthorizedAt: '2026-09-27T00:00:00.000Z',
      suggestedPath: '/fr/lab',
      folderState: 'directory'
    }
  ]
}

describe('evaluatePluginMutationPolicy', () => {
  it('keeps the stable suggestion protected even before registration', () => {
    expect(evaluatePluginMutationPolicy(installation('/fr/stable'), profiles()).mutable).toBe(false)
    expect(
      evaluatePluginMutationPolicy(installation('/fr/stable/ComfyUI'), profiles()).mutable
    ).toBe(false)
  })

  it('requires managed authorization for a registered next environment', () => {
    const result = evaluatePluginMutationPolicy(installation('/fr/next'), profiles())
    expect(result.mutable).toBe(false)
    expect(result.reason).toContain('not authorized')
  })

  it('allows a managed lab and an ordinary standalone install', () => {
    expect(evaluatePluginMutationPolicy(installation('/fr/lab'), profiles()).mutable).toBe(true)
    expect(evaluatePluginMutationPolicy(installation('/other/install'), profiles()).mutable).toBe(
      true
    )
  })

  it('keeps non-standalone layouts inspection-only', () => {
    expect(
      evaluatePluginMutationPolicy(installation('/other/install', 'portable'), profiles()).mutable
    ).toBe(false)
  })
})
