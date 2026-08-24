<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

// Custom select primitive: trigger + popover listbox, teleported to <body>
// so a drawer host's overflow:hidden can't clip it.

export interface BaseSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface Props {
  modelValue: string
  options: BaseSelectOption[]
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  emptyLabel?: string
  /** Limits the unfiltered list (for example, 20 recent releases). Search
   * still examines every option and then caps the matching result. */
  maxVisibleOptions?: number
}

const props = withDefaults(defineProps<Props>(), {
  ariaLabel: undefined,
  placeholder: '',
  disabled: false,
  searchable: false,
  searchPlaceholder: '',
  emptyLabel: 'No matching options',
  maxVisibleOptions: undefined
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const triggerRef = ref<HTMLButtonElement | null>(null)
const listboxRef = ref<HTMLUListElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const searchQuery = ref('')
const popoverStyle = ref<Record<string, string>>({})

const selectedOption = computed(() => props.options.find((o) => o.value === props.modelValue))

const triggerLabel = computed(() => selectedOption.value?.label ?? props.placeholder)

const visibleOptions = computed(() => {
  const limit = props.maxVisibleOptions
  const query = searchQuery.value.trim().toLowerCase()
  const matches = query
    ? props.options.filter(
        (option) =>
          option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)
      )
    : props.options
  if (!limit || limit <= 0 || matches.length <= limit) return matches
  const sliced = matches.slice(0, limit)
  // Keep an already-selected older result visible when reopening the picker.
  if (!query && selectedOption.value && !sliced.some((o) => o.value === props.modelValue)) {
    return [...sliced.slice(0, Math.max(0, limit - 1)), selectedOption.value]
  }
  return sliced
})

const listboxId = `ui-listbox-${Math.random().toString(36).slice(2, 9)}`
const POPOVER_GAP = 2
const VIEWPORT_PADDING = 8
const ESTIMATED_OPTION_HEIGHT = 36
const ESTIMATED_LISTBOX_CHROME = 16
const PREFERRED_MAX_HEIGHT = 280

function updatePosition(): void {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - POPOVER_GAP - VIEWPORT_PADDING)
  const spaceAbove = Math.max(0, rect.top - POPOVER_GAP - VIEWPORT_PADDING)
  const estimatedHeight =
    (visibleOptions.value.length + (props.searchable ? 1 : 0)) * ESTIMATED_OPTION_HEIGHT +
    ESTIMATED_LISTBOX_CHROME
  const measuredHeight = listboxRef.value
    ? listboxRef.value.scrollHeight +
      Math.max(0, listboxRef.value.offsetHeight - listboxRef.value.clientHeight)
    : 0
  const desiredHeight = Math.min(measuredHeight || estimatedHeight, PREFERRED_MAX_HEIGHT)
  const openUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow
  const availableHeight = openUp ? spaceAbove : spaceBelow
  popoverStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    top: openUp ? 'auto' : `${rect.bottom + POPOVER_GAP}px`,
    bottom: openUp ? `${window.innerHeight - rect.top + POPOVER_GAP}px` : 'auto',
    maxHeight: `${availableHeight}px`,
    zIndex: '9999'
  }
}

function openPanel(): void {
  if (open.value || props.disabled) return
  searchQuery.value = ''
  open.value = true
  const idx = visibleOptions.value.findIndex((o) => o.value === props.modelValue && !o.disabled)
  activeIndex.value = idx >= 0 ? idx : visibleOptions.value.findIndex((o) => !o.disabled)
  updatePosition()
  void nextTick(() => {
    // The rendered list may be taller than the per-option estimate.
    updatePosition()
    if (props.searchable) searchRef.value?.focus()
    else listboxRef.value?.focus()
    scrollActiveIntoView()
  })
}

function closePanel(returnFocus = true): void {
  if (!open.value) return
  open.value = false
  if (returnFocus) {
    void nextTick(() => triggerRef.value?.focus())
  }
}

function toggle(): void {
  if (open.value) closePanel()
  else openPanel()
}

function selectIndex(i: number): void {
  const opt = visibleOptions.value[i]
  if (!opt || opt.disabled) return
  emit('update:modelValue', opt.value)
  closePanel()
}

function moveActive(delta: number): void {
  const len = visibleOptions.value.length
  if (len === 0) return
  let i = activeIndex.value
  for (let step = 0; step < len; step++) {
    i = (i + delta + len) % len
    if (!visibleOptions.value[i]?.disabled) {
      activeIndex.value = i
      scrollActiveIntoView()
      return
    }
  }
}

function scrollActiveIntoView(): void {
  const list = listboxRef.value
  if (!list) return
  const el = list.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (
    event.key === 'ArrowDown' ||
    event.key === 'ArrowUp' ||
    event.key === 'Enter' ||
    event.key === ' '
  ) {
    event.preventDefault()
    openPanel()
  }
}

function onListboxKeydown(event: KeyboardEvent): void {
  const fromSearch = event.target === searchRef.value
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveActive(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveActive(-1)
      break
    case 'Home':
      if (fromSearch) return
      event.preventDefault()
      activeIndex.value = visibleOptions.value.findIndex((o) => !o.disabled)
      scrollActiveIntoView()
      break
    case 'End':
      if (fromSearch) return
      event.preventDefault()
      for (let i = visibleOptions.value.length - 1; i >= 0; i--) {
        if (!visibleOptions.value[i]?.disabled) {
          activeIndex.value = i
          scrollActiveIntoView()
          break
        }
      }
      break
    case 'Enter':
    case ' ':
      if (fromSearch) return
      event.preventDefault()
      if (activeIndex.value >= 0) selectIndex(activeIndex.value)
      break
    case 'Escape':
      event.preventDefault()
      closePanel()
      break
    case 'Tab':
      closePanel(false)
      break
  }
}

