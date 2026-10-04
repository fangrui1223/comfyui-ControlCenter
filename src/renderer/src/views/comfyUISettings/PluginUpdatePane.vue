<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitBranch,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  X
} from 'lucide-vue-next'
import type {
  ActionDef,
  PluginCompatibilityPlan,
  PluginCompatibilityVerdict,
  PluginUpdateInventory,
  PluginUpdateItem,
  PluginUpdateStatus
} from '../../types/ipc'

const props = defineProps<{ installationId: string }>()
const emit = defineEmits<{ 'run-action': [action: ActionDef] }>()
const { t, locale } = useI18n()

const inventory = ref<PluginUpdateInventory | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const query = ref('')
const filter = ref<'all' | 'updates' | 'attention'>('all')
const selected = ref<Set<string>>(new Set())
const expanded = ref<Set<string>>(new Set())
const compatibilityPlans = ref<Map<string, PluginCompatibilityPlan>>(new Map())
const compatibilityChecking = ref<Set<string>>(new Set())
const compatibilityOpen = ref<string | null>(null)
let unsubscribe: (() => void) | undefined
let loadSeq = 0

const attention = new Set<PluginUpdateStatus>([
  'dirty',
  'ahead',
  'diverged',
  'detached',
  'no-upstream',
  'unreachable'
])

const filteredItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return (inventory.value?.items ?? []).filter((item) => {
    if (filter.value === 'updates' && item.status !== 'update-available') return false
    if (filter.value === 'attention' && !attention.has(item.status)) return false
    if (!needle) return true
    return `${item.id} ${item.dirName} ${item.repository ?? ''}`
      .toLocaleLowerCase()
      .includes(needle)
  })
})

const updateableItems = computed(() =>
  (inventory.value?.items ?? []).filter((item) => item.updateable)
)
const selectedCount = computed(
  () => updateableItems.value.filter((item) => selected.value.has(item.dirName)).length
)
const allUpdateableSelected = computed(
  () => updateableItems.value.length > 0 && selectedCount.value === updateableItems.value.length
)
const lastRunByDir = computed(
  () => new Map((inventory.value?.lastRun?.items ?? []).map((item) => [item.dirName, item]))
)
const refreshing = computed(() => loading.value && inventory.value != null)

function shortSha(value: string | null): string {
  return value?.slice(0, 8) ?? '—'
}

function displayRef(value: string | null): string {
  if (!value) return '—'
  return /^[0-9a-f]{20,}$/i.test(value) ? value.slice(0, 8) : value
}

function installedRef(item: PluginUpdateItem): string | null {
  return item.sourceType === 'cnr' ? item.installedVersion : item.localCommit
}

function targetRef(item: PluginUpdateItem): string | null {
  return item.sourceType === 'cnr' ? item.latestVersion : item.remoteCommit
}

function sourceLabel(item: PluginUpdateItem): string {
  const labels: Record<PluginUpdateItem['sourceType'], string> = {
    cnr: t('pluginUpdates.sourceCnr', 'Manager package'),
    git: t('pluginUpdates.sourceGit', 'Git repository'),
    unmanaged: t('pluginUpdates.sourceManual', 'Manual directory'),
    file: t('pluginUpdates.sourceFile', 'Single-file node')
  }
  return labels[item.sourceType]
}

function runStatusLabel(status: string): string {
  const fallback: Record<string, string> = {
    updated: 'Updated',
    'rolled-back': 'Rolled back',
    failed: 'Failed',
    'not-run': 'Not run'
  }
  return t(`pluginUpdates.runStatus.${status}`, fallback[status] ?? status)
}

function statusLabel(status: PluginUpdateStatus): string {
  const fallback: Record<PluginUpdateStatus, string> = {
    current: 'Up to date',
    'update-available': 'Update available',
    dirty: 'Local changes',
    ahead: 'Local ahead',
    diverged: 'Diverged',
    detached: 'Detached HEAD',
    'no-upstream': 'No upstream',
    unreachable: 'Remote unavailable',
    unsupported: 'Manual update'
  }
  return t(`pluginUpdates.status.${status}`, fallback[status])
}

function reasonText(item: PluginUpdateItem): string | null {
  if (!item.reasonCode) return item.reason
  return t(`pluginUpdates.reason.${item.reasonCode}`, item.reason ?? '')
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value))
}

