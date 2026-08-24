<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import InfoTooltip from '../../components/InfoTooltip.vue'
import VersionStatPanel, { type VersionStatRow } from './VersionStatPanel.vue'
import { formatRelativeFromMs } from '../../lib/datetime'
import type {
  ActionDef,
  ComfyUIDevelopmentRevision,
  ComfyUIReleaseInfo,
  DetailField,
  DetailFieldOption
} from '../../types/ipc'
import { TID } from '../../../../shared/testIds'

const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/

interface Props {
  field: DetailField
  sectionActions?: ActionDef[]
  /** Inline-action busy set driving the per-button spinner + disabled state. */
  runningActionIds?: Set<string>
}

const props = withDefaults(defineProps<Props>(), {
  sectionActions: () => [],
  runningActionIds: () => new Set<string>()
})

const runningIdsSet = computed(() => props.runningActionIds ?? new Set<string>())
function isActionRunning(actionId: string): boolean {
  return runningIdsSet.value.has(actionId)
}

const emit = defineEmits<{
  action: [action: ActionDef]
}>()

const { t, d, locale } = useI18n()

const state = reactive({
  draft: '' as string
})

watch(
  () => props.field.value,
  (next) => {
    state.draft = String(next ?? '')
  },
  { immediate: true }
)

const currentValue = computed(() => String(props.field.value ?? ''))

// --- Cascading group dropdowns (generic, driven by `groupPath`) ---
// Options sharing a path prefix sit behind one dropdown per level (e.g.
// PyTorch backend series -> version). Every group selection maps to a
// concrete option so preview/actions always describe a real choice.

const groupDepth = computed(() => {
  let depth = 0
  for (const opt of props.field.options ?? []) {
    depth = Math.max(depth, opt.groupPath?.length ?? 0)
  }
  return depth
})

// Cascade only when every option carries a full-depth path; mixed or partial
// paths fall back to the flat picker so no option becomes unreachable.
const cascadeActive = computed(
  () =>
    groupDepth.value > 0 &&
    (props.field.options ?? []).every((o) => (o.groupPath?.length ?? 0) === groupDepth.value)
)

const selectedOption = computed<DetailFieldOption | undefined>(() => {
  const opts = props.field.options ?? []
  const exact = opts.find((o) => o.value === state.draft)
  // In cascade mode an unknown draft (e.g. the value vanished in an options
  // refresh) falls back to the first option so the group dropdowns, concrete
  // dropdown, preview, and actions all describe the same real choice; flat
  // mode keeps exact-match semantics.
  return exact ?? (cascadeActive.value ? opts[0] : undefined)
})

/** The value the concrete dropdown displays: the effective (possibly
 *  fallen-back) selection in cascade mode, the raw draft when flat. */
const concreteValue = computed(() =>
  cascadeActive.value ? (selectedOption.value?.value ?? state.draft) : state.draft
)

const selectedActions = computed<ActionDef[]>(() => {
  const data = selectedOption.value?.data as Record<string, unknown> | undefined
  return (data?.actions as ActionDef[] | undefined) ?? []
})

const draftIsCurrent = computed(() => concreteValue.value === currentValue.value)

interface PreviewData {
  /** What this card updates ("ComfyUI", "PyTorch"); keeps the headline
   *  self-identifying when the Update tab shows several update cards. */
  productName?: string
  installedVersion?: string
  latestVersion?: string
  /** Overrides the "Latest" stat-row label - e.g. the PyTorch card says
   *  "Selected" because the user may have picked a downgrade. */
  latestLabel?: string
  lastChecked?: string
  lastCheckedAt?: number
  updateAvailable?: boolean
  /** ComfyUI release metadata. `showReleaseInfo` keeps other channel-card
   * consumers (for example PyTorch) from inheriting this panel. */
  showReleaseInfo?: boolean
  releaseNotes?: string
  releaseUrl?: string
  publishedAt?: string
  showVersionPicker?: boolean
  installationId?: string
  latestCommit?: string
  installedBaseTag?: string
  installedCommitsAhead?: number
  installedCommit?: string
  /** Suppress the "Up to date" badge when there is no update. The PyTorch
   *  card sets this: other stacks are still selectable in the picker, so
   *  "Up to date" would wrongly imply nothing is available. */
  hideUpToDateBadge?: boolean
  /** True while `commitsAhead` is still being computed; drives the
   *  "Computing commits ahead…" hint so the label swap isn't a surprise. */
  enriching?: boolean
}

const preview = computed<PreviewData | null>(() => {
  const data = selectedOption.value?.data as PreviewData | undefined
  if (!data) return null
  return {
    productName: data.productName,
    installedVersion: data.installedVersion,
    latestVersion: data.latestVersion,
    latestLabel: data.latestLabel,
    lastChecked: data.lastChecked,
    lastCheckedAt: data.lastCheckedAt,
    updateAvailable: data.updateAvailable,
    showReleaseInfo: data.showReleaseInfo,
    releaseNotes: data.releaseNotes,
    releaseUrl: data.releaseUrl,
    publishedAt: data.publishedAt,
    showVersionPicker: data.showVersionPicker,
    installationId: data.installationId,
    latestCommit: data.latestCommit,
    installedBaseTag: data.installedBaseTag,
    installedCommitsAhead: data.installedCommitsAhead,
    installedCommit: data.installedCommit,
    hideUpToDateBadge: data.hideUpToDateBadge,
    enriching: data.enriching
  }
})

// Safety net: if the background `commitsAhead` enrichment never completes
// (offline / timeout), hide the hint after 10s so it doesn't hang forever.
const ENRICHING_HINT_MAX_MS = 10_000
const enrichingTimedOut = ref(false)
let enrichingTimer: ReturnType<typeof setTimeout> | null = null

function clearEnrichingTimer(): void {
  if (enrichingTimer !== null) {
    clearTimeout(enrichingTimer)
    enrichingTimer = null
  }
}

watch(
  () => preview.value?.enriching === true,
  (isEnriching) => {
    clearEnrichingTimer()
    if (!isEnriching) {
      enrichingTimedOut.value = false
      return
    }
    enrichingTimedOut.value = false
    enrichingTimer = setTimeout(() => {
      enrichingTimedOut.value = true
      enrichingTimer = null
    }, ENRICHING_HINT_MAX_MS)
  },
  { immediate: true }
)

onBeforeUnmount(clearEnrichingTimer)

