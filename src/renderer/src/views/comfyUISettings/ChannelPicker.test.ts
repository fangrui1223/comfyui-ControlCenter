import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import { en } from '../../lib/i18nMessages.ts'
import ChannelPicker from './ChannelPicker.vue'
import type { DetailField } from '../../types/ipc'

const openExternalMock = vi.fn()
const getStableTagsMock = vi.fn()
const getComfyUIReleaseMock = vi.fn()
const getComfyUIDevelopmentRevisionsMock = vi.fn()

beforeEach(() => {
  openExternalMock.mockReset()
  getStableTagsMock.mockReset().mockResolvedValue([])
  getComfyUIReleaseMock.mockReset().mockResolvedValue(null)
  getComfyUIDevelopmentRevisionsMock.mockReset().mockResolvedValue([])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      openExternal: openExternalMock,
      getStableTags: getStableTagsMock,
      getComfyUIRelease: getComfyUIReleaseMock,
      getComfyUIDevelopmentRevisions: getComfyUIDevelopmentRevisionsMock
    }
  })
})

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function mountPicker(field: DetailField) {
  return mount(ChannelPicker, {
    props: { field },
    global: {
      plugins: [makeI18n()],
      stubs: {
        // Teleports its listbox to <body>; the headline under test doesn't need it.
        BaseSelect: true,
        InfoTooltip: true
      }
    }
  })
}

function field(options: DetailField['options'], value = 'stable'): DetailField {
  return {
    id: 'updateChannel',
    label: 'Update channel',
    value,
    editable: true,
    editType: 'channel-cards',
    options
  } as DetailField
}

describe('ChannelPicker — headline product + version', () => {
  it('shows the product name and the target version when an update is available', () => {
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.3.75',
            latestVersion: 'v0.28.3',
            updateAvailable: true
          }
        }
      ])
    )
    expect(wrapper.find('.channel-picker-headline-product').text()).toBe('ComfyUI')
    const version = wrapper.find('.channel-picker-headline-version')
    expect(version.text()).toBe('v0.28.3')
    expect(version.classes()).toContain('is-update-available')
  })

  it('preserves the torch local tag (+cu130) in the PyTorch headline', () => {
    const wrapper = mountPicker(
      field(
        [
          {
            value: 'stack-cu130',
            label: 'PyTorch 2.10.0+cu130',
            data: {
              productName: 'PyTorch',
              installedVersion: '2.9.0+cu130',
              latestVersion: '2.10.0+cu130',
              updateAvailable: true
            }
          }
        ],
        'stack-cu130'
      )
    )
    expect(wrapper.find('.channel-picker-headline-product').text()).toBe('PyTorch')
    const version = wrapper.find('.channel-picker-headline-version')
    expect(version.text()).toBe('v2.10.0+cu130')
    expect(version.classes()).toContain('is-update-available')
  })

  it('shows the installed version without update emphasis when up to date', () => {
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'PyTorch',
            installedVersion: '2.9.0+cu130',
            updateAvailable: false
          }
        }
      ])
    )
    expect(wrapper.find('.channel-picker-headline-product').text()).toBe('PyTorch')
    const version = wrapper.find('.channel-picker-headline-version')
    expect(version.text()).toBe('v2.9.0+cu130')
    expect(version.classes()).not.toContain('is-update-available')
  })

  it('shows the "Up to date" badge for cards without the opt-out (ComfyUI)', () => {
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.3.75',
            latestVersion: 'v0.3.75',
            updateAvailable: false
          }
        }
      ])
    )
    expect(wrapper.find('.channel-picker-badge').text()).toBe('Up to date')
  })

  it('hides the "Up to date" badge when the card opts out (PyTorch current stack)', () => {
    const wrapper = mountPicker(
      field(
        [
          {
            value: 'stack-cu130',
            label: 'PyTorch 2.10.0+cu130',
            data: {
              productName: 'PyTorch',
              installedVersion: '2.10.0+cu130',
              updateAvailable: false,
              hideUpToDateBadge: true
            }
          }
        ],
        'stack-cu130'
      )
    )
    expect(wrapper.find('.channel-picker-badge').exists()).toBe(false)
  })

  it('still shows the "Update available" badge when the opt-out card has an update', () => {
    const wrapper = mountPicker(
      field(
        [
          {
            value: 'stack-cu130',
            label: 'PyTorch 2.11.0+cu130',
            data: {
              productName: 'PyTorch',
              installedVersion: '2.10.0+cu130',
              latestVersion: '2.11.0+cu130',
              updateAvailable: true,
              hideUpToDateBadge: true
            }
          }
        ],
        'stack-cu130'
      )
    )
    expect(wrapper.find('.channel-picker-badge').text()).toBe('Update available')
  })

  it('renders no product span when the card data carries no productName', () => {
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            installedVersion: 'v0.3.75',
            latestVersion: 'v0.3.75',
            updateAvailable: false
          }
        }
      ])
    )
    expect(wrapper.find('.channel-picker-headline-product').exists()).toBe(false)
    expect(wrapper.find('.channel-picker-headline-version').text()).toBe('v0.3.75')
  })
})

