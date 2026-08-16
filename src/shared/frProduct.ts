export const FR_PRODUCT_NAME = 'FR ComfyUI Control Center'
export const FR_SHORT_PRODUCT_NAME = 'FR Control Center'
export const FR_PACKAGE_NAME = 'fr-comfyui-control-center'
export const FR_APP_DATA_DIRECTORY = 'FR-ComfyUI-ControlCenter'

/**
 * The fork does not inherit Comfy-Org's Desktop release feed.  Keep app
 * self-updates disabled until a user-owned FR release channel is configured.
 * ComfyUI Core, frontend, Manager and custom-node updates remain separate
 * per-install transactions.
 */
export const FR_APP_UPDATE_CHANNEL_CONFIGURED = false

/** No FR-owned analytics endpoints exist yet; never send fork usage to upstream. */
export const FR_TELEMETRY_CHANNEL_CONFIGURED = false
