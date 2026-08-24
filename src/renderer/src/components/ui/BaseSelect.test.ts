import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import BaseSelect from './BaseSelect.vue'

const wrappers: VueWrapper[] = []
const originalInnerHeight = window.innerHeight

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 20,
    right: 220,
    width: 200,
    height: bottom - top,
    x: 20,
    y: top,
    toJSON: () => ({})
  }
}

function mountSelect(options = ['One', 'Two', 'Three']): VueWrapper {
  const wrapper = mount(BaseSelect, {
    props: {
      modelValue: 'One',
      options: options.map((label) => ({ value: label, label })),
      ariaLabel: 'Test select'
    },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  document.querySelectorAll('.ui-select-listbox').forEach((element) => element.remove())
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  vi.restoreAllMocks()
})

describe('BaseSelect positioning', () => {
  it('uses the rendered list height to flip a dropdown above the trigger', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 380 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList.contains('ui-select-trigger') ? rect(200, 240) : rect(0, 0)
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('ui-select-listbox') ? 170 : 0
    })

    const wrapper = mountSelect()
    await wrapper.get('.ui-select-trigger').trigger('click')
    await flushPromises()

    const listbox = document.querySelector<HTMLElement>('.ui-select-listbox')
    expect(listbox).not.toBeNull()
    expect(listbox!.style.top).toBe('auto')
    expect(listbox!.style.bottom).toBe('182px')
    expect(listbox!.style.maxHeight).toBe('190px')
  })

  it('clamps a dropdown to the available space on its chosen side', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 160 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList.contains('ui-select-trigger') ? rect(30, 70) : rect(0, 0)
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('ui-select-listbox') ? 200 : 0
    })

    const wrapper = mountSelect(['One', 'Two', 'Three', 'Four', 'Five'])
    await wrapper.get('.ui-select-trigger').trigger('click')
    await flushPromises()

    const listbox = document.querySelector<HTMLElement>('.ui-select-listbox')
    expect(listbox).not.toBeNull()
    expect(listbox!.style.top).toBe('72px')
    expect(listbox!.style.bottom).toBe('auto')
    expect(listbox!.style.maxHeight).toBe('80px')
  })
})

describe('BaseSelect search', () => {
  it('shows the configured recent limit, then searches across the full option list', async () => {
    const options = Array.from({ length: 30 }, (_, index) => `v0.1.${29 - index}`)
    const wrapper = mount(BaseSelect, {
      props: {
        modelValue: '',
        options: options.map((label) => ({ value: label, label })),
        ariaLabel: 'Version',
        searchable: true,
        searchPlaceholder: 'Search versions',
        maxVisibleOptions: 20
      },
      attachTo: document.body
    })
    wrappers.push(wrapper)

    await wrapper.get('.ui-select-trigger').trigger('click')
    await flushPromises()
    expect(document.querySelectorAll('.ui-select-option')).toHaveLength(20)

    const input = document.querySelector<HTMLInputElement>('.ui-select-search')!
    input.value = 'v0.1.3'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const labels = [...document.querySelectorAll('.ui-select-option-label')].map(
      (node) => node.textContent
    )
    expect(labels).toEqual(['v0.1.3'])
  })
})