describe('ChannelPicker — release notes', () => {
  it('shows a collapsed summary and lets the user expand and collapse long notes', async () => {
    const notes = `${'A useful change. '.repeat(55)}TAIL-MARKER`
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.18.2',
            latestVersion: 'v0.18.3',
            updateAvailable: true,
            showReleaseInfo: true,
            releaseNotes: notes,
            publishedAt: '2026-08-17T08:00:00Z'
          }
        }
      ])
    )

    const panel = wrapper.find('.channel-picker-release')
    expect(panel.exists()).toBe(true)
    expect(panel.find('.channel-picker-release-header').text()).toContain('What changed')
    expect(panel.find('.channel-picker-release-header').text()).toContain('Published')
    expect(panel.find('.channel-picker-release-header').text()).toMatch(/\d{1,2}:\d{2}/)
    expect(panel.find('.channel-picker-release-notes').text()).not.toContain('TAIL-MARKER')

    const toggle = panel.find('.channel-picker-release-action')
    expect(toggle.text()).toBe('Show more')
    await toggle.trigger('click')
    expect(panel.find('.channel-picker-release-notes').text()).toContain('TAIL-MARKER')
    expect(toggle.text()).toBe('Show less')

    await toggle.trigger('click')
    expect(panel.find('.channel-picker-release-notes').text()).not.toContain('TAIL-MARKER')
  })

  it('opens the full release page through the system browser bridge', async () => {
    const releaseUrl = 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.18.3'
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.18.2',
            latestVersion: 'v0.18.3',
            updateAvailable: true,
            showReleaseInfo: true,
            releaseNotes: 'Added useful things.',
            releaseUrl
          }
        }
      ])
    )

    await wrapper.find('.channel-picker-release-action.is-link').trigger('click')

    expect(openExternalMock).toHaveBeenCalledOnce()
    expect(openExternalMock).toHaveBeenCalledWith(releaseUrl)
  })

  it('shows an explicit fallback when upstream supplied no notes', () => {
    const wrapper = mountPicker(
      field(
        [
          {
            value: 'latest',
            label: 'Latest',
            data: {
              productName: 'ComfyUI',
              installedVersion: 'v0.18.2',
              latestVersion: 'v0.18.3 + 2 commits',
              updateAvailable: true,
              showReleaseInfo: true,
              releaseUrl: 'https://github.com/Comfy-Org/ComfyUI/commit/abc1234'
            }
          }
        ],
        'latest'
      )
    )

    expect(wrapper.find('.channel-picker-release-empty').text()).toContain(
      'Upstream did not provide release notes'
    )
  })

  it('renders release content as text instead of executing upstream HTML', () => {
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.18.2',
            latestVersion: 'v0.18.3',
            updateAvailable: true,
            showReleaseInfo: true,
            releaseNotes: '<script>window.compromised = true</script>'
          }
        }
      ])
    )

    expect(wrapper.find('.channel-picker-release-notes').text()).toContain('<script>')
    expect(wrapper.find('.channel-picker-release script').exists()).toBe(false)
  })

  it('does not show the panel for other channel-card consumers', () => {
    const wrapper = mountPicker(
      field(
        [
          {
            value: 'stack-cu130',
            label: 'PyTorch 2.10.0+cu130',
            data: {
              productName: 'PyTorch',
              installedVersion: '2.9.0+cu130',
              latestVersion: '2.10.0+cu130',
              updateAvailable: true
            }
          }
        ],
        'stack-cu130'
      )
    )

    expect(wrapper.find('.channel-picker-release').exists()).toBe(false)
  })

  it('does not show stale release notes when no update is available', () => {
    const wrapper = mountPicker(
      field([
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.18.3',
            latestVersion: 'v0.18.3',
            updateAvailable: false,
            showReleaseInfo: true,
            releaseNotes: 'Old cached notes'
          }
        }
      ])
    )

    expect(wrapper.find('.channel-picker-release').exists()).toBe(false)
  })
})

