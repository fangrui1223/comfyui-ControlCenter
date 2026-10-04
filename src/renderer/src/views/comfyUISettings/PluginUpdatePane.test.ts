import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import type { ElectronApi, PluginCompatibilityPlan, PluginUpdateInventory } from '../../types/ipc'
import PluginUpdatePane from './PluginUpdatePane.vue'

function inventory(mutable = true): PluginUpdateInventory {
  return {
    installationId: 'inst-1',
    checkedAt: '2026-09-27T00:00:00.000Z',
    mutable,
    mutationBlockedReason: mutable ? null : 'Stable is read-only.',
    lastRun: null,
    summary: { total: 1, updateAvailable: 1, attention: 0, unsupported: 0 },
    items: [
      {
        id: 'ExampleNode',
        dirName: 'ExampleNode',
        enabled: true,
        sourceType: 'git',
        repository: 'https://github.com/example/node.git',
        branch: 'main',
        upstream: 'origin/main',
        localCommit: '1111111111111111111111111111111111111111',
        remoteCommit: '2222222222222222222222222222222222222222',
        installedVersion: null,
        latestVersion: null,
        ahead: 0,
        behind: 1,
        dirty: false,
        status: 'update-available',
        updateable: mutable,
        reasonCode: mutable ? null : 'read-only',
        reason: mutable ? null : 'This environment is read-only.',
        hasRequirements: true,
        hasInstallScript: false,
        hasCompiledDependencies: false
      }
    ]
  }
}

function compatibilityPlan(): PluginCompatibilityPlan {
  return {
    installationId: 'inst-1',
    pluginId: 'ExampleNode',
    dirName: 'ExampleNode',
    sourceType: 'git',
    currentRef: '1111111111111111111111111111111111111111',
    targetRef: '2222222222222222222222222222222222222222',
    targetSource: 'Git upstream',
    provenance: 'https://github.com/example/node.git#2222222222222222222222222222222222222222',
    generatedAt: '2026-09-27T00:00:00.000Z',
    environmentFingerprint: 'a'.repeat(64),
    planDigest: 'b'.repeat(64),
    environment: {
      pythonVersion: '3.12.10',
      pythonArchitecture: 'AMD64',
      torchVersion: '2.8.0+cu128',
      cudaVersion: 'cu128',
      numpyVersion: '2.2.6',
      compiledPackages: { 'onnxruntime-gpu': '1.22.0' }
    },
    currentDependencies: [],
    targetDependencies: [],
    dependencyDifferences: [],
    compiledDependencyDifferences: [],
    protectedStackDifferences: [],
    installHookDifferences: [],
    nativeBinaryFiles: [],
    nativeBinaryChanges: [],
    preexistingPipCheckIssues: [],
    verdict: 'ready',
    blockers: [],
    warnings: [],
    proposedChanges: []
  }
}

function installApi(value: PluginUpdateInventory, plan = compatibilityPlan()): void {
  window.api = {
    getPluginUpdates: vi.fn().mockResolvedValue(value),
    getPluginCompatibilityPlan: vi.fn().mockResolvedValue(plan),
    onInstallationsChanged: vi.fn(() => () => {})
  } as unknown as ElectronApi
}

