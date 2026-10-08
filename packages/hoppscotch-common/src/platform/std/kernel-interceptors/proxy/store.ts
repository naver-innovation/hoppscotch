import { ref, readonly, toRaw, type Ref, type DeepReadonly } from "vue"
import { Service } from "dioc"
import { Store } from "~/kernel/store"
import { getDefaultProxyUrl, fallbackProxyUrl } from "~/helpers/proxyUrl"
import * as E from "fp-ts/Either"

const STORE_NAMESPACE = "interceptors.proxy.v1"
const SETTINGS_KEY = "settings"

export type ProxySettings = {
  version: "v1"
  proxyUrl: string
  accessToken: string
}

interface StoredData {
  version: string
  settings: ProxySettings
  lastUpdated: string
}

/**
 * Build fresh default settings.
 * Called as a function (not a static const) so that `getDefaultProxyUrl()`
 * can resolve against the current platform, which isn't available at
 * module-load time.
 */
async function buildDefaultSettings(): Promise<ProxySettings> {
  return {
    version: "v1",
    proxyUrl: await getDefaultProxyUrl(),
    accessToken: import.meta.env.VITE_PROXYSCOTCH_ACCESS_TOKEN ?? "",
  }
}

// [wasl] 프록시 주소는 서버 설정(PROXY_APP_URL)으로 고정한다. 사용자가 바꾸거나(설정 화면 · 다른 탭 · 저장값) 공개 프록시로
// 떨어지면 서버 쪽 프록시(호출 감사 · 목적지 통제)를 거치지 않는 길이 생긴다 - 예: PC 에서 띄운 proxyscotch 를 가리키는 주소.
/**
 * Reactive proxy settings store.
 *
 * Exposes `settings$` as a readonly ref, any component or service that reads
 * `settings$.value` will automatically re-render when settings change.
 */
export class KernelInterceptorProxyStore extends Service {
  public static readonly ID = "KERNEL_PROXY_INTERCEPTOR_STORE"

  private readonly _settings = ref<ProxySettings>({
    version: "v1",
    proxyUrl: fallbackProxyUrl(),
    accessToken: import.meta.env.VITE_PROXYSCOTCH_ACCESS_TOKEN ?? "",
  })

  private _resolveReady!: () => void
  // Resolves once persisted settings have been loaded into `_settings`.
  // Callers that read `proxyUrl` on initial page load (e.g. the OAuth redirect
  // handler) must await this to avoid using the in-memory default URL.
  private readonly _ready: Promise<void> = new Promise((resolve) => {
    this._resolveReady = resolve
  })

  /**
   * Reactive, read-only view of the current proxy settings.
   */
  public readonly settings$: DeepReadonly<Ref<ProxySettings>> = readonly(
    this._settings
  )

  async onServiceInit(): Promise<void> {
    try {
      const initResult = await Store.init()
      if (E.isLeft(initResult)) {
        console.error(
          "[ProxyStore] Failed to initialize store:",
          initResult.left
        )
        return
      }

      await this.loadSettings()
      // [wasl] 다른 탭의 변경을 따라가는 Store.watch 는 두지 않는다 - 동기화할 사용자 설정(proxyUrl)이 없다.
    } catch (error) {
      console.error("[ProxyStore] Failed to finish setup:", error)
    } finally {
      // Always resolve readiness so consumers never hang forever.
      this._resolveReady()
    }
  }

  public whenReady(): Promise<void> {
    return this._ready
  }

  private async loadSettings(): Promise<void> {
    const loadResult = await Store.get<StoredData>(
      STORE_NAMESPACE,
      SETTINGS_KEY
    )

    const defaults = await buildDefaultSettings()

    if (E.isRight(loadResult) && loadResult.right) {
      const storedData = loadResult.right
      // Reject persisted proxyUrl that wouldn't survive backend validation
      // (e.g. junk left over from before client-side validation existed).
      // Without this, execute() would post requests to an invalid URL.
      const persistedProxyUrl = storedData.settings?.proxyUrl
      // [wasl] 저장된 값은 쓰지 않고 서버 설정만 쓴다. 다르면 아래에서 덮어쓴다.
      const proxyUrl = defaults.proxyUrl
      this._settings.value = {
        ...defaults,
        // Only restore user-configurable fields from storage.
        // accessToken is env-derived (VITE_PROXYSCOTCH_ACCESS_TOKEN) and
        // must always reflect the current deployment, not a stale persisted value.
        proxyUrl,
      }
      // If we had to discard a bad persisted value, write the corrected
      // settings back so we don't repeat the fallback on every boot.
      if (proxyUrl !== persistedProxyUrl) {
        await this.persistSettings()
      }
    } else {
      this._settings.value = { ...defaults }
      await this.persistSettings()
    }
  }

  private async persistSettings(): Promise<void> {
    const rawSettings = toRaw(this._settings.value)

    const storedData: StoredData = {
      version: "v1",
      settings: { ...rawSettings },
      lastUpdated: new Date().toISOString(),
    }

    const saveResult = await Store.set(
      STORE_NAMESPACE,
      SETTINGS_KEY,
      storedData
    )

    if (E.isLeft(saveResult)) {
      console.error("[ProxyStore] Failed to save settings:", saveResult.left)
    }
  }

  /**
   * Update user-configurable proxy settings.
   * Only `proxyUrl` is user-configurable, `accessToken` and `version` are
   * derived at runtime and cannot be overwritten by callers.
   */
  public async updateSettings(
    patch: Pick<ProxySettings, "proxyUrl">
  ): Promise<void> {
    // [wasl] 프록시 주소는 서버 설정으로 고정한다 - 바꾸지 않는다.
    console.warn(
      "[ProxyStore] Proxy URL is fixed by the server (PROXY_APP_URL), ignored:",
      patch.proxyUrl
    )
  }

  /**
   * @deprecated Use `settings$` for reactive access. This exists only for
   * non-reactive contexts (e.g. inside `execute()` in the interceptor service).
   */
  public getSettings(): ProxySettings {
    return { ...this._settings.value }
  }

  public async resetSettings(): Promise<void> {
    this._settings.value = await buildDefaultSettings()
    await this.persistSettings()
  }
}