describe('ChannelPicker — explicit version targets', () => {
  const newestSha = 'a'.repeat(40)
  const installedSha = 'b'.repeat(40)
  const middleSha = 'd'.repeat(40)

  function versionField(value: 'stable' | 'latest'): DetailField {
    return field(
      [
        {
          value: 'stable',
          label: 'Stable',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.18.2 + 3 commits',
            latestVersion: 'v0.18.3',
            updateAvailable: true,
            showVersionPicker: true,
            installationId: 'inst-next',
            latestCommit: newestSha,
            installedBaseTag: 'v0.18.2',
            installedCommitsAhead: value === 'stable' ? 0 : 3,
            installedCommit: installedSha
          }
        },
        {
          value: 'latest',
          label: 'Development',
          data: {
            productName: 'ComfyUI',
            installedVersion: 'v0.18.2 + 3 commits',
            latestVersion: 'v0.18.3 + 5 commits',
            updateAvailable: true,
            showReleaseInfo: true,
            showVersionPicker: true,
            installationId: 'inst-next',
            latestCommit: newestSha,
            installedBaseTag: 'v0.18.2',
            installedCommitsAhead: 3,
            installedCommit: installedSha
          }
        }
      ],
      value
    )
  }

  function versionSelect(wrapper: ReturnType<typeof mountPicker>) {
    const all = wrapper.findAllComponents({ name: 'BaseSelect' })
    return all[all.length - 1]
  }

  it('shows only stable tags on the stable page', async () => {
    getStableTagsMock.mockResolvedValue(['v0.18.3', 'v0.18.2', 'v0.18.1'])
    const wrapper = mountPicker(versionField('stable'))
    await flushPromises()

    const options = versionSelect(wrapper).props('options') as Array<{ value: string }>
    expect(options.map((option) => option.value)).toEqual(['v0.18.3', 'v0.18.2', 'v0.18.1'])
    expect(getStableTagsMock).toHaveBeenCalledOnce()
    expect(getComfyUIDevelopmentRevisionsMock).not.toHaveBeenCalled()
  })

  it('shows master commits in development order without mixing in formal tags', async () => {
    getComfyUIDevelopmentRevisionsMock.mockResolvedValue([
      {
        sha: newestSha,
        shortSha: newestSha.slice(0, 7),
        title: 'Newest master change',
        url: `https://github.com/Comfy-Org/ComfyUI/commit/${newestSha}`,
        committedAt: '2026-08-18T10:00:00Z'
      },
      {
        sha: middleSha,
        shortSha: middleSha.slice(0, 7),
        title: 'Middle master change',
        url: `https://github.com/Comfy-Org/ComfyUI/commit/${middleSha}`,
        committedAt: '2026-08-18T09:00:00Z'
      },
      {
        sha: installedSha,
        shortSha: installedSha.slice(0, 7),
        title: 'Previous master change',
        url: `https://github.com/Comfy-Org/ComfyUI/commit/${installedSha}`,
        committedAt: '2026-08-18T08:00:00Z'
      }
    ])
    const wrapper = mountPicker(versionField('latest'))
    await flushPromises()

    const options = versionSelect(wrapper).props('options') as Array<{
      value: string
      label: string
    }>
    expect(options.map((option) => option.value)).toEqual([newestSha, middleSha, installedSha])
    expect(options[0].label).toContain('Newest master change')
    expect(options.every((option) => !option.value.startsWith('v'))).toBe(true)
    expect(getComfyUIDevelopmentRevisionsMock).toHaveBeenCalledWith('inst-next', newestSha)
    expect(getStableTagsMock).not.toHaveBeenCalled()
    expect(wrapper.find('.channel-picker-development-notes').text()).toContain(
      'aaaaaaa — Newest master change'
    )
    expect(wrapper.find('.channel-picker-development-notes').text()).toContain(
      'ddddddd — Middle master change'
    )
    expect(wrapper.find('.channel-picker-development-notes').text()).not.toContain(
      'Previous master change'
    )
    const updateDates = wrapper.findAll('.channel-picker-development-date')
    expect(updateDates).toHaveLength(2)
    expect(updateDates.map((date) => date.attributes('datetime'))).toEqual([
      '2026-08-18T10:00:00Z',
      '2026-08-18T09:00:00Z'
    ])
    expect(updateDates.every((date) => /\d{1,2}:\d{2}/.test(date.text()))).toBe(true)
  })

  it('passes the selected full development SHA to the update transaction', async () => {
    getComfyUIDevelopmentRevisionsMock.mockResolvedValue([
      {
        sha: newestSha,
        shortSha: newestSha.slice(0, 7),
        title: 'Newest master change',
        url: `https://github.com/Comfy-Org/ComfyUI/commit/${newestSha}`
      },
      {
        sha: installedSha,
        shortSha: installedSha.slice(0, 7),
        title: 'Installed master change',
        url: `https://github.com/Comfy-Org/ComfyUI/commit/${installedSha}`
      }
    ])
    const wrapper = mountPicker(versionField('latest'))
    await flushPromises()
    await versionSelect(wrapper).vm.$emit('update:modelValue', newestSha)
    await flushPromises()

    expect(wrapper.find('.channel-picker-direction').text()).toBe('Upgrade')
    await wrapper.find('[data-testid="update-action-update-comfyui"]').trigger('click')
    const action = wrapper.emitted('action')?.[0]?.[0] as {
      data: Record<string, unknown>
    }
    expect(action.data).toEqual({
      channel: 'latest',
      targetCommit: newestSha,
      isDowngrade: false
    })
  })

  it('keeps arbitrary commit entry in Advanced and validates a full SHA', async () => {
    const manualSha = 'c'.repeat(40)
    const wrapper = mountPicker(versionField('latest'))
    await flushPromises()

    const input = wrapper.get('.channel-picker-manual-commit-input')
    await input.setValue('abc1234')
    await wrapper.get('.channel-picker-manual-commit').trigger('submit')
    expect(wrapper.get('.channel-picker-manual-commit-error').text()).toContain('40-character')

    await input.setValue(manualSha)
    await wrapper.get('.channel-picker-manual-commit').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.channel-picker-manual-commit-error').exists()).toBe(false)
    expect(wrapper.find('.channel-picker-target-title').text()).toBe('Manual commit')

    await wrapper.find('[data-testid="update-action-update-comfyui"]').trigger('click')
    const action = wrapper.emitted('action')?.[0]?.[0] as {
      data: Record<string, unknown>
    }
    expect(action.data).toEqual({
      channel: 'latest',
      targetCommit: manualSha,
      isDowngrade: false
    })
  })

  it('loads release notes and marks an older formal target as a downgrade', async () => {
    getStableTagsMock.mockResolvedValue(['v0.18.3', 'v0.18.2', 'v0.18.1'])
    getComfyUIReleaseMock.mockResolvedValue({
      tag: 'v0.18.1',
      name: 'ComfyUI v0.18.1',
      notes: 'Historical notes',
      url: 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.18.1'
    })
    const wrapper = mountPicker(versionField('stable'))
    await flushPromises()
    await versionSelect(wrapper).vm.$emit('update:modelValue', 'v0.18.1')
    await flushPromises()

    expect(getComfyUIReleaseMock).toHaveBeenCalledWith('v0.18.1')
    expect(wrapper.find('.channel-picker-direction').text()).toBe('Downgrade')
    expect(wrapper.find('.channel-picker-release-notes').text()).toContain('Historical notes')
    await wrapper.find('[data-testid="update-action-update-comfyui"]').trigger('click')
    const action = wrapper.emitted('action')?.[0]?.[0] as {
      data: Record<string, unknown>
    }
    expect(action.data).toEqual({
      channel: 'stable',
      targetTag: 'v0.18.1',
      isDowngrade: true
    })
  })
})