const showEnrichingHint = computed(
  () => preview.value?.enriching === true && !enrichingTimedOut.value
)

const RELEASE_NOTES_COLLAPSED_LIMIT = 700
const releaseNotesExpanded = ref(false)
const developmentRevisions = ref<ComfyUIDevelopmentRevision[]>([])
const developmentNotesLoading = ref(false)

const developmentChangedRevisions = computed(() => {
  const installedCommit = preview.value?.installedCommit?.toLowerCase() ?? ''
  const installedIndex = developmentRevisions.value.findIndex(
    (revision) => revision.sha.toLowerCase() === installedCommit
  )
  return installedIndex >= 0
    ? developmentRevisions.value.slice(0, installedIndex)
    : developmentRevisions.value
})

const developmentUpdateNotes = computed(() =>
  developmentChangedRevisions.value
    .map((revision) => `• ${revision.shortSha} — ${revision.title}`)
    .join('\n')
)

const developmentUpdateRows = computed(() =>
  developmentChangedRevisions.value.map((revision) => ({
    ...revision,
    publishedDisplay: formatPublishedAt(revision.committedAt)
  }))
)

const visibleDevelopmentUpdateRows = computed(() => {
  const rows = developmentUpdateRows.value
  if (releaseNotesExpanded.value || !releaseNotesCanExpand.value) return rows

  const visible: typeof rows = []
  let usedCharacters = 0
  for (const row of rows) {
    const rowLength =
      row.shortSha.length + row.title.length + (row.publishedDisplay?.length ?? 0) + 5
    if (visible.length > 0 && usedCharacters + rowLength > RELEASE_NOTES_COLLAPSED_LIMIT) break
    visible.push(row)
    usedCharacters += rowLength
  }
  return visible
})

watch(
  () => selectedOption.value?.value,
  () => {
    releaseNotesExpanded.value = false
  }
)

