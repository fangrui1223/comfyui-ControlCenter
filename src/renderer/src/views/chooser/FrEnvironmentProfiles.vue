<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, FlaskConical, FolderSearch, ShieldCheck, Sparkles } from 'lucide-vue-next'
import { useModal } from '../../composables/useModal'
import type {
  FrEnvironmentManagementMode,
  FrEnvironmentProfileView,
  FrEnvironmentRole
} from '../../../../shared/frEnvironmentProfiles'

const { t } = useI18n()
const modal = useModal()
const profiles = ref<FrEnvironmentProfileView[]>([])
const loading = ref(true)
const busyRole = ref<FrEnvironmentRole | null>(null)
let unsubscribe: (() => void) | undefined

const orderedProfiles = computed(() => profiles.value)

function roleTitle(role: FrEnvironmentRole): string {
  return t(`frEnvironments.roles.${role}.title`)
}

function roleDescription(role: FrEnvironmentRole): string {
  return t(`frEnvironments.roles.${role}.description`)
}

function displayPath(profile: FrEnvironmentProfileView): string {
  return profile.path ?? profile.suggestedPath
}

function modeLabel(profile: FrEnvironmentProfileView): string {
  return t(`frEnvironments.modes.${profile.mode}`)
}

function folderStateLabel(profile: FrEnvironmentProfileView): string {
  return t(`frEnvironments.folderStates.${profile.folderState}`)
}