describe('ChannelPicker — cascading group dropdowns', () => {
  const cu130 = { id: 'cu130', label: 'CUDA 13.0 (cu130)', description: 'Current stable CUDA line' }
  const cu128 = { id: 'cu128', label: 'CUDA 12.8 (cu128)' }

  function groupedField(value = 's-cu130-2.9'): DetailField {
    return {
      id: 'pytorchStack',
      label: 'PyTorch',
      value,
      editable: true,
      editType: 'channel-cards',
      groupLabels: ['Backend'],
      options: [
        {
          value: 's-cu130-2.10',
          label: 'PyTorch 2.10.0+cu130',
          groupPath: [cu130],
          data: {
            productName: 'PyTorch',
            installedVersion: '2.9.1+cu130',
            latestVersion: '2.10.0+cu130',
            updateAvailable: true
          }
        },
        {
          value: 's-cu130-2.9',
          label: 'PyTorch 2.9.1+cu130',
          groupPath: [cu130],
          data: { productName: 'PyTorch', installedVersion: '2.9.1+cu130', updateAvailable: false }
        },
        {
          value: 's-cu128-2.11',
          label: 'PyTorch 2.11.0+cu128',
          groupPath: [cu128],
          data: {
            productName: 'PyTorch',
            installedVersion: '2.9.1+cu130',
            latestVersion: '2.11.0+cu128',
            updateAvailable: true
          }
        }
      ]
    } as DetailField
  }

  function selects(wrapper: ReturnType<typeof mountPicker>) {
    return wrapper.findAllComponents({ name: 'BaseSelect' })
  }

  it('renders a single dropdown when options carry no groupPath (flat picker unchanged)', () => {
    const wrapper = mountPicker(
      field([
        { value: 'stable', label: 'Stable' },
        { value: 'latest', label: 'Latest' }
      ])
    )
    const all = selects(wrapper)
    expect(all).toHaveLength(1)
    expect((all[0].props('options') as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'stable',
      'latest'
    ])
  })

  it('renders one group dropdown per path level plus the concrete dropdown, following field.value', () => {
    const wrapper = mountPicker(groupedField())
    const all = selects(wrapper)
    expect(all).toHaveLength(2)
    // Group dropdown lists the unique series and follows the current value's path.
    expect(all[0].props('modelValue')).toBe('cu130')
    expect((all[0].props('options') as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'cu130',
      'cu128'
    ])
    // Concrete dropdown only shows the selected group's options.
    expect(all[1].props('modelValue')).toBe('s-cu130-2.9')
    expect((all[1].props('options') as Array<{ value: string }>).map((o) => o.value)).toEqual([
      's-cu130-2.10',
      's-cu130-2.9'
    ])
  })

  it('passes a group description through to the group dropdown, omitting absent ones', () => {
    const wrapper = mountPicker(groupedField())
    const groupOptions = selects(wrapper)[0].props('options') as Array<{
      value: string
      description?: string
    }>
    expect(groupOptions.find((o) => o.value === 'cu130')?.description).toBe(
      'Current stable CUDA line'
    )
    expect(groupOptions.find((o) => o.value === 'cu128')?.description).toBeUndefined()
  })

  it('selecting another group jumps to its first (newest) concrete option', async () => {
    const wrapper = mountPicker(groupedField())
    await selects(wrapper)[0].vm.$emit('update:modelValue', 'cu128')
    const all = selects(wrapper)
    expect(all[1].props('modelValue')).toBe('s-cu128-2.11')
    // Preview follows the concrete selection.
    expect(wrapper.find('.channel-picker-headline-version').text()).toBe('v2.11.0+cu128')
  })

  it('changing the concrete dropdown updates preview and actions to that exact option', async () => {
    const wrapper = mountPicker(groupedField())
    await selects(wrapper)[1].vm.$emit('update:modelValue', 's-cu130-2.10')
    expect(wrapper.find('.channel-picker-headline-version').text()).toBe('v2.10.0+cu130')
  })

  it('resynchronizes the cascade when the committed field value changes', async () => {
    const wrapper = mountPicker(groupedField())
    await wrapper.setProps({ field: groupedField('s-cu128-2.11') })
    const all = selects(wrapper)
    expect(all[0].props('modelValue')).toBe('cu128')
    expect(all[1].props('modelValue')).toBe('s-cu128-2.11')
  })

  it('keeps the cascade coherent when the field value matches no option', () => {
    // e.g. the draft's option vanished in an options refresh: every surface
    // (group dropdown, concrete dropdown, preview) must agree on the
    // fallback (first) option instead of showing a blank concrete select.
    const wrapper = mountPicker(groupedField('gone-stack'))
    const all = selects(wrapper)
    expect(all[0].props('modelValue')).toBe('cu130')
    expect(all[1].props('modelValue')).toBe('s-cu130-2.10')
    expect(wrapper.find('.channel-picker-headline-version').text()).toBe('v2.10.0+cu130')
  })

  it('falls back to the flat picker when paths are mixed (some options ungrouped)', () => {
    const f = groupedField()
    delete f.options![1].groupPath
    const wrapper = mountPicker(f)
    const all = selects(wrapper)
    expect(all).toHaveLength(1)
    expect((all[0].props('options') as Array<{ value: string }>).length).toBe(3)
  })

  it('supports arbitrary nesting depth with prefix-filtered levels', async () => {
    const wrapper = mountPicker({
      id: 'pytorchStack',
      label: 'PyTorch',
      value: 'a1',
      editable: true,
      editType: 'channel-cards',
      groupLabels: ['Vendor', 'Series'],
      options: [
        { value: 'a1', label: 'A1', groupPath: [{ id: 'nv', label: 'NVIDIA' }, cu130] },
        { value: 'a2', label: 'A2', groupPath: [{ id: 'nv', label: 'NVIDIA' }, cu128] },
        {
          value: 'b1',
          label: 'B1',
          groupPath: [
            { id: 'amd', label: 'AMD' },
            { id: 'rocm7', label: 'ROCm 7' }
          ]
        }
      ]
    } as DetailField)
    const all = selects(wrapper)
    expect(all).toHaveLength(3)
    expect((all[0].props('options') as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'nv',
      'amd'
    ])
    // Second level only shows series under the selected vendor.
    expect((all[1].props('options') as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'cu130',
      'cu128'
    ])
    // Switching the outermost level cascades to a concrete option.
    await all[0].vm.$emit('update:modelValue', 'amd')
    const after = selects(wrapper)
    expect(after[1].props('modelValue')).toBe('rocm7')
    expect(after[2].props('modelValue')).toBe('b1')
  })
})

