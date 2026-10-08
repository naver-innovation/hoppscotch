<template>
  <!-- [wasl] 프록시 주소는 서버 설정(PROXY_APP_URL)으로 고정된다(KernelInterceptorProxyStore). 읽기 전용으로 보여 주기만 한다. -->
  <div class="flex items-center space-x-2 py-4">
    <HoppSmartInput
      v-model="proxyUrl"
      :autofocus="false"
      styles="flex-1"
      :placeholder="' '"
      :label="t('settings.proxy_url')"
      input-styles="input floating-input"
      :disabled="true"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useService } from "dioc/vue"

import { useI18n } from "~/composables/i18n"
import { KernelInterceptorProxyStore } from "~/platform/std/kernel-interceptors/proxy/store"

const t = useI18n()

const store = useService(KernelInterceptorProxyStore)

const proxyUrl = ref(store.settings$.value.proxyUrl)

watch(
  () => store.settings$.value.proxyUrl,
  (storeUrl) => {
    proxyUrl.value = storeUrl
  },
  { immediate: true }
)
</script>