async function refresh(): Promise<void> {
  loading.value = true
  if (typeof window.api.getFrEnvironmentProfiles !== 'function') {
    // Keeps an older preload / renderer hot-reload mismatch non-fatal. A full
    // restart upgrades the bridge; never infer or scan profiles meanwhile.
    loading.value = false
    return
  }
  try {
    profiles.value = await window.api.getFrEnvironmentProfiles()
  } catch (error) {
    await modal.alert({
      title: t('frEnvironments.loadFailedTitle'),
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    loading.value = false
  }
}

async function confirmManaged(role: FrEnvironmentRole, folderPath: string): Promise<boolean> {
  return modal.confirm({
    title: t('frEnvironments.managedConfirmTitle', { name: roleTitle(role) }),
    message: t('frEnvironments.managedConfirmMessage', { path: folderPath }),
    confirmLabel: t('frEnvironments.authorizeManaged'),
    confirmStyle: 'primary'
  })
}

async function persist(
  profile: FrEnvironmentProfileView,
  mode: FrEnvironmentManagementMode,
  folderPath?: string | null
): Promise<void> {
  busyRole.value = profile.role
  try {
    profiles.value = await window.api.saveFrEnvironmentProfile({
      role: profile.role,
      mode,
      path: mode === 'unregistered' ? null : (folderPath ?? profile.path)
    })
  } catch (error) {
    await modal.alert({
      title: t('frEnvironments.saveFailedTitle'),
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    busyRole.value = null
  }
}

async function chooseAndRegister(
  profile: FrEnvironmentProfileView,
  mode: Exclude<FrEnvironmentManagementMode, 'unregistered'>
): Promise<void> {
  const selected = await window.api.browseFolder(displayPath(profile))
  if (!selected) return
  if (mode === 'managed' && !(await confirmManaged(profile.role, selected))) return
  await persist(profile, mode, selected)
}

async function toggleMode(profile: FrEnvironmentProfileView): Promise<void> {
  if (!profile.path) return
  if (profile.mode === 'read-only') {
    if (!(await confirmManaged(profile.role, profile.path))) return
    await persist(profile, 'managed')
  } else if (profile.mode === 'managed') {
    await persist(profile, 'read-only')
  }
}

async function disconnect(profile: FrEnvironmentProfileView): Promise<void> {
  const confirmed = await modal.confirm({
    title: t('frEnvironments.disconnectTitle', { name: roleTitle(profile.role) }),
    message: t('frEnvironments.disconnectMessage'),
    confirmLabel: t('frEnvironments.disconnect'),
    confirmStyle: 'danger'
  })
  if (confirmed) await persist(profile, 'unregistered')
}

async function openFolder(profile: FrEnvironmentProfileView): Promise<void> {
  if (profile.path && profile.folderState === 'directory') {
    await window.api.openPath(profile.path)
  }
}

onMounted(() => {
  void refresh()
  if (typeof window.api.onFrEnvironmentProfilesChanged === 'function') {
    unsubscribe = window.api.onFrEnvironmentProfilesChanged((next) => {
      profiles.value = next
    })
  }
})

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <section class="fr-environments" aria-labelledby="fr-environments-title">
    <div class="fr-environments__heading">
      <div>
        <h2 id="fr-environments-title">{{ t('frEnvironments.title') }}</h2>
        <p>{{ t('frEnvironments.subtitle') }}</p>
      </div>
      <span class="fr-environments__safety"
        ><ShieldCheck :size="14" />{{ t('frEnvironments.noTakeover') }}</span
      >
    </div>

    <div v-if="loading" class="fr-environments__loading">{{ t('common.loading') }}</div>
    <div v-else class="fr-environments__grid">
      <article
        v-for="profile in orderedProfiles"
        :key="profile.role"
        class="fr-environment-card"
        :data-role="profile.role"
      >
        <header>
          <component
            :is="
              profile.role === 'stable'
                ? ShieldCheck
                : profile.role === 'next'
                  ? Sparkles
                  : FlaskConical
            "
            :size="18"
          />
          <div>
            <h3>{{ roleTitle(profile.role) }}</h3>
            <p>{{ roleDescription(profile.role) }}</p>
          </div>
          <span class="fr-environment-card__mode" :data-mode="profile.mode">{{
            modeLabel(profile)
          }}</span>
        </header>

        <div class="fr-environment-card__path" :title="displayPath(profile)">
          <FolderSearch :size="14" />
          <span>{{ displayPath(profile) }}</span>
        </div>
        <div class="fr-environment-card__state" :data-state="profile.folderState">
          {{ folderStateLabel(profile) }}
        </div>

        <div v-if="profile.mode === 'unregistered'" class="fr-environment-card__actions">
          <button
            type="button"
            :disabled="busyRole === profile.role"
            @click="chooseAndRegister(profile, 'read-only')"
          >
            {{ t('frEnvironments.registerReadOnly') }}
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="busyRole === profile.role"
            @click="chooseAndRegister(profile, 'managed')"
          >
            {{ t('frEnvironments.authorizeManaged') }}
          </button>
        </div>
        <div v-else class="fr-environment-card__actions">
          <button
            type="button"
            :disabled="profile.folderState !== 'directory'"
            @click="openFolder(profile)"
          >
            <ExternalLink :size="13" />{{ t('frEnvironments.openFolder') }}
          </button>
          <button type="button" class="secondary" @click="toggleMode(profile)">
            {{
              profile.mode === 'managed'
                ? t('frEnvironments.switchReadOnly')
                : t('frEnvironments.authorizeManaged')
            }}
          </button>
          <button type="button" class="ghost" @click="chooseAndRegister(profile, profile.mode)">
            {{ t('frEnvironments.changeFolder') }}
          </button>
          <button type="button" class="ghost danger" @click="disconnect(profile)">
            {{ t('frEnvironments.disconnect') }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.fr-environments {
  grid-row: 4;
  width: min(100%, 1176px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fr-environments__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  padding: 0 4px;
}
.fr-environments__heading h2,
.fr-environments__heading p,
.fr-environment-card h3,
.fr-environment-card p {
  margin: 0;
}
.fr-environments__heading h2 {
  font-size: 14px;
  color: var(--neutral-100);
}
.fr-environments__heading p {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
}
.fr-environments__safety {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #6ce8c5;
  font-size: 11px;
  white-space: nowrap;
}
.fr-environments__loading {
  min-height: 94px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}
.fr-environments__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.fr-environment-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--neutral-600) 45%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, #0d1428 88%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 4%);
}
.fr-environment-card header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  color: #78e8ff;
}
.fr-environment-card h3 {
  font-size: 13px;
  color: var(--neutral-100);
}
.fr-environment-card p {
  margin-top: 1px;
  font-size: 10px;
  color: var(--text-muted);
}
.fr-environment-card__mode {
  padding: 3px 7px;
  border-radius: 999px;
  background: rgb(255 255 255 / 7%);
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
}
.fr-environment-card__mode[data-mode='read-only'] {
  color: #8ed9ff;
  background: rgb(75 164 232 / 14%);
}
.fr-environment-card__mode[data-mode='managed'] {
  color: #7ff0c8;
  background: rgb(70 205 157 / 14%);
}
.fr-environment-card__path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--neutral-300);
  font:
    10px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.fr-environment-card__path span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fr-environment-card__state {
  margin: 3px 0 9px 20px;
  color: var(--text-muted);
  font-size: 10px;
}
.fr-environment-card__state[data-state='directory'] {
  color: #6ce8c5;
}
.fr-environment-card__state[data-state='missing'],
.fr-environment-card__state[data-state='not-directory'],
.fr-environment-card__state[data-state='inaccessible'] {
  color: #ffb271;
}
.fr-environment-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fr-environment-card__actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 26px;
  padding: 4px 8px;
  border: 1px solid rgb(103 216 255 / 34%);
  border-radius: 7px;
  background: rgb(75 164 232 / 18%);
  color: #dff8ff;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.fr-environment-card__actions button.secondary {
  border-color: rgb(128 137 255 / 30%);
  background: rgb(105 91 210 / 15%);
}
.fr-environment-card__actions button.ghost {
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}
.fr-environment-card__actions button.danger {
  color: #ff9b9b;
}
.fr-environment-card__actions button:hover:not(:disabled) {
  filter: brightness(1.25);
}
.fr-environment-card__actions button:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.fr-environment-card__actions button:disabled {
  opacity: 0.38;
  cursor: default;
}
@media (max-width: 860px) {
  .fr-environments__grid {
    grid-template-columns: 1fr;
  }
  .fr-environments__safety {
    display: none;
  }
}
</style>