describe('ChannelPicker - change-pytorch footer action', () => {
  const changeAction = {
    id: 'change-pytorch',
    label: 'Change PyTorch',
    style: 'primary',
    enabled: true,
    data: { stackId: 's-cpu-2.11' }
  }
  const copyChangeAction = {
    id: 'copy-pytorch',
    label: 'Copy & Change PyTorch',
    style: 'default',
    enabled: true,
    data: { stackId: 's-cpu-2.11' }
  }

  function pytorchField(value: string): DetailField {
    return {
      id: 'pytorchStack',
      label: 'PyTorch',
      value,
      editable: true,
      editType: 'channel-cards',
      options: [
        {
          value: 's-cpu-2.10',
          label: 'PyTorch 2.10.0+cpu',
          data: { productName: 'PyTorch', installedVersion: '2.10.0+cpu', updateAvailable: false }
        },
        {
          value: 's-cpu-2.11',
          label: 'PyTorch 2.11.0+cpu',
          data: {
            productName: 'PyTorch',
            installedVersion: '2.10.0+cpu',
            latestVersion: '2.11.0+cpu',
            updateAvailable: true,
            actions: [changeAction, copyChangeAction]
          }
        }
      ]
    } as DetailField
  }

  it("renders the selected option's change-pytorch action as an accent footer button", () => {
    const wrapper = mountPicker(pytorchField('s-cpu-2.11'))
    const button = wrapper.find('[data-testid="update-action-change-pytorch"]')
    expect(button.exists()).toBe(true)
    expect(button.classes()).toContain('accent')
    expect(button.text()).toContain('Change PyTorch')
  })

  it('renders no change-pytorch button while the current stack is selected', () => {
    const wrapper = mountPicker(pytorchField('s-cpu-2.10'))
    expect(wrapper.find('[data-testid="update-action-change-pytorch"]').exists()).toBe(false)
  })

  it('emits the action when the change-pytorch button is clicked', async () => {
    const wrapper = mountPicker(pytorchField('s-cpu-2.11'))
    await wrapper.find('[data-testid="update-action-change-pytorch"]').trigger('click')
    const emitted = wrapper.emitted('action')
    expect(emitted).toHaveLength(1)
    expect((emitted![0]![0] as { id: string }).id).toBe('change-pytorch')
  })

  it('renders copy-pytorch as a default footer button before the accented change button', () => {
    const wrapper = mountPicker(pytorchField('s-cpu-2.11'))
    const copyButton = wrapper.find('[data-testid="update-action-copy-pytorch"]')
    expect(copyButton.exists()).toBe(true)
    expect(copyButton.classes()).not.toContain('accent')
    expect(copyButton.text()).toContain('Copy & Change PyTorch')
    // Safe alternative sits before the primary action, mirroring Copy & Update.
    const ids = wrapper
      .findAll('[data-testid^="update-action-"]')
      .map((b) => b.attributes('data-testid'))
    expect(ids.indexOf('update-action-copy-pytorch')).toBeLessThan(
      ids.indexOf('update-action-change-pytorch')
    )
  })

  it('renders no copy-pytorch button while the current stack is selected', () => {
    const wrapper = mountPicker(pytorchField('s-cpu-2.10'))
    expect(wrapper.find('[data-testid="update-action-copy-pytorch"]').exists()).toBe(false)
  })

  it('emits the action when the copy-pytorch button is clicked', async () => {
    const wrapper = mountPicker(pytorchField('s-cpu-2.11'))
    await wrapper.find('[data-testid="update-action-copy-pytorch"]').trigger('click')
    const emitted = wrapper.emitted('action')
    expect(emitted).toHaveLength(1)
    expect((emitted![0]![0] as { id: string }).id).toBe('copy-pytorch')
  })
})