function mountPane() {
  return mount(PluginUpdatePane, {
    props: { installationId: 'inst-1' },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'en',
          messages: {
            en: {
              pluginUpdates: {
                compatibility: {
                  confirmPackages: 'Install these {n} packages?',
                  confirmRecovery: 'Restore backups on failure. Remain stopped.'
                }
              }
            }
          }
        })
      ]
    }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('PluginUpdatePane', () => {
  it('shows concrete dependency conflicts and keeps execution unavailable', async () => {
    const plan = {
      ...compatibilityPlan(),
      verdict: 'blocked' as const,
      executionMode: 'wheel-update' as const,
      dependencyConflicts: [
        {
          dependency: 'albucore',
          requirements: [
            { owner: 'albumentations', constraint: '==0.0.24' },
            { owner: 'albumentationsx', constraint: '==0.2.20' }
          ]
        }
      ]
    }
    installApi(inventory(), plan)
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('[data-testid="plugin-compatibility-check-ExampleNode"]').trigger('click')
    await flushPromises()
    const text = wrapper.get('[data-testid="plugin-dependency-conflicts"]').text()
    expect(text).toContain('albumentations → albucore==0.0.24')
    expect(text).toContain('albumentationsx → albucore==0.2.20')
    expect(wrapper.find('[data-testid="plugin-compatibility-execute-ExampleNode"]').exists()).toBe(
      false
    )
  })
  it('shows exact wheel versions and emits explicit dependency approval with the plan digest', async () => {
    const plan = compatibilityPlan()
    plan.verdict = 'approval-required'
    plan.executionMode = 'wheel-update'
    plan.packageChanges = [
      {
        name: 'new-package',
        from: '1.0',
        to: '2.0',
        kind: 'changed',
        compiled: false,
        protected: false,
        reason: 'direct',
        wheel: {
          filename: 'new_package-2.0-py3-none-any.whl',
          url: 'https://files.pythonhosted.org/new_package.whl',
          sha256: 'd'.repeat(64),
          size: 1024,
          tags: ['py3-none-any']
        }
      }
    ]
    installApi(inventory(), plan)
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.get('[data-testid="plugin-compatibility-check-ExampleNode"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="plugin-wheel-plan"]').text()).toContain(
      'new-package: 1.0 → 2.0'
    )
    await wrapper.get('[data-testid="plugin-compatibility-execute-ExampleNode"]').trigger('click')
    const action = wrapper.emitted('run-action')?.at(-1)?.[0] as {
      data: unknown
      confirm: { message: string }
    }
    expect(action.data).toMatchObject({ approveDependencies: true, planDigest: 'b'.repeat(64) })
    expect(action.confirm.message).toContain('new-package: 1.0 → 2.0')
    expect(action.confirm.message).toContain('Remain stopped')
  })

  it.each(['review-required', 'blocked', 'error'] as const)(
    'exposes no execution button for %s',
    async (verdict) => {
      installApi(inventory(), { ...compatibilityPlan(), verdict, executionMode: 'isolated-review' })
      const wrapper = mountPane()
      await flushPromises()
      await wrapper.get('[data-testid="plugin-compatibility-check-ExampleNode"]').trigger('click')
      await flushPromises()
      expect(
        wrapper.find('[data-testid="plugin-compatibility-execute-ExampleNode"]').exists()
      ).toBe(false)
    }
  )
  it('selects an available Git plugin and emits a Manager v4 update action', async () => {
    installApi(inventory())
    const wrapper = mountPane()
    await flushPromises()

    await wrapper.find('.plugin-row input').setValue(true)
    await wrapper.get('[data-testid="plugin-update-selected"]').trigger('click')

    const action = wrapper.emitted('run-action')?.[0]?.[0]
    expect(action).toMatchObject({
      id: 'update-plugins',
      showProgress: true,
      cancellable: false,
      data: { pluginIds: ['ExampleNode'] }
    })

    const children = [...wrapper.get('.plugin-updates').element.children]
    const actionsIndex = children.findIndex((element) =>
      element.matches('[data-testid="plugin-update-actions"]')
    )
    const listIndex = children.findIndex((element) => element.matches('.plugin-updates__list'))
    expect(actionsIndex).toBeGreaterThan(-1)
    expect(actionsIndex).toBeLessThan(listIndex)
  })

  it('offers a visible per-plugin update button without requiring checkbox selection', async () => {
    installApi(inventory())
    const wrapper = mountPane()
    await flushPromises()

    await wrapper.get('[data-testid="plugin-update-now-ExampleNode"]').trigger('click')

    expect(wrapper.emitted('run-action')?.[0]?.[0]).toMatchObject({
      id: 'update-plugins',
      data: { pluginIds: ['ExampleNode'] }
    })
  })

  it('shows the main-process read-only reason and exposes no update action', async () => {
    installApi(inventory(false))
    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.find('.plugin-updates__readonly').text()).toContain('Stable is read-only.')
    expect(wrapper.find('[data-testid="plugin-update-selected"]').exists()).toBe(false)
  })

  it('renders a Manager CNR package with installed and latest versions', async () => {
    const value = inventory()
    value.items[0] = {
      ...value.items[0]!,
      id: 'comfyui_essentials',
      dirName: 'comfyui_essentials',
      sourceType: 'cnr',
      repository: 'https://github.com/cubiq/ComfyUI_essentials',
      branch: null,
      upstream: null,
      localCommit: null,
      remoteCommit: null,
      installedVersion: '1.0.0',
      latestVersion: '1.1.0',
      behind: 1
    }
    installApi(value)
    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.find('.plugin-row__meta').text()).toContain('Manager package')
    expect(wrapper.find('.plugin-row__meta').text()).toContain('1.0.0 → 1.1.0')
    expect(wrapper.find('.plugin-row__status').text()).toContain('Update available')
  })

  it('paints local state first and then refreshes remote metadata in the background', async () => {
    installApi(inventory())
    mountPane()
    await flushPromises()

    expect(window.api.getPluginUpdates).toHaveBeenNthCalledWith(1, 'inst-1', false)
    expect(window.api.getPluginUpdates).toHaveBeenNthCalledWith(2, 'inst-1', true)
  })

  it('expands update details and shows the last per-plugin result', async () => {
    const value = inventory()
    value.lastRun = {
      completedAt: '2026-09-27T01:00:00.000Z',
      ok: true,
      items: [
        {
          id: 'ExampleNode',
          dirName: 'ExampleNode',
          sourceType: 'git',
          from: '1111111111111111111111111111111111111111',
          to: '2222222222222222222222222222222222222222',
          status: 'updated',
          message: 'Manager v4 update completed.'
        }
      ]
    }
    installApi(value)
    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.find('.plugin-updates__last-run').text()).toContain('ExampleNode')
    expect(wrapper.find('.plugin-updates__last-run').text()).toContain('Updated')
    await wrapper.get('.plugin-row__details-toggle').trigger('click')
    expect(wrapper.find('.plugin-row__details').text()).toContain('Git repository')
    expect(wrapper.find('.plugin-row__details').text()).toContain('Updated')
  })

  it('keeps a compiled plugin out of the standard batch and exposes a separate compatible update', async () => {
    const value = inventory()
    value.items[0] = {
      ...value.items[0]!,
      updateable: false,
      hasCompiledDependencies: true,
      reasonCode: 'compiled-dependencies',
      reason: 'Compiled dependencies require a compatibility update.'
    }
    installApi(value)
    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.get('.plugin-row > input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="plugin-update-actions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plugin-update-now-ExampleNode"]').exists()).toBe(false)

    await wrapper.get('[data-testid="plugin-compatibility-check-ExampleNode"]').trigger('click')
    await flushPromises()

    expect(window.api.getPluginCompatibilityPlan).toHaveBeenCalledWith(
      'inst-1',
      'ExampleNode',
      true
    )
    expect(wrapper.get('[data-testid="plugin-compatibility-report-ExampleNode"]').text()).toContain(
      'Compatibility passed'
    )
    await wrapper.get('[data-testid="plugin-compatibility-execute-ExampleNode"]').trigger('click')

    expect(wrapper.emitted('run-action')?.at(-1)?.[0]).toMatchObject({
      id: 'update-plugin-compatible',
      data: {
        dirName: 'ExampleNode',
        targetCommit: '2222222222222222222222222222222222222222',
        planDigest: 'b'.repeat(64)
      }
    })
  })
})