watch(searchQuery, () => {
  activeIndex.value = visibleOptions.value.findIndex((option) => !option.disabled)
  void nextTick(updatePosition)
})

function onDocPointer(event: PointerEvent): void {
  if (!open.value) return
  const t = event.target as Node | null
  if (t && !triggerRef.value?.contains(t) && !listboxRef.value?.contains(t)) {
    closePanel(false)
  }
}

function onWindowChange(): void {
  if (open.value) updatePosition()
}

function onWindowBlur(): void {
  // Close on focus loss to another window (e.g. clicking out of the IPP).
  // The document `pointerdown` listener doesn't catch that because the
  // click lands in a different WebContents — the dropdown would otherwise
  // stay open and resurface when the user returns.
  if (open.value) closePanel(false)
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('resize', onWindowChange)
    window.addEventListener('scroll', onWindowChange, true)
    window.addEventListener('blur', onWindowBlur)
  } else {
    document.removeEventListener('pointerdown', onDocPointer, true)
    window.removeEventListener('resize', onWindowChange)
    window.removeEventListener('scroll', onWindowChange, true)
    window.removeEventListener('blur', onWindowBlur)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('scroll', onWindowChange, true)
})
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="ui-select-trigger"
    role="combobox"
    :aria-expanded="open"
    :aria-controls="listboxId"
    aria-haspopup="listbox"
    :aria-label="ariaLabel"
    :data-placeholder="!selectedOption ? '' : undefined"
    :disabled="disabled"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <span class="ui-select-label">{{ triggerLabel }}</span>
    <ChevronDown :size="14" class="ui-select-chevron" :data-open="open ? '' : undefined" />
  </button>

  <Teleport to="body">
    <Transition name="ui-select-pop">
      <ul
        v-if="open"
        :id="listboxId"
        ref="listboxRef"
        class="ui-select-listbox"
        role="listbox"
        tabindex="-1"
        :style="popoverStyle"
        :aria-label="ariaLabel"
        @keydown="onListboxKeydown"
      >
        <li v-if="searchable" class="ui-select-search-row" role="presentation">
          <input
            ref="searchRef"
            v-model="searchQuery"
            type="search"
            class="ui-select-search"
            :placeholder="searchPlaceholder"
            :aria-label="searchPlaceholder || ariaLabel"
            autocomplete="off"
          />
        </li>
        <li
          v-for="(opt, i) in visibleOptions"
          :key="opt.value"
          class="ui-select-option"
          role="option"
          :data-index="i"
          :data-active="i === activeIndex ? '' : undefined"
          :data-selected="opt.value === modelValue ? '' : undefined"
          :aria-selected="opt.value === modelValue"
          :aria-disabled="opt.disabled || undefined"
          @mousemove="activeIndex = i"
          @click="selectIndex(i)"
        >
          <span class="ui-select-option-body">
            <span class="ui-select-option-label">{{ opt.label }}</span>
            <span v-if="opt.description" class="ui-select-option-desc">{{ opt.description }}</span>
          </span>
          <Check v-if="opt.value === modelValue" :size="14" class="ui-select-option-check" />
        </li>
        <li v-if="visibleOptions.length === 0" class="ui-select-empty" role="presentation">
          {{ emptyLabel }}
        </li>
      </ul>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  color: var(--neutral-100);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}

.ui-select-trigger:hover:not(:disabled) {
  border-color: var(--border-hover);
  background: color-mix(in srgb, var(--neutral-100) 4%, var(--neutral-800));
}

.ui-select-trigger:focus-visible {
  outline: none;
  border-color: var(--accent-primary);
}

.ui-select-trigger[aria-expanded='true'] {
  border-color: var(--accent-primary);
}

.ui-select-trigger[data-placeholder] .ui-select-label {
  color: var(--text-muted);
}

.ui-select-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.ui-select-chevron[data-open] {
  transform: rotate(180deg);
}

.ui-select-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>

<style>
/* Listbox is teleported to <body>, so it can't be scoped. */
.ui-select-listbox {
  box-sizing: border-box;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.28),
    0 2px 6px rgba(0, 0, 0, 0.18);
  overflow-y: auto;
  outline: none;
}

.ui-select-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  user-select: none;
}

.ui-select-option[data-active] {
  background: var(--border-hover);
}

.ui-select-option[data-selected] {
  color: var(--text);
}

.ui-select-option[aria-disabled='true'] {
  color: var(--text-muted);
  cursor: not-allowed;
}

.ui-select-option-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ui-select-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select-option-desc {
  color: var(--text-muted);
  font-size: var(--takeover-fs-caption);
  white-space: normal;
  overflow-wrap: break-word;
}

.ui-select-option-check {
  flex-shrink: 0;
  color: var(--accent-primary);
}

.ui-select-search-row {
  padding: 4px;
}

.ui-select-search {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 8px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 6px;
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  font: inherit;
  font-size: 13px;
  outline: none;
}

.ui-select-search:focus {
  border-color: var(--accent-primary);
}

.ui-select-empty {
  padding: 10px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.ui-select-pop-enter-active,
.ui-select-pop-leave-active {
  transition:
    opacity 150ms ease-out,
    transform 150ms ease-out;
}

.ui-select-pop-enter-from,
.ui-select-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .ui-select-chevron,
  .ui-select-pop-enter-active,
  .ui-select-pop-leave-active {
    transition-duration: 0ms;
  }
}
</style>