const showReleaseInfo = computed(
  () => preview.value?.updateAvailable === true && preview.value?.showReleaseInfo === true
)
const releaseNotes = computed(() =>
  selectedOption.value?.value === 'latest'
    ? developmentUpdateNotes.value
    : (preview.value?.releaseNotes?.trim() ?? '')
)
const releaseNotesCanExpand = computed(
  () => releaseNotes.value.length > RELEASE_NOTES_COLLAPSED_LIMIT
)
const visibleReleaseNotes = computed(() => {
  const notes = releaseNotes.value
  if (releaseNotesExpanded.value || !releaseNotesCanExpand.value) return notes
  const slice = notes.slice(0, RELEASE_NOTES_COLLAPSED_LIMIT)
  const boundary = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
  const end = boundary > RELEASE_NOTES_COLLAPSED_LIMIT * 0.7 ? boundary : slice.length
  return `${slice.slice(0, end).trimEnd()}…`
})
function formatPublishedAt(raw: string | undefined): string | null {
  if (!raw) return null
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return null
  try {
    // Release dates used to fall back to `toLocaleDateString()`, which hid the
    // actual commit/release time and made several development revisions from
    // the same day indistinguishable. Keep this in the user's local timezone
    // and show minutes in 24-hour form; the locale still owns date ordering and
    // separators.
    return new Intl.DateTimeFormat(locale.value, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

const releasePublishedDisplay = computed(() =>
  selectedOption.value?.value === 'latest' ? null : formatPublishedAt(preview.value?.publishedAt)
)

function openReleaseUrl(): void {
  const url = preview.value?.releaseUrl
  if (!url || !/^https?:\/\//i.test(url)) return
  window.api.openExternal(url)
}

// --- Explicit version targets ---------------------------------------------
// Stable and development are intentionally separate catalogs. Stable shows
// formal tags; development shows the newest commits on master. The selection
// resets whenever the channel or installed revision changes, preventing a
// stale target from surviving a completed update or a channel switch.
type VersionDirection = 'upgrade' | 'downgrade' | 'current' | 'switch'

const stableTags = ref<string[]>([])
const stableTagsLoading = ref(false)
const stableTagsLoaded = ref(false)
const stableTagsFailed = ref(false)
const developmentRevisionsLoading = ref(false)
const developmentRevisionsLoaded = ref(false)
const developmentRevisionsFailed = ref(false)
let developmentRevisionsKey = ''
const pickedVersionTarget = ref('')
const manualCommitInput = ref('')
const manualCommitTarget = ref('')
const manualCommitError = ref('')
const targetRelease = ref<ComfyUIReleaseInfo | null>(null)
const targetReleaseLoading = ref(false)
const targetNotesExpanded = ref(false)
let targetReleaseRequest = 0

const showVersionPicker = computed(() => preview.value?.showVersionPicker === true)
const selectedVersionChannel = computed<'stable' | 'latest'>(() =>
  selectedOption.value?.value === 'latest' ? 'latest' : 'stable'
)
const isDevelopmentVersionChannel = computed(() => selectedVersionChannel.value === 'latest')

async function loadStableTags(): Promise<void> {
  if (stableTagsLoaded.value || stableTagsLoading.value) return
  stableTagsLoading.value = true
  stableTagsFailed.value = false
  try {
    const tags = await window.api.getStableTags()
    stableTags.value = tags.filter((tag) => STABLE_TAG_RE.test(tag))
    stableTagsFailed.value = stableTags.value.length === 0
  } catch {
    stableTags.value = []
    stableTagsFailed.value = true
  } finally {
    stableTagsLoaded.value = true
    stableTagsLoading.value = false
  }
}

async function loadDevelopmentRevisions(): Promise<void> {
  const requestKey = `${preview.value?.installationId ?? ''}:${preview.value?.latestCommit ?? ''}`
  if (
    (developmentRevisionsLoaded.value && developmentRevisionsKey === requestKey) ||
    developmentRevisionsLoading.value
  )
    return
  developmentRevisionsLoading.value = true
  developmentNotesLoading.value = true
  developmentRevisionsFailed.value = false
  try {
    developmentRevisions.value = (
      await window.api.getComfyUIDevelopmentRevisions(
        preview.value?.installationId,
        preview.value?.latestCommit
      )
    )
      .filter((revision) => /^[0-9a-f]{40}$/i.test(revision.sha))
      .slice(0, 20)
    developmentRevisionsFailed.value = developmentRevisions.value.length === 0
  } catch {
    developmentRevisions.value = []
    developmentRevisionsFailed.value = true
  } finally {
    developmentRevisionsKey = requestKey
    developmentRevisionsLoaded.value = true
    developmentRevisionsLoading.value = false
    developmentNotesLoading.value = false
    const currentKey = `${preview.value?.installationId ?? ''}:${preview.value?.latestCommit ?? ''}`
    if (isDevelopmentVersionChannel.value && currentKey !== requestKey) {
      void loadDevelopmentRevisions()
    }
  }
}

function loadSelectedVersionCatalog(): void {
  if (!showVersionPicker.value) return
  if (isDevelopmentVersionChannel.value) void loadDevelopmentRevisions()
  else void loadStableTags()
}

watch(
  [showVersionPicker, selectedVersionChannel, () => preview.value?.latestCommit],
  loadSelectedVersionCatalog,
  { immediate: true }
)

watch(
  () => [
    selectedOption.value?.value,
    preview.value?.installedBaseTag,
    preview.value?.installedCommitsAhead,
    preview.value?.installedCommit,
    preview.value?.latestCommit
  ],
  () => {
    pickedVersionTarget.value = ''
    manualCommitInput.value = ''
    manualCommitTarget.value = ''
    manualCommitError.value = ''
    targetRelease.value = null
    targetNotesExpanded.value = false
    targetReleaseLoading.value = false
    targetReleaseRequest++
    if (selectedVersionChannel.value !== 'latest') developmentNotesLoading.value = false
  }
)

function tagParts(tag: string): number[] | null {
  if (!STABLE_TAG_RE.test(tag)) return null
  return tag.slice(1).split('.').map(Number)
}

function compareStableTags(a: string, b: string): number {
  const ap = tagParts(a)
  const bp = tagParts(b)
  if (!ap || !bp) return 0
  for (let i = 0; i < 3; i++) {
    const diff = (ap[i] ?? 0) - (bp[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const installedStableTag = computed(() => {
  const base = preview.value?.installedBaseTag
  if (base && STABLE_TAG_RE.test(base)) return base
  const display = preview.value?.installedVersion?.trim() ?? ''
  const candidate = display.startsWith('v') ? display : `v${display}`
  return STABLE_TAG_RE.test(candidate) ? candidate : ''
})

function directionForTag(tag: string): VersionDirection {
  const installed = installedStableTag.value
  if (!installed) return 'switch'
  const compared = compareStableTags(tag, installed)
  if (compared > 0) return 'upgrade'
  if (compared < 0) return 'downgrade'
  return preview.value?.installedCommitsAhead === 0 ? 'current' : 'downgrade'
}

function directionLabel(direction: VersionDirection): string {
  if (direction === 'upgrade') return t('channelCards.versionUpgrade', 'Upgrade')
  if (direction === 'downgrade') return t('channelCards.versionDowngrade', 'Downgrade')
  if (direction === 'current') return t('channelCards.current', 'Current')
  return t('channelCards.versionSwitch', 'Switch')
}

function directionForDevelopmentRevision(sha: string): VersionDirection {
  const normalizedTarget = sha.toLowerCase()
  const normalizedInstalled = preview.value?.installedCommit?.toLowerCase() ?? ''
  if (normalizedInstalled === normalizedTarget) return 'current'

  const targetIndex = developmentRevisions.value.findIndex(
    (revision) => revision.sha.toLowerCase() === normalizedTarget
  )
  const installedIndex = developmentRevisions.value.findIndex(
    (revision) => revision.sha.toLowerCase() === normalizedInstalled
  )
  if (targetIndex >= 0 && installedIndex >= 0) {
    return targetIndex < installedIndex ? 'upgrade' : 'downgrade'
  }

  // A clean formal release is older than every commit listed from current
  // master. For detached/custom commits that are absent from the recent list,
  // ancestry is unknown here, so call the operation a switch rather than
  // incorrectly promising an upgrade or downgrade.
  if (preview.value?.installedCommitsAhead === 0) return 'upgrade'
  return 'switch'
}

function applyManualCommitTarget(): void {
  const normalized = manualCommitInput.value.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    manualCommitError.value = t(
      'channelCards.manualCommitInvalid',
      'Enter a full 40-character hexadecimal commit SHA.'
    )
    return
  }
  manualCommitError.value = ''
  manualCommitTarget.value = normalized
  pickedVersionTarget.value = normalized
}

const versionTargetOptions = computed<BaseSelectOption[]>(() => {
  if (isDevelopmentVersionChannel.value) {
    const options: BaseSelectOption[] = developmentRevisions.value.map((revision) => ({
      value: revision.sha,
      label: `${revision.shortSha} — ${revision.title} — ${directionLabel(
        directionForDevelopmentRevision(revision.sha)
      )}`,
      description: formatPublishedAt(revision.committedAt) ?? undefined
    }))
    if (
      manualCommitTarget.value &&
      pickedVersionTarget.value === manualCommitTarget.value &&
      !options.some((option) => option.value.toLowerCase() === manualCommitTarget.value)
    ) {
      options.push({
        value: manualCommitTarget.value,
        label: `${manualCommitTarget.value.slice(0, 7)} — ${t(
          'channelCards.manualCommitTarget',
          'Manual commit'
        )} — ${directionLabel(directionForDevelopmentRevision(manualCommitTarget.value))}`
      })
    }
    return options
  }

  const latest = stableTags.value[0]
  return stableTags.value.map((tag) => {
    const parts = [tag]
    if (tag === latest) parts.push(t('newInstall.latestStable', 'Latest stable'))
    parts.push(directionLabel(directionForTag(tag)))
    return { value: tag, label: parts.join(' — ') }
  })
})

const selectedDevelopmentRevision = computed(() =>
  developmentRevisions.value.find(
    (revision) => revision.sha.toLowerCase() === pickedVersionTarget.value.toLowerCase()
  )
)
const isManualDevelopmentTarget = computed(
  () =>
    isDevelopmentVersionChannel.value &&
    manualCommitTarget.value !== '' &&
    pickedVersionTarget.value === manualCommitTarget.value
)

const targetDirection = computed<VersionDirection | null>(() => {
  const target = pickedVersionTarget.value
  if (!target) return null
  return isDevelopmentVersionChannel.value
    ? directionForDevelopmentRevision(target)
    : directionForTag(target)
})

watch([pickedVersionTarget, selectedVersionChannel], async ([target, channel]) => {
  const request = ++targetReleaseRequest
  targetRelease.value = null
  targetNotesExpanded.value = false
  if (channel === 'latest' || !STABLE_TAG_RE.test(target)) {
    targetReleaseLoading.value = false
    return
  }
  targetReleaseLoading.value = true
  try {
    const info = await window.api.getComfyUIRelease(target)
    if (request === targetReleaseRequest) targetRelease.value = info
  } catch {
    if (request === targetReleaseRequest) targetRelease.value = null
  } finally {
    if (request === targetReleaseRequest) targetReleaseLoading.value = false
  }
})

const targetReleaseNotes = computed(() =>
  isDevelopmentVersionChannel.value ? '' : (targetRelease.value?.notes.trim() ?? '')
)
const targetNotesCanExpand = computed(
  () => targetReleaseNotes.value.length > RELEASE_NOTES_COLLAPSED_LIMIT
)
const visibleTargetNotes = computed(() => {
  const notes = targetReleaseNotes.value
  if (targetNotesExpanded.value || !targetNotesCanExpand.value) return notes
  const slice = notes.slice(0, RELEASE_NOTES_COLLAPSED_LIMIT)
  const boundary = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
  const end = boundary > RELEASE_NOTES_COLLAPSED_LIMIT * 0.7 ? boundary : slice.length
  return `${slice.slice(0, end).trimEnd()}…`
})
const targetPublishedDisplay = computed(() =>
  formatPublishedAt(
    isDevelopmentVersionChannel.value
      ? selectedDevelopmentRevision.value?.committedAt
      : targetRelease.value?.publishedAt
  )
)

const targetDisplayVersion = computed(() => {
  if (!pickedVersionTarget.value) return ''
  return isDevelopmentVersionChannel.value
    ? (selectedDevelopmentRevision.value?.shortSha ?? pickedVersionTarget.value.slice(0, 7))
    : pickedVersionTarget.value
})

const targetTitle = computed(() =>
  isDevelopmentVersionChannel.value
    ? (selectedDevelopmentRevision.value?.title ??
      (isManualDevelopmentTarget.value
        ? t('channelCards.manualCommitTarget', 'Manual commit')
        : ''))
    : (targetRelease.value?.name ?? pickedVersionTarget.value)
)

const versionCatalogLoading = computed(() =>
  isDevelopmentVersionChannel.value ? developmentRevisionsLoading.value : stableTagsLoading.value
)
const versionCatalogFailed = computed(() =>
  isDevelopmentVersionChannel.value ? developmentRevisionsFailed.value : stableTagsFailed.value
)

function openTargetVersionUrl(): void {
  const url = isDevelopmentVersionChannel.value
    ? (selectedDevelopmentRevision.value?.url ??
      (isManualDevelopmentTarget.value
        ? `https://github.com/Comfy-Org/ComfyUI/commit/${pickedVersionTarget.value}`
        : undefined))
    : targetRelease.value?.url
  if (!url || !/^https?:\/\//i.test(url)) return
  window.api.openExternal(url)
}

const targetVersionAction = computed<ActionDef | null>(() => {
  const target = pickedVersionTarget.value
  const direction = targetDirection.value
  if (!target || !direction || direction === 'current') return null
  if (
    isDevelopmentVersionChannel.value &&
    !selectedDevelopmentRevision.value &&
    !isManualDevelopmentTarget.value
  )
    return null
  const isDowngrade = direction === 'downgrade'
  const displayVersion = targetDisplayVersion.value
  const actionLabel = isDowngrade
    ? t('channelCards.versionDowngradeTo', { version: displayVersion })
    : direction === 'upgrade'
      ? t('channelCards.versionUpgradeTo', { version: displayVersion })
      : t('channelCards.versionSwitchTo', { version: displayVersion })
  const messageKey = isDowngrade
    ? 'channelCards.versionConfirmDowngrade'
    : direction === 'upgrade'
      ? 'channelCards.versionConfirmUpgrade'
      : 'channelCards.versionConfirmSwitch'
  const notes = targetReleaseNotes.value
  return {
    id: 'update-comfyui',
    label: actionLabel,
    style: 'primary',
    enabled: !targetReleaseLoading.value,
    showProgress: true,
    cancellable: true,
    progressTitle: isDowngrade
      ? t('standalone.downgradingTitle', { version: displayVersion })
      : t('standalone.updatingTitle', { version: displayVersion }),
    data: isDevelopmentVersionChannel.value
      ? { channel: 'latest', targetCommit: target, isDowngrade }
      : { channel: 'stable', targetTag: target, isDowngrade },
    confirm: {
      title: t('standalone.updateConfirmTitle'),
      message: `${t(messageKey, {
        installed: preview.value?.installedVersion ?? '?',
        target: displayVersion
      })}\n\n${t('standalone.updateBreakingWarning')}\n${t('standalone.updateSnapshotUndoHint')}\n${t('channelCards.versionCoreOnlyNotice')}`,
      ...(notes || selectedDevelopmentRevision.value?.title || isManualDevelopmentTarget.value
        ? {
            messageDetails: [
              {
                label: isDevelopmentVersionChannel.value
                  ? t('channelCards.commitDetails')
                  : t('standalone.releaseNotesLabel'),
                items: [notes || selectedDevelopmentRevision.value?.title || targetTitle.value]
              }
            ]
          }
        : {})
    }
  }
})

const suppressChannelFooterForTarget = computed(() => pickedVersionTarget.value !== '')

function formatVersionLabel(raw: string | undefined): string {
  if (!raw || raw === '—') return '—'
  const trimmed = raw.trim()
  if (trimmed.startsWith('v') || trimmed.startsWith('V')) return trimmed
  return `v${trimmed}`
}

function normalizeVersion(raw: string | undefined): string {
  if (!raw || raw === '—') return ''
  return raw.trim().replace(/^[vV]/, '').toLowerCase()
}

const versionsMatch = computed(() => {
  if (!preview.value) return false
  const installed = normalizeVersion(preview.value.installedVersion)
  const latest = normalizeVersion(preview.value.latestVersion)
  if (!installed || !latest) return false
  return installed === latest
})

/** Product prefix ("ComfyUI", "PyTorch") so multiple update cards on the
 *  same tab each say what they update. */
const headlineProduct = computed(() => preview.value?.productName ?? '')

const headlineVersion = computed(() => {
  if (!preview.value) {
    return draftIsCurrent.value
      ? t('channelCards.upToDate', 'Up to date')
      : t('channelCards.switchTo', { channel: selectedOption.value?.label ?? '' })
  }
  if (preview.value.updateAvailable) {
    const ver = preview.value.latestVersion
    return ver && ver !== '—'
      ? formatVersionLabel(ver)
      : t('channelCards.updateAvailable', 'Update available')
  }
  return formatVersionLabel(preview.value.installedVersion)
})

const statusBadge = computed(() => {
  if (!preview.value) return null
  if (preview.value.updateAvailable) {
    return t('channelCards.updateAvailable', 'Update available')
  }
  if (preview.value.hideUpToDateBadge) return null
  return t('channelCards.upToDate', 'Up to date')
})

const statusBadgeTone = computed<'current' | 'update'>(() =>
  preview.value?.updateAvailable ? 'update' : 'current'
)

type StatRow = VersionStatRow

const lastCheckedDisplay = computed<{ value: string; title?: string } | null>(() => {
  if (!preview.value) return null
  if (preview.value.lastCheckedAt) {
    const ms = preview.value.lastCheckedAt
    let title: string | undefined
    try {
      title = d(new Date(ms), 'long')
    } catch {
      title = new Date(ms).toLocaleString()
    }
    return { value: formatRelativeFromMs(ms, t), title }
  }
  if (preview.value.lastChecked && preview.value.lastChecked !== '—') {
    return { value: preview.value.lastChecked }
  }
  return null
})

const statRows = computed<StatRow[]>(() => {
  if (!preview.value) return []
  const rows: StatRow[] = []
  const updateAvailable = preview.value.updateAvailable === true

  if (updateAvailable && preview.value.installedVersion) {
    rows.push({
      id: 'installed',
      label: t('channelCards.installedVersion', 'Installed'),
      value: formatVersionLabel(preview.value.installedVersion)
    })
  }
  if (updateAvailable && preview.value.latestVersion && !versionsMatch.value) {
    rows.push({
      id: 'latest',
      label: preview.value.latestLabel ?? t('channelCards.latestVersion', 'Latest'),
      value: formatVersionLabel(preview.value.latestVersion),
      highlight: true
    })
  }

  const lastChecked = lastCheckedDisplay.value
  if (lastChecked) {
    rows.push({
      id: 'last-checked',
      label: t('channelCards.lastChecked', 'Last checked'),
      value: lastChecked.value,
      title: lastChecked.title
    })
  }

  return rows
})

const allActions = computed<ActionDef[]>(() => [...selectedActions.value, ...props.sectionActions])

const checkUpdateAction = computed<ActionDef | undefined>(() =>
  allActions.value.find((a) => a.id === 'check-update')
)

const promotedPrimaryActions = computed<ActionDef[]>(() =>
  selectedActions.value.filter(
    (a) =>
      a.id === 'update-comfyui' ||
      a.id === 'copy-update' ||
      a.id === 'change-pytorch' ||
      a.id === 'copy-pytorch'
  )
)

const otherSecondaryActions = computed<ActionDef[]>(() =>
  selectedActions.value.filter(
    (a) =>
      a.id !== 'check-update' &&
      a.id !== 'update-comfyui' &&
      a.id !== 'copy-update' &&
      a.id !== 'copy-pytorch' &&
      a.style !== 'primary' &&
      a.style !== 'accent'
  )
)

const showCheckInHeader = computed(
  () =>
    checkUpdateAction.value != null &&
    promotedPrimaryActions.value.length === 0 &&
    otherSecondaryActions.value.length === 0
)

// Only surface the manual check when no update is already visible.
const showCheckUpdateInFooter = computed(
  () =>
    checkUpdateAction.value != null &&
    !showCheckInHeader.value &&
    preview.value?.updateAvailable !== true
)

const showFooterActions = computed(
  () =>
    promotedPrimaryActions.value.length > 0 ||
    otherSecondaryActions.value.length > 0 ||
    showCheckUpdateInFooter.value
)

const footerActions = computed<
  Array<{ action: ActionDef; variant: 'accent' | 'default' | 'danger' }>
>(() => {
  const out: Array<{ action: ActionDef; variant: 'accent' | 'default' | 'danger' }> = []

  if (checkUpdateAction.value && showCheckUpdateInFooter.value) {
    out.push({ action: checkUpdateAction.value, variant: 'default' })
  }

  for (const action of otherSecondaryActions.value) {
    // Switch Channel is the primary intent after picking a channel, so accent it.
    const variant =
      action.id === 'switch-channel' ? 'accent' : action.style === 'danger' ? 'danger' : 'default'
    out.push({ action, variant })
  }

  for (const action of promotedPrimaryActions.value) {
    if (action.id === 'copy-update') {
      out.push({ action, variant: 'default' })
    }
  }

  const updateNow = promotedPrimaryActions.value.find((a) => a.id === 'update-comfyui')
  if (updateNow) {
    out.push({ action: updateNow, variant: 'accent' })
  }

  // Copy & Change PyTorch is the safe alternative, so it sits before the
  // accented Change button, mirroring Copy & Update vs Update Now.
  const copyPytorch = promotedPrimaryActions.value.find((a) => a.id === 'copy-pytorch')
  if (copyPytorch) {
    out.push({ action: copyPytorch, variant: 'default' })
  }

  // The PyTorch card's per-option switch action; accented for the same
  // reason as Update Now (it is the primary intent after picking a stack).
  const changePytorch = promotedPrimaryActions.value.find((a) => a.id === 'change-pytorch')
  if (changePytorch) {
    out.push({ action: changePytorch, variant: 'accent' })
  }

  return out
})

function optionLabel(opt: DetailFieldOption): string {
  if (opt.value === currentValue.value) {
    return `${opt.label} — ${t('channelCards.current', 'Current')}`
  }
  if (opt.recommended) {
    return `${opt.label} — ${t('newInstall.recommended', 'Recommended')}`
  }
  return opt.label
}

function toSelectOption(opt: DetailFieldOption): BaseSelectOption {
  return { value: opt.value, label: optionLabel(opt), description: opt.description }
}

/** Group-id path of the selected option; anchors every level dropdown.
 *  `selectedOption` already falls back to the first option in cascade mode,
 *  so a transiently unknown draft can't blank the cascade. */
const selectedPath = computed<string[]>(() => {
  if (!cascadeActive.value) return []
  return (selectedOption.value?.groupPath ?? []).map((g) => g.id)
})

interface CascadeLevel {
  label?: string
  selected: string
  options: BaseSelectOption[]
}

const cascadeLevels = computed<CascadeLevel[]>(() => {
  if (!cascadeActive.value) return []
  const opts = props.field.options ?? []
  const path = selectedPath.value
  const levels: CascadeLevel[] = []
  for (let level = 0; level < groupDepth.value; level++) {
    const prefix = path.slice(0, level)
    const groups = new Map<string, { label: string; description?: string }>()
    for (const opt of opts) {
      const gp = opt.groupPath ?? []
      const entry = gp[level]
      if (!entry) continue
      if (prefix.every((id, i) => gp[i]?.id === id) && !groups.has(entry.id)) {
        groups.set(entry.id, { label: entry.label, description: entry.description })
      }
    }
    levels.push({
      label: props.field.groupLabels?.[level],
      selected: path[level] ?? '',
      options: [...groups].map(([value, g]) => ({
        value,
        label: g.label,
        description: g.description
      }))
    })
  }
  return levels
})

/** Selecting a group jumps to the first (newest - main emits newest-first)
 *  concrete option under the new prefix, keeping preview/actions real. */
function selectCascadeGroup(level: number, groupId: string): void {
  const prefix = [...selectedPath.value.slice(0, level), groupId]
  const match = (props.field.options ?? []).find((opt) =>
    prefix.every((id, i) => opt.groupPath?.[i]?.id === id)
  )
  if (match) state.draft = match.value
}

/** Options for the final (concrete) dropdown: the whole list when flat, only
 *  the selected group's options when cascading. */
const selectOptions = computed<BaseSelectOption[]>(() => {
  const opts = props.field.options ?? []
  if (!cascadeActive.value) return opts.map(toSelectOption)
  const path = selectedPath.value
  return opts
    .filter((opt) => path.every((id, i) => opt.groupPath?.[i]?.id === id))
    .map(toSelectOption)
})
</script>

<template>
  <div class="channel-picker">
    <VersionStatPanel
      :headline-product="headlineProduct"
      :headline="headlineVersion"
      :headline-highlight="preview?.updateAvailable === true"
      :badge="preview ? statusBadge : null"
      :badge-tone="statusBadgeTone"
      :rows="statRows"
    />

    <!-- Hint shown while `commitsAhead` is still being computed; self-hides
         after the max window if enrichment never completes. -->
    <p v-if="showEnrichingHint" class="channel-picker-enriching" role="status" aria-live="polite">
      <Loader2 :size="12" class="channel-picker-enriching-spinner" aria-hidden="true" />
      {{ t('channelCards.computingCommitsAhead', 'Computing commits ahead…') }}
    </p>

    <section v-if="showReleaseInfo" class="channel-picker-release" aria-live="polite">
      <div class="channel-picker-release-header">
        <strong>{{ t('channelCards.releaseNotesTitle', 'What changed') }}</strong>
        <span v-if="releasePublishedDisplay">
          {{ t('channelCards.releaseNotesPublished', { date: releasePublishedDisplay }) }}
        </span>
      </div>
      <p v-if="developmentNotesLoading" class="channel-picker-target-loading" role="status">
        <Loader2 :size="12" class="channel-picker-action-spinner" aria-hidden="true" />
        {{ t('channelCards.developmentNotesLoading', 'Loading recent commit changes…') }}
      </p>
      <ul
        v-else-if="isDevelopmentVersionChannel && visibleDevelopmentUpdateRows.length > 0"
        class="channel-picker-development-notes"
      >
        <li
          v-for="revision in visibleDevelopmentUpdateRows"
          :key="revision.sha"
          class="channel-picker-development-note"
        >
          <span class="channel-picker-development-title">
            {{ revision.shortSha }} — {{ revision.title }}
          </span>
          <time
            v-if="revision.publishedDisplay"
            class="channel-picker-development-date"
            :datetime="revision.committedAt"
          >
            {{ revision.publishedDisplay }}
          </time>
        </li>
      </ul>
      <p v-else-if="visibleReleaseNotes" class="channel-picker-release-notes">
        {{ visibleReleaseNotes }}
      </p>
      <p v-else class="channel-picker-release-empty">
        {{
          t(
            'channelCards.releaseNotesUnavailable',
            'Upstream did not provide release notes. Open the full change page for details.'
          )
        }}
      </p>
      <div
        v-if="releaseNotesCanExpand || preview?.releaseUrl"
        class="channel-picker-release-actions"
      >
        <button
          v-if="releaseNotesCanExpand"
          type="button"
          class="channel-picker-release-action"
          @click="releaseNotesExpanded = !releaseNotesExpanded"
        >
          {{
            releaseNotesExpanded
              ? t('channelCards.releaseNotesCollapse', 'Show less')
              : t('channelCards.releaseNotesExpand', 'Show more')
          }}
        </button>
        <button
          v-if="preview?.releaseUrl"
          type="button"
          class="channel-picker-release-action is-link"
          @click="openReleaseUrl"
        >
          {{ t('channelCards.viewReleasePage', 'View full change page') }}
        </button>
      </div>
    </section>

    <div class="channel-picker-card">
      <div class="channel-picker-channel-header">
        <span class="channel-picker-field-label">
          {{ field.label }}
          <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
        </span>
        <button
          v-if="showCheckInHeader && checkUpdateAction"
          type="button"
          class="channel-picker-action compact"
          :class="{ 'is-running': isActionRunning(checkUpdateAction.id) }"
          :disabled="checkUpdateAction.enabled === false || isActionRunning(checkUpdateAction.id)"
          :title="checkUpdateAction.tooltip"
          :data-testid="TID.updateActionButton(checkUpdateAction.id)"
          @click="emit('action', checkUpdateAction)"
        >
          <Loader2
            v-if="isActionRunning(checkUpdateAction.id)"
            :size="14"
            class="channel-picker-action-spinner"
          />
          {{ checkUpdateAction.label }}
        </button>
      </div>

      <div class="channel-picker-channel">
        <div
          v-for="(level, i) in cascadeLevels"
          :key="i"
          class="channel-picker-cascade-level"
          :data-testid="TID.channelGroupSelect(i)"
        >
          <span v-if="level.label" class="channel-picker-field-label">{{ level.label }}</span>
          <BaseSelect
            :model-value="level.selected"
            :options="level.options"
            :aria-label="level.label ?? field.label"
            @update:model-value="selectCascadeGroup(i, $event)"
          />
        </div>
        <BaseSelect
          :model-value="concreteValue"
          :options="selectOptions"
          :aria-label="field.label"
          @update:model-value="state.draft = $event"
        />
        <p v-if="selectedOption?.description" class="channel-picker-desc">
          {{ selectedOption.description }}
        </p>
      </div>

      <section v-if="showVersionPicker" class="channel-picker-version-target">
        <span class="channel-picker-field-label">
          {{
            isDevelopmentVersionChannel
              ? t('channelCards.developmentVersionTarget', 'Recent development versions')
              : t('channelCards.stableVersionTarget', 'Specific stable version')
          }}
        </span>
        <BaseSelect
          :model-value="pickedVersionTarget"
          :options="versionTargetOptions"
          :aria-label="
            isDevelopmentVersionChannel
              ? t('channelCards.developmentVersionTarget', 'Recent development versions')
              : t('channelCards.stableVersionTarget', 'Specific stable version')
          "
          :placeholder="
            versionCatalogLoading
              ? t('channelCards.versionLoading', 'Loading versions…')
              : versionCatalogFailed
                ? t('channelCards.versionUnavailable', 'Version history is unavailable')
                : t('channelCards.versionChoose', 'Choose a version')
          "
          :disabled="versionCatalogLoading || versionTargetOptions.length === 0"
          searchable
          :search-placeholder="
            isDevelopmentVersionChannel
              ? t('channelCards.developmentVersionSearch', 'Search SHA or commit title…')
              : t('channelCards.stableVersionSearch', 'Search stable versions…')
          "
          :empty-label="t('channelCards.versionNoMatches', 'No matching versions')"
          :max-visible-options="20"
          @update:model-value="pickedVersionTarget = $event"
        />
        <p class="channel-picker-version-hint">
          {{
            isDevelopmentVersionChannel
              ? t(
                  'channelCards.developmentRecentHint',
                  'Shows the 20 newest commits from master, ordered newest first.'
                )
              : t(
                  'channelCards.stableRecentHint',
                  'Shows the 20 newest formal releases. Search to find an older version.'
                )
          }}
        </p>
        <details v-if="isDevelopmentVersionChannel" class="channel-picker-advanced">
          <summary>{{ t('common.advanced', 'Advanced') }}</summary>
          <p class="channel-picker-version-hint">
            {{
              t(
                'channelCards.manualCommitAdvanced',
                'Enter an arbitrary full commit SHA here. It must belong to master history.'
              )
            }}
          </p>
          <form class="channel-picker-manual-commit" @submit.prevent="applyManualCommitTarget">
            <input
              v-model="manualCommitInput"
              type="text"
              class="channel-picker-manual-commit-input"
              :aria-label="t('channelCards.manualCommitLabel', 'Full commit SHA')"
              :placeholder="t('channelCards.manualCommitPlaceholder', '40-character commit SHA')"
              spellcheck="false"
              autocomplete="off"
              @input="manualCommitError = ''"
            />
            <button type="submit" class="channel-picker-action compact">
              {{ t('channelCards.manualCommitUse', 'Use commit') }}
            </button>
          </form>
          <p v-if="manualCommitError" class="channel-picker-manual-commit-error" role="alert">
            {{ manualCommitError }}
          </p>
        </details>

        <div
          v-if="pickedVersionTarget && targetDirection"
          class="channel-picker-target-card"
          aria-live="polite"
        >
          <div class="channel-picker-target-header">
            <strong>{{ targetDisplayVersion }}</strong>
            <span class="channel-picker-direction" :class="`is-${targetDirection}`">
              {{ directionLabel(targetDirection) }}
            </span>
          </div>
          <p v-if="targetTitle" class="channel-picker-target-title">{{ targetTitle }}</p>
          <p v-if="targetPublishedDisplay" class="channel-picker-target-date">
            {{ t('channelCards.releaseNotesPublished', { date: targetPublishedDisplay }) }}
          </p>
          <p v-if="targetReleaseLoading" class="channel-picker-target-loading" role="status">
            <Loader2 :size="12" class="channel-picker-action-spinner" aria-hidden="true" />
            {{ t('channelCards.releaseNotesLoading', 'Loading release notes…') }}
          </p>
          <p v-else-if="visibleTargetNotes" class="channel-picker-release-notes">
            {{ visibleTargetNotes }}
          </p>
          <p v-else-if="!isDevelopmentVersionChannel" class="channel-picker-release-empty">
            {{
              t(
                'channelCards.releaseNotesUnavailable',
                'Upstream did not provide release notes. Open the full change page for details.'
              )
            }}
          </p>
          <div
            v-if="
              targetNotesCanExpand ||
              targetRelease?.url ||
              selectedDevelopmentRevision?.url ||
              isManualDevelopmentTarget
            "
            class="channel-picker-release-actions"
          >
            <button
              v-if="targetNotesCanExpand"
              type="button"
              class="channel-picker-release-action"
              @click="targetNotesExpanded = !targetNotesExpanded"
            >
              {{
                targetNotesExpanded
                  ? t('channelCards.releaseNotesCollapse', 'Show less')
                  : t('channelCards.releaseNotesExpand', 'Show more')
              }}
            </button>
            <button
              v-if="
                targetRelease?.url || selectedDevelopmentRevision?.url || isManualDevelopmentTarget
              "
              type="button"
              class="channel-picker-release-action is-link"
              @click="openTargetVersionUrl"
            >
              {{
                isDevelopmentVersionChannel
                  ? t('channelCards.viewCommitPage', 'View commit page')
                  : t('channelCards.viewReleasePage', 'View full change page')
              }}
            </button>
          </div>
          <p class="channel-picker-version-transaction-note">
            {{
              t(
                'channelCards.versionCoreOnlyNotice',
                'A snapshot or restore point is created first. Python, PyTorch, CUDA, and custom-node dependencies are not changed automatically.'
              )
            }}
          </p>
          <p v-if="targetDirection === 'current'" class="channel-picker-current-target">
            {{ t('channelCards.versionCurrentTarget', 'This version is already installed.') }}
          </p>
          <div v-else-if="targetVersionAction" class="channel-picker-target-actions">
            <button
              type="button"
              class="channel-picker-action accent"
              :class="{ 'is-running': isActionRunning(targetVersionAction.id) }"
              :disabled="
                targetVersionAction.enabled === false || isActionRunning(targetVersionAction.id)
              "
              :data-testid="TID.updateActionButton(targetVersionAction.id)"
              @click="emit('action', targetVersionAction)"
            >
              <Loader2
                v-if="isActionRunning(targetVersionAction.id)"
                :size="14"
                class="channel-picker-action-spinner"
              />
              {{ targetVersionAction.label }}
            </button>
          </div>
        </div>
      </section>

      <p v-if="!draftIsCurrent && !preview" class="channel-picker-empty">
        {{ t('channelCards.noInfo', 'No information available for this channel.') }}
      </p>
      <p v-else-if="!draftIsCurrent && preview" class="channel-picker-switch-hint">
        {{ t('channelCards.switchTo', { channel: selectedOption?.label ?? '' }) }}
      </p>

      <div
        v-if="showFooterActions && !suppressChannelFooterForTarget"
        class="channel-picker-actions"
      >
        <button
          v-for="{ action, variant } in footerActions"
          :key="action.id"
          type="button"
          class="channel-picker-action"
          :class="[variant, { 'is-running': isActionRunning(action.id) }]"
          :disabled="action.enabled === false || isActionRunning(action.id)"
          :title="action.tooltip"
          :data-testid="TID.updateActionButton(action.id)"
          @click="emit('action', action)"
        >
          <Loader2
            v-if="isActionRunning(action.id)"
            :size="14"
            class="channel-picker-action-spinner"
          />
          {{ action.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.channel-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.channel-picker-release {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid color-mix(in oklab, var(--accent) 28%, var(--chooser-surface-border));
  border-radius: 8px;
  background: color-mix(in oklab, var(--accent) 5%, var(--brand-surface-bg));
}

.channel-picker-release-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--neutral-100);
  font-size: 12px;
  line-height: 17px;
}

.channel-picker-release-header span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
  text-align: right;
}

.channel-picker-release-notes,
.channel-picker-release-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.channel-picker-development-notes {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 18px;
}

.channel-picker-development-note {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: baseline;
  gap: 14px;
}

.channel-picker-development-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.channel-picker-development-title::before {
  content: '• ';
}

.channel-picker-development-date {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.channel-picker-release-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.channel-picker-release-action {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.channel-picker-release-action:hover,
.channel-picker-release-action:focus-visible {
  color: var(--neutral-100);
  outline: none;
  text-decoration: underline;
}

.channel-picker-release-action.is-link {
  color: var(--accent);
}

.channel-picker-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}

.channel-picker-channel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.channel-picker-channel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-picker-cascade-level {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.channel-picker-field-label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  line-height: 16px;
}

.channel-picker-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 16.5px;
}

.channel-picker-version-target {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 12px;
  border-top: 1px solid var(--border-hover);
}

.channel-picker-version-hint,
.channel-picker-version-transaction-note,
.channel-picker-current-target,
.channel-picker-target-title,
.channel-picker-target-date,
.channel-picker-target-loading {
  margin: 0;
  font-size: 12px;
  line-height: 17px;
}

.channel-picker-advanced {
  padding: 7px 9px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 7px;
}

.channel-picker-advanced summary {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  user-select: none;
}

.channel-picker-advanced[open] summary {
  margin-bottom: 7px;
}

.channel-picker-manual-commit {
  display: flex;
  gap: 7px;
  margin-top: 7px;
}

.channel-picker-manual-commit-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 7px;
  outline: none;
  background: var(--neutral-800);
  color: var(--neutral-100);
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
}

.channel-picker-manual-commit-input:focus {
  border-color: var(--accent-primary);
}

.channel-picker-manual-commit-error {
  margin: 6px 0 0;
  color: var(--danger, #ef6a6a);
  font-size: 12px;
  line-height: 17px;
}

.channel-picker-version-hint,
.channel-picker-target-date,
.channel-picker-target-loading {
  color: var(--text-muted);
}

.channel-picker-target-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 3px;
  padding: 11px;
  border: 1px solid color-mix(in oklab, var(--accent) 24%, var(--chooser-surface-border));
  border-radius: 8px;
  background: color-mix(in oklab, var(--accent) 4%, var(--brand-surface-bg));
}

.channel-picker-target-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.channel-picker-target-header strong,
.channel-picker-target-title {
  color: var(--neutral-100);
}

.channel-picker-direction {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--neutral-800);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 16px;
}

.channel-picker-direction.is-upgrade {
  background: color-mix(in oklab, var(--accent) 15%, transparent);
  color: var(--accent);
}

.channel-picker-direction.is-downgrade {
  background: color-mix(in oklab, var(--warning, #f2b84b) 14%, transparent);
  color: var(--warning, #f2b84b);
}

.channel-picker-direction.is-current {
  background: color-mix(in oklab, var(--success, #4cc38a) 14%, transparent);
  color: var(--success, #4cc38a);
}

.channel-picker-version-transaction-note {
  padding: 8px 9px;
  border-radius: 6px;
  background: color-mix(in oklab, var(--neutral-700) 26%, transparent);
  color: var(--text-muted);
}

.channel-picker-current-target {
  color: var(--success, #4cc38a);
}

.channel-picker-target-loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.channel-picker-target-actions {
  display: flex;
  justify-content: flex-end;
}

.channel-picker-empty,
.channel-picker-switch-hint {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}

.channel-picker-enriching {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
  font-style: italic;
}

.channel-picker-enriching-spinner {
  flex: 0 0 auto;
  animation: channel-picker-action-spin 0.9s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .channel-picker-enriching-spinner {
    animation: none;
  }
}

.channel-picker-empty {
  padding: 8px 10px;
  border: 1px dashed var(--chooser-surface-border);
  border-radius: 6px;
}

.channel-picker-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border-hover);
}

.channel-picker-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 32px;
  min-height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background-color 100ms ease,
    filter 100ms ease;
}

.channel-picker-action.is-running {
  cursor: progress;
  opacity: 0.85;
}

.channel-picker-action-spinner {
  flex: 0 0 auto;
  animation: channel-picker-action-spin 0.9s linear infinite;
}

@keyframes channel-picker-action-spin {
  to {
    transform: rotate(360deg);
  }
}

.channel-picker-action.compact {
  height: 28px;
  min-height: 28px;
  padding: 0 12px;
  font-size: 12px;
  flex-shrink: 0;
}

.channel-picker-action:hover:not(:disabled),
.channel-picker-action:focus-visible:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.channel-picker-action.accent {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.channel-picker-action.accent:hover:not(:disabled),
.channel-picker-action.accent:focus-visible:not(:disabled) {
  background: var(--accent);
  color: var(--bg);
}

.channel-picker-action.danger {
  color: var(--danger);
  border-color: var(--chooser-surface-border);
}

.channel-picker-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