async function load(refresh: boolean): Promise<void> {
  const seq = ++loadSeq
  const installationId = props.installationId
  loading.value = true
  if (!refresh || !inventory.value) error.value = null
  try {
    const next = await window.api.getPluginUpdates(installationId, refresh)
    if (seq !== loadSeq || installationId !== props.installationId) return
    inventory.value = next
    const allowed = new Set(
      next.items.filter((item) => item.updateable).map((item) => item.dirName)
    )
    selected.value = new Set([...selected.value].filter((id) => allowed.has(id)))
    const currentRefs = new Map(
      next.items.map((item) => [item.dirName, `${installedRef(item)}:${targetRef(item)}`])
    )
    compatibilityPlans.value = new Map(
      [...compatibilityPlans.value].filter(
        ([dirName, plan]) => currentRefs.get(dirName) === `${plan.currentRef}:${plan.targetRef}`
      )
    )
  } catch (cause) {
    if (seq !== loadSeq || installationId !== props.installationId) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function loadLocalThenRefresh(): Promise<void> {
  const installationId = props.installationId
  await load(false)
  if (installationId === props.installationId && inventory.value) void load(true)
}

function toggle(item: PluginUpdateItem): void {
  if (!item.updateable) return
  const next = new Set(selected.value)
  if (next.has(item.dirName)) next.delete(item.dirName)
  else next.add(item.dirName)
  selected.value = next
}

function toggleAll(): void {
  selected.value = allUpdateableSelected.value
    ? new Set()
    : new Set(updateableItems.value.map((item) => item.dirName))
}

function toggleDetails(dirName: string): void {
  const next = new Set(expanded.value)
  if (next.has(dirName)) next.delete(dirName)
  else next.add(dirName)
  expanded.value = next
}

function compatibilityLabel(verdict: PluginCompatibilityVerdict): string {
  const fallback: Record<PluginCompatibilityVerdict, string> = {
    'not-required': 'Standard update',
    unchecked: 'Check compatibility',
    checking: 'Checking…',
    ready: 'Compatibility passed',
    'approval-required': 'Confirm dependency plan',
    'review-required': 'Manual review required',
    blocked: 'Incompatible environment',
    stale: 'Check again',
    error: 'Check failed'
  }
  return t(`pluginUpdates.compatibility.${verdict}`, fallback[verdict])
}

function compatibilityTone(plan: PluginCompatibilityPlan | undefined): PluginCompatibilityVerdict {
  return plan?.verdict ?? 'unchecked'
}

function dependencyDifferenceLabel(kind: 'added' | 'removed' | 'changed'): string {
  const fallback = { added: 'Added', removed: 'Removed', changed: 'Changed' }
  return t(`pluginUpdates.compatibility.dependency.${kind}`, fallback[kind])
}

async function checkCompatibility(item: PluginUpdateItem, refresh = true): Promise<void> {
  if (compatibilityChecking.value.has(item.dirName)) return
  compatibilityChecking.value = new Set([...compatibilityChecking.value, item.dirName])
  compatibilityOpen.value = item.dirName
  const installationId = props.installationId
  try {
    const plan = await window.api.getPluginCompatibilityPlan(installationId, item.dirName, refresh)
    if (installationId !== props.installationId) return
    compatibilityPlans.value = new Map(compatibilityPlans.value).set(item.dirName, plan)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (installationId === props.installationId) {
      const next = new Set(compatibilityChecking.value)
      next.delete(item.dirName)
      compatibilityChecking.value = next
    }
  }
}

function runCompatibleUpdate(item: PluginUpdateItem, plan: PluginCompatibilityPlan): void {
  const dependencies =
    plan.verdict === 'approval-required' &&
    plan.executionMode === 'wheel-update' &&
    !!plan.packageChanges?.length
  if ((plan.verdict !== 'ready' && !dependencies) || !plan.targetRef) return
  const label = dependencies
    ? t('pluginUpdates.compatibility.approveExecute', 'Confirm and update')
    : t('pluginUpdates.compatibility.execute', 'Update source')
  const packageList = (plan.packageChanges ?? [])
    .map((change) => `${change.name}: ${change.from ?? '—'} → ${change.to}`)
    .join('\n')
  emit('run-action', {
    id: 'update-plugin-compatible',
    label,
    style: 'accent',
    showProgress: true,
    progressTitle: t('pluginUpdates.compatibility.updating', 'Compatibility update'),
    cancellable: false,
    data: {
      pluginId: item.id,
      dirName: item.dirName,
      planDigest: plan.planDigest,
      approveDependencies: dependencies,
      ...(item.sourceType === 'cnr'
        ? { targetVersion: plan.targetRef }
        : { targetCommit: plan.targetRef })
    },
    confirm: {
      title: t('pluginUpdates.compatibility.confirmTitle', 'Run compatibility update?'),
      message: dependencies
        ? `${t('pluginUpdates.compatibility.confirmPackages', { n: plan.packageChanges!.length })}\n\n${packageList}\n\n${t('pluginUpdates.compatibility.confirmRecovery')}`
        : t(
            'pluginUpdates.compatibility.confirmMessage',
            'This will stop the ComfyUI instance, save a snapshot and local CNR backup, update the source through Manager v4 without changing dependencies, validate the result, and restore the source and Python packages if any step fails. ComfyUI will stay stopped; start it manually when you are ready.'
          ),
      confirmLabel: label
    }
  })
}

function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return '—'
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function constraintLabel(value: string | null): string {
  return value === '' ? t('pluginUpdates.compatibility.anyVersion', 'Any version') : (value ?? '—')
}

function notice(message: string): string {
  const messages: Record<string, string> = {
    'Existing pip check issues are reported separately and are not attributed to this update.':
      'existingIssues',
    'Install or startup hooks changed and require review or Lab validation.': 'hookReview',
    'The target adds or changes native binary files and requires ABI review.': 'nativeReview',
    'The compiled runtime needs a verified capability profile before installation.':
      'runtimeReview',
    'Manager v4 pip installation permission is disabled for this instance.': 'pipPermission',
    'Manager v4 is configured for offline network mode.': 'offlinePolicy',
    'The target changes the protected Python, Torch, CUDA, NumPy, or accelerator stack.':
      'protectedBlocked',
    'The wheel plan conflicts with retained installed packages.': 'dependencyConflict',
    'This update requires a managed Python environment with offline backup support.':
      'managedRequired'
  }
  return messages[message]
    ? t(`pluginUpdates.compatibility.notes.${messages[message]}`, message)
    : message
}

function runUpdate(pluginIds: string[]): void {
  if (pluginIds.length === 0) return
  emit('run-action', {
    id: 'update-plugins',
    label: t('pluginUpdates.updateSelected', 'Update selected'),
    style: 'accent',
    showProgress: true,
    progressTitle: t('pluginUpdates.updating', 'Updating plugins'),
    cancellable: false,
    data: { pluginIds },
    confirm: {
      title: t('pluginUpdates.confirmTitle', 'Update custom nodes?'),
      message: t(
        'pluginUpdates.confirmMessage',
        'The instance will be stopped if needed. A snapshot is saved before Manager v4 updates the selected Git repositories and dependencies. ComfyUI will stay stopped; start it manually when you are ready.'
      ),
      confirmLabel: t('pluginUpdates.updateNow', 'Update now')
    }
  })
}

watch(
  () => props.installationId,
  () => {
    inventory.value = null
    selected.value = new Set()
    expanded.value = new Set()
    compatibilityPlans.value = new Map()
    compatibilityChecking.value = new Set()
    compatibilityOpen.value = null
    void loadLocalThenRefresh()
  }
)

onMounted(() => {
  void loadLocalThenRefresh()
  unsubscribe = window.api.onInstallationsChanged(() => void load(false))
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="plugin-updates" data-testid="plugin-update-pane">
    <header class="plugin-updates__header">
      <div>
        <h2>{{ t('pluginUpdates.title', 'Custom node updates') }}</h2>
        <p v-if="inventory" class="plugin-updates__checked">
          {{ t('pluginUpdates.checkedAt', { time: formatCheckedAt(inventory.checkedAt) }) }}
        </p>
      </div>
      <button
        type="button"
        class="brand-tertiary"
        :disabled="loading"
        data-testid="plugin-update-refresh"
        @click="load(true)"
      >
        <RefreshCw :size="15" :class="{ spin: loading }" />
        {{ t('pluginUpdates.checkNow', 'Check now') }}
      </button>
    </header>

    <div v-if="inventory" class="plugin-updates__summary">
      <span>{{ t('pluginUpdates.total', { n: inventory.summary.total }) }}</span>
      <span class="is-update">
        {{ t('pluginUpdates.available', { n: inventory.summary.updateAvailable }) }}
      </span>
      <span v-if="inventory.summary.attention > 0" class="is-warning">
        {{ t('pluginUpdates.attention', { n: inventory.summary.attention }) }}
      </span>
      <span v-if="refreshing" class="is-refreshing">
        {{ t('pluginUpdates.refreshing', 'Refreshing in background…') }}
      </span>
    </div>

    <section
      v-if="inventory?.lastRun"
      class="plugin-updates__last-run"
      :data-status="inventory.lastRun.ok ? 'success' : 'failed'"
    >
      <div class="plugin-updates__last-run-title">
        <strong>
          {{
            inventory.lastRun.ok
              ? t('pluginUpdates.lastRunSuccess', 'Last update completed')
              : t('pluginUpdates.lastRunFailed', 'Last update did not complete')
          }}
        </strong>
        <span>{{ formatCheckedAt(inventory.lastRun.completedAt) }}</span>
      </div>
      <ul>
        <li v-for="result in inventory.lastRun.items" :key="result.dirName">
          <span>{{ result.id }}</span>
          <span class="plugin-updates__run-status" :data-status="result.status">
            {{ runStatusLabel(result.status) }}
          </span>
        </li>
      </ul>
    </section>

    <div v-if="inventory && !inventory.mutable" class="plugin-updates__readonly" role="status">
      <AlertTriangle :size="17" />
      <span>{{ inventory.mutationBlockedReason }}</span>
    </div>

    <div class="plugin-updates__toolbar">
      <label class="plugin-updates__search">
        <Search :size="15" />
        <input
          v-model="query"
          type="search"
          :placeholder="t('pluginUpdates.search', 'Search plugins…')"
        />
      </label>
      <select v-model="filter" :aria-label="t('pluginUpdates.filter', 'Filter plugins')">
        <option value="all">{{ t('pluginUpdates.filterAll', 'All') }}</option>
        <option value="updates">{{ t('pluginUpdates.filterUpdates', 'Updates') }}</option>
        <option value="attention">
          {{ t('pluginUpdates.filterAttention', 'Needs attention') }}
        </option>
      </select>
    </div>

    <footer
      v-if="inventory?.mutable && updateableItems.length > 0"
      class="plugin-updates__actions"
      data-testid="plugin-update-actions"
    >
      <label class="plugin-updates__select-all">
        <input
          type="checkbox"
          :checked="allUpdateableSelected"
          :disabled="updateableItems.length === 0"
          @change="toggleAll"
        />
        {{ t('pluginUpdates.selectAll', 'Select all available') }}
      </label>
      <button
        type="button"
        class="brand-primary"
        :disabled="selectedCount === 0"
        data-testid="plugin-update-selected"
        @click="runUpdate([...selected])"
      >
        {{ t('pluginUpdates.updateSelectedCount', { n: selectedCount }) }}
      </button>
    </footer>

    <p v-if="error" class="plugin-updates__message is-error">{{ error }}</p>
    <p v-else-if="loading && !inventory" class="plugin-updates__message">
      {{ t('pluginUpdates.checking', 'Checking plugin updates…') }}
    </p>
    <p v-else-if="inventory && inventory.items.length === 0" class="plugin-updates__message">
      {{ t('pluginUpdates.empty', 'No custom nodes were found.') }}
    </p>

    <div v-if="inventory && inventory.items.length > 0" class="plugin-updates__list">
      <div
        v-for="item in filteredItems"
        :key="item.dirName"
        class="plugin-row"
        :class="{ 'is-selectable': item.updateable }"
      >
        <input
          type="checkbox"
          :checked="selected.has(item.dirName)"
          :disabled="!item.updateable"
          :aria-label="t('pluginUpdates.selectPlugin', { name: item.id })"
          @change="toggle(item)"
        />
        <span class="plugin-row__main">
          <span class="plugin-row__title">
            <strong>{{ item.id }}</strong>
            <span class="plugin-row__status" :data-status="item.status">
              <Check v-if="item.status === 'current'" :size="12" />
              <AlertTriangle
                v-else-if="attention.has(item.status) || item.status === 'unsupported'"
                :size="12"
              />
              {{ statusLabel(item.status) }}
            </span>
          </span>
          <span class="plugin-row__meta">
            <template v-if="item.sourceType === 'cnr'">
              <Package :size="13" />
              <span>{{ t('pluginUpdates.sourceCnr', 'Manager package') }}</span>
              <span>{{ item.installedVersion ?? '—' }} → {{ item.latestVersion ?? '—' }}</span>
            </template>
            <template v-else>
              <GitBranch :size="13" />
              {{ item.branch ?? '—' }}
              <span>{{ shortSha(item.localCommit) }} → {{ shortSha(item.remoteCommit) }}</span>
              <span v-if="item.behind">↓{{ item.behind }}</span>
              <span v-if="item.ahead">↑{{ item.ahead }}</span>
            </template>
            <span v-if="item.hasCompiledDependencies" class="plugin-row__compiled">
              {{ t('pluginUpdates.compiled', 'compiled deps') }}
            </span>
          </span>
          <span v-if="reasonText(item)" class="plugin-row__reason">{{ reasonText(item) }}</span>
        </span>
        <span class="plugin-row__controls">
          <button
            v-if="item.updateable"
            type="button"
            class="plugin-row__update-button"
            :data-testid="`plugin-update-now-${item.dirName}`"
            @click="runUpdate([item.dirName])"
          >
            {{ t('pluginUpdates.updatePlugin', 'Update') }}
          </button>
          <button
            v-if="
              item.status === 'update-available' &&
              item.enabled &&
              (item.sourceType === 'cnr' || item.sourceType === 'git') &&
              inventory.mutable
            "
            type="button"
            class="plugin-row__compatibility-button"
            :data-verdict="compatibilityTone(compatibilityPlans.get(item.dirName))"
            :disabled="compatibilityChecking.has(item.dirName)"
            :data-testid="`plugin-compatibility-check-${item.dirName}`"
            @click="checkCompatibility(item)"
          >
            <RefreshCw v-if="compatibilityChecking.has(item.dirName)" :size="13" class="spin" />
            <ShieldCheck
              v-else-if="compatibilityPlans.get(item.dirName)?.verdict === 'ready'"
              :size="13"
            />
            <ShieldAlert v-else :size="13" />
            {{
              compatibilityChecking.has(item.dirName)
                ? compatibilityLabel('checking')
                : compatibilityLabel(compatibilityTone(compatibilityPlans.get(item.dirName)))
            }}
          </button>
          <button
            type="button"
            class="plugin-row__details-toggle"
            :aria-expanded="expanded.has(item.dirName)"
            :aria-label="t('pluginUpdates.showDetails', { name: item.id })"
            @click="toggleDetails(item.dirName)"
          >
            <ChevronDown :size="16" :class="{ 'is-open': expanded.has(item.dirName) }" />
          </button>
        </span>
        <section
          v-if="compatibilityOpen === item.dirName"
          class="compatibility-report"
          :data-verdict="compatibilityPlans.get(item.dirName)?.verdict ?? 'checking'"
          :data-testid="`plugin-compatibility-report-${item.dirName}`"
        >
          <template
            v-for="plan in [compatibilityPlans.get(item.dirName)]"
            :key="plan?.planDigest ?? 'checking'"
          >
            <template v-if="plan">
              <header class="compatibility-report__header">
                <span class="compatibility-report__heading">
                  <ShieldCheck v-if="plan.verdict === 'ready'" :size="17" />
                  <ShieldAlert v-else :size="17" />
                  <span>
                    <strong>{{ compatibilityLabel(plan.verdict) }}</strong>
                    <small
                      >{{ displayRef(plan.currentRef) }} → {{ displayRef(plan.targetRef) }}</small
                    >
                  </span>
                </span>
                <button
                  type="button"
                  class="compatibility-report__close"
                  :aria-label="t('pluginUpdates.compatibility.close', 'Close report')"
                  @click="compatibilityOpen = null"
                >
                  <X :size="15" />
                </button>
              </header>

              <div class="compatibility-report__metrics">
                <span>
                  <strong>{{ plan.packageChanges?.length ?? 0 }}</strong>
                  {{ t('pluginUpdates.compatibility.actualChanges', 'packages to install') }}
                </span>
                <span>
                  <strong>{{ plan.compiledDependencyDifferences.length }}</strong>
                  {{ t('pluginUpdates.compatibility.compiledChanges', 'compiled changes') }}
                </span>
                <span>
                  <strong>{{ plan.protectedStackDifferences.length }}</strong>
                  {{ t('pluginUpdates.compatibility.protectedChanges', 'protected changes') }}
                </span>
                <span>
                  <strong>{{ plan.nativeBinaryChanges.length }}</strong>
                  {{ t('pluginUpdates.compatibility.nativeChanges', 'native file changes') }}
                </span>
              </div>
              <div
                v-if="plan.dependencyConflicts?.length"
                class="compatibility-report__notice is-blocked"
                data-testid="plugin-dependency-conflicts"
              >
                <strong>{{ t('pluginUpdates.compatibility.conflictDetails') }}</strong>
                <ul>
                  <li v-for="conflict in plan.dependencyConflicts" :key="conflict.dependency">
                    <strong>{{ conflict.dependency }}</strong>
                    <p v-for="edge in conflict.requirements" :key="edge.owner + edge.constraint">
                      {{ edge.owner }} → {{ conflict.dependency }}{{ edge.constraint }}
                    </p>
                  </li>
                </ul>
                <p>{{ t('pluginUpdates.compatibility.conflictHint') }}</p>
              </div>
              <details v-if="plan.resolutionDetails" class="compatibility-report__details">
                <summary>{{ t('pluginUpdates.compatibility.resolverDetails') }}</summary>
                <pre class="compatibility-report__resolver-log">{{ plan.resolutionDetails }}</pre>
              </details>

              <div v-if="plan.blockers.length" class="compatibility-report__notice is-blocked">
                <strong>{{ t('pluginUpdates.compatibility.blockers', 'Blocking issues') }}</strong>
                <ul>
                  <li v-for="message in plan.blockers" :key="message">{{ notice(message) }}</li>
                </ul>
              </div>
              <div v-if="plan.warnings.length" class="compatibility-report__notice is-warning">
                <strong>{{ t('pluginUpdates.compatibility.warnings', 'Review notes') }}</strong>
                <ul>
                  <li v-for="message in plan.warnings" :key="message">{{ notice(message) }}</li>
                </ul>
              </div>

              <p v-if="plan.executionMode === 'source-only'" class="compatibility-report__notice">
                {{ t('pluginUpdates.compatibility.sourceOnlyHint') }}
                <br />
                {{
                  t('pluginUpdates.compatibility.sourceBackupSize', {
                    backup: formatBytes(plan.environmentBackupBytes)
                  })
                }}
              </p>
              <p
                v-else-if="plan.executionMode === 'isolated-review'"
                class="compatibility-report__notice is-warning"
              >
                {{ t('pluginUpdates.compatibility.isolatedHint') }}
              </p>
              <div
                v-if="plan.packageChanges?.length"
                class="compatibility-report__notice"
                data-testid="plugin-wheel-plan"
              >
                <strong>{{ t('pluginUpdates.compatibility.packagePlan') }}</strong>
                <p>
                  {{
                    t('pluginUpdates.compatibility.planSizes', {
                      download: formatBytes(plan.downloadBytes),
                      backup: formatBytes(plan.environmentBackupBytes)
                    })
                  }}
                </p>
                <p>{{ t('pluginUpdates.compatibility.retainRemoved') }}</p>
                <ul>
                  <li v-for="change in plan.packageChanges" :key="change.name">
                    <strong>{{ change.name }}: {{ change.from ?? '—' }} → {{ change.to }}</strong>
                    <p>{{ t(`pluginUpdates.compatibility.packageReason.${change.reason}`) }}</p>
                    <details>
                      <summary>{{ change.wheel.filename }}</summary>
                      <p>{{ change.wheel.url }}</p>
                      <p>SHA256: {{ change.wheel.sha256 }}</p>
                      <p>{{ change.wheel.tags.join(', ') }}</p>
                    </details>
                  </li>
                </ul>
              </div>

              <details
                v-if="plan.dependencyDifferences.length"
                class="compatibility-report__details"
              >
                <summary>
                  {{
                    t('pluginUpdates.compatibility.dependencyChanges', {
                      n: plan.dependencyDifferences.length
                    })
                  }}
                </summary>
                <ul class="compatibility-report__diffs">
                  <li v-for="difference in plan.dependencyDifferences" :key="difference.name">
                    <span>{{ difference.name }}</span>
                    <span
                      >{{ constraintLabel(difference.from) }} →
                      {{ constraintLabel(difference.to) }}</span
                    >
                    <small>{{ dependencyDifferenceLabel(difference.kind) }}</small>
                  </li>
                </ul>
              </details>

              <div class="compatibility-report__environment">
                <span
                  >Python {{ plan.environment.pythonVersion }} ({{
                    plan.environment.pythonArchitecture
                  }})</span
                >
                <span>Torch {{ plan.environment.torchVersion ?? '—' }}</span>
                <span>CUDA {{ plan.environment.cudaVersion ?? '—' }}</span>
                <span>NumPy {{ plan.environment.numpyVersion ?? '—' }}</span>
              </div>

              <footer class="compatibility-report__actions">
                <button
                  type="button"
                  class="brand-tertiary"
                  :disabled="compatibilityChecking.has(item.dirName)"
                  @click="checkCompatibility(item)"
                >
                  <RefreshCw :size="14" />
                  {{ t('pluginUpdates.compatibility.recheck', 'Check again') }}
                </button>
                <button
                  v-if="
                    plan.verdict === 'ready' ||
                    (plan.verdict === 'approval-required' &&
                      plan.executionMode === 'wheel-update' &&
                      plan.packageChanges?.length)
                  "
                  type="button"
                  class="brand-primary"
                  :data-testid="`plugin-compatibility-execute-${item.dirName}`"
                  @click="runCompatibleUpdate(item, plan)"
                >
                  <ShieldCheck :size="14" />
                  {{
                    plan.verdict === 'approval-required'
                      ? t('pluginUpdates.compatibility.approveExecute', 'Confirm and update')
                      : t('pluginUpdates.compatibility.execute', 'Update source')
                  }}
                </button>
              </footer>
            </template>
            <span v-else class="compatibility-report__loading">
              <RefreshCw :size="16" class="spin" />
              {{ compatibilityLabel('checking') }}
            </span>
          </template>
        </section>
        <div v-if="expanded.has(item.dirName)" class="plugin-row__details">
          <dl>
            <div>
              <dt>{{ t('pluginUpdates.detailSource', 'Source') }}</dt>
              <dd>{{ sourceLabel(item) }}</dd>
            </div>
            <div>
              <dt>{{ t('pluginUpdates.detailDirectory', 'Directory') }}</dt>
              <dd>{{ item.dirName }}</dd>
            </div>
            <div v-if="item.repository">
              <dt>{{ t('pluginUpdates.detailRepository', 'Repository') }}</dt>
              <dd class="is-path">{{ item.repository }}</dd>
            </div>
            <div>
              <dt>{{ t('pluginUpdates.detailInstalled', 'Installed') }}</dt>
              <dd>{{ displayRef(installedRef(item)) }}</dd>
            </div>
            <div>
              <dt>{{ t('pluginUpdates.detailAvailable', 'Available') }}</dt>
              <dd>{{ displayRef(targetRef(item)) }}</dd>
            </div>
            <div v-if="item.upstream">
              <dt>{{ t('pluginUpdates.detailUpstream', 'Upstream') }}</dt>
              <dd>{{ item.upstream }}</dd>
            </div>
            <div>
              <dt>{{ t('pluginUpdates.detailDependencies', 'Update hooks') }}</dt>
              <dd>
                {{
                  item.hasInstallScript
                    ? t('pluginUpdates.hasInstallScript', 'Install script')
                    : item.hasRequirements
                      ? t('pluginUpdates.hasRequirements', 'Python dependencies')
                      : t('pluginUpdates.noDependencyChanges', 'No declared dependency hook')
                }}
              </dd>
            </div>
            <div v-if="lastRunByDir.get(item.dirName)">
              <dt>{{ t('pluginUpdates.detailLastResult', 'Last result') }}</dt>
              <dd>
                {{ runStatusLabel(lastRunByDir.get(item.dirName)!.status) }}
                <span
                  v-if="
                    lastRunByDir.get(item.dirName)!.status === 'failed' &&
                    lastRunByDir.get(item.dirName)!.message
                  "
                >
                  — {{ lastRunByDir.get(item.dirName)!.message }}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <p v-if="filteredItems.length === 0" class="plugin-updates__message">
        {{ t('pluginUpdates.noMatches', 'No plugins match this filter.') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.plugin-updates {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 8px;
}
.plugin-updates__header,
.plugin-updates__toolbar,
.plugin-updates__actions,
.plugin-row__title,
.plugin-row__meta {
  display: flex;
  align-items: center;
}
.plugin-updates__header {
  justify-content: space-between;
  gap: 16px;
}
.plugin-updates__header h2 {
  margin: 0;
  font-size: 17px;
}
.plugin-updates__header button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.plugin-updates__checked {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}
.plugin-updates__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
}
.plugin-updates__summary span {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--surface);
}
.plugin-updates__summary .is-update {
  color: var(--accent);
}
.plugin-updates__summary .is-warning {
  color: #f0a020;
}
.plugin-updates__summary .is-refreshing {
  color: var(--text-muted);
}
.plugin-updates__last-run {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
}
.plugin-updates__last-run[data-status='failed'] {
  border-color: color-mix(in srgb, #f0a020 45%, var(--border));
  background: color-mix(in srgb, #f0a020 7%, var(--surface));
}
.plugin-updates__last-run-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.plugin-updates__last-run-title span {
  color: var(--text-muted);
}
.plugin-updates__last-run ul {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.plugin-updates__last-run li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border-radius: 6px;
  background: var(--surface);
  font-size: 11px;
}
.plugin-updates__run-status {
  color: var(--accent);
}
.plugin-updates__run-status[data-status='failed'],
.plugin-updates__run-status[data-status='rolled-back'] {
  color: #f0a020;
}
.plugin-updates__run-status[data-status='not-run'] {
  color: var(--text-muted);
}
.plugin-updates__readonly {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #f0a020 45%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, #f0a020 9%, transparent);
  font-size: 13px;
}
.plugin-updates__toolbar {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(132px, 168px);
  gap: 9px;
}
.plugin-updates__search {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
}
.plugin-updates__search input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
}
.plugin-updates__toolbar select {
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: inherit;
}
.plugin-updates__list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
}
.plugin-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: flex-start;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
  transition: background 140ms ease;
}
.plugin-row:hover {
  background: color-mix(in srgb, var(--surface) 45%, transparent);
}
.plugin-row:last-child {
  border-bottom: 0;
}
.plugin-row > input {
  margin-top: 4px;
}
.plugin-row.is-selectable > input {
  cursor: pointer;
}
.plugin-row__details-toggle {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.plugin-row__controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.plugin-row__compatibility-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, #f0a020 45%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, #f0a020 8%, transparent);
  color: #f0a020;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.plugin-row__update-button {
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.plugin-row__update-button:hover {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
}
.plugin-row__compatibility-button[data-verdict='ready'] {
  border-color: color-mix(in srgb, #48b56d 45%, var(--border));
  background: color-mix(in srgb, #48b56d 9%, transparent);
  color: #65c985;
}
.plugin-row__compatibility-button[data-verdict='blocked'],
.plugin-row__compatibility-button[data-verdict='error'] {
  border-color: color-mix(in srgb, var(--danger, #ef5350) 42%, var(--border));
  color: var(--danger, #ef5350);
}
.plugin-row__compatibility-button:disabled {
  cursor: wait;
  opacity: 0.72;
}
.plugin-row__details-toggle:hover {
  background: var(--surface);
  color: inherit;
}
.plugin-row__details-toggle svg {
  transition: transform 140ms ease;
}
.plugin-row__details-toggle svg.is-open {
  transform: rotate(180deg);
}
.plugin-row__details {
  grid-column: 2 / -1;
  padding: 9px 10px;
  border-radius: 7px;
  background: var(--surface);
}
.compatibility-report {
  grid-column: 2 / -1;
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-width: 0;
  padding: 12px;
  border: 1px solid color-mix(in srgb, #f0a020 42%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, #f0a020 5%, var(--surface));
}
.compatibility-report[data-verdict='ready'] {
  border-color: color-mix(in srgb, #48b56d 42%, var(--border));
  background: color-mix(in srgb, #48b56d 5%, var(--surface));
}
.compatibility-report[data-verdict='blocked'],
.compatibility-report[data-verdict='error'] {
  border-color: color-mix(in srgb, var(--danger, #ef5350) 42%, var(--border));
}
.compatibility-report__header,
.compatibility-report__heading,
.compatibility-report__actions,
.compatibility-report__loading {
  display: flex;
  align-items: center;
}
.compatibility-report__header {
  justify-content: space-between;
  gap: 12px;
}
.compatibility-report__heading {
  gap: 8px;
  min-width: 0;
}
.compatibility-report__heading > span {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.compatibility-report__heading small {
  margin-top: 2px;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}
.compatibility-report__close {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.compatibility-report__close:hover {
  background: color-mix(in srgb, var(--border) 55%, transparent);
  color: inherit;
}
.compatibility-report__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}
.compatibility-report__metrics span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--bg) 45%, transparent);
  color: var(--text-muted);
  font-size: 10px;
}
.compatibility-report__metrics strong {
  color: inherit;
  font-size: 15px;
}
.compatibility-report__notice {
  overflow-wrap: anywhere;
  padding: 9px 10px;
  border-radius: 7px;
  font-size: 11px;
  line-height: 1.45;
}
.compatibility-report__resolver-log {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 10px;
}
.compatibility-report__notice.is-blocked {
  background: color-mix(in srgb, var(--danger, #ef5350) 9%, transparent);
  color: var(--danger, #ef5350);
}
.compatibility-report__notice.is-warning {
  background: color-mix(in srgb, #f0a020 8%, transparent);
  color: #d99419;
}
.compatibility-report__notice ul,
.compatibility-report__diffs {
  margin: 5px 0 0;
  padding-left: 17px;
}
.compatibility-report__details {
  font-size: 11px;
}
.compatibility-report__details summary {
  color: var(--text-muted);
  cursor: pointer;
}
.compatibility-report__diffs li {
  display: grid;
  grid-template-columns: minmax(90px, 0.8fr) minmax(0, 1.4fr) auto;
  gap: 8px;
  padding: 4px 0;
}
.compatibility-report__diffs span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.compatibility-report__diffs small {
  color: var(--text-muted);
}
.compatibility-report__environment {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}
.compatibility-report__environment span {
  padding: 4px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
}
.compatibility-report__actions {
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.compatibility-report__actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.compatibility-report__loading {
  justify-content: center;
  gap: 8px;
  min-height: 52px;
  color: var(--text-muted);
  font-size: 12px;
}
.plugin-row__details dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px 16px;
  margin: 0;
}
.plugin-row__details dl > div {
  min-width: 0;
}
.plugin-row__details dt {
  margin-bottom: 2px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.plugin-row__details dd {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.plugin-row__details dd.is-path {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
.plugin-row__main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.plugin-row__title {
  justify-content: space-between;
  gap: 10px;
}
.plugin-row__title strong {
  overflow-wrap: anywhere;
}
.plugin-row__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 11px;
}
.plugin-row__status[data-status='update-available'] {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.plugin-row__status[data-status='dirty'],
.plugin-row__status[data-status='diverged'],
.plugin-row__status[data-status='unreachable'] {
  color: #f0a020;
}
.plugin-row__meta {
  flex-wrap: wrap;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
}
.plugin-row__compiled {
  color: #f0a020;
}
.plugin-row__reason {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.35;
}
.plugin-updates__message {
  margin: 18px 0;
  text-align: center;
  color: var(--text-muted);
}
.plugin-updates__message.is-error {
  color: var(--danger, #ef5350);
}
.plugin-updates__actions {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
}
.plugin-updates__select-all {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
}
.spin {
  animation: plugin-spin 0.9s linear infinite;
}
@keyframes plugin-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 680px) {
  .plugin-updates__toolbar {
    grid-template-columns: 1fr;
  }
  .plugin-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .plugin-row__controls {
    grid-column: 2;
    justify-content: space-between;
  }
  .plugin-row__details,
  .compatibility-report {
    grid-column: 1 / -1;
  }
  .compatibility-report__metrics {
    grid-template-columns: 1fr;
  }
  .compatibility-report__diffs li {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
