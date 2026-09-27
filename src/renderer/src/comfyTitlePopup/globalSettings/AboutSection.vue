<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FR_PRODUCT_NAME } from '../../../../shared/frProduct'

const props = defineProps<{
  version: string
  platform: string
}>()
const { t } = useI18n()
const platformLabel = computed(() => {
  switch (props.platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return props.platform || '—'
  }
})
</script>

<template>
  <div class="about-section">
    <h3 class="about-product">{{ FR_PRODUCT_NAME }}</h3>
    <dl class="about-details">
      <div class="about-row">
        <dt>{{ t('settings.version', 'Version') }}</dt>
        <dd>{{ version || '—' }}</dd>
      </div>
      <div class="about-row">
        <dt>{{ t('settings.platform', 'Platform') }}</dt>
        <dd>{{ platformLabel }}</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.about-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 12px 0;
}

.about-product {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text);
}

.about-details {
  display: flex;
  flex-direction: column;
  margin: 0;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}

.about-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 12px;
}

.about-row + .about-row {
  border-top: 1px solid var(--chooser-surface-border);
}

.about-row dt {
  flex-shrink: 0;
  color: var(--text-muted);
}

.about-row dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  text-align: right;
  user-select: text;
}
</style>
