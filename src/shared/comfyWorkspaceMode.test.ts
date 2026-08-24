import { describe, expect, it } from 'vitest'
import {
  COMFY_WORKSPACE_BROWSER,
  COMFY_WORKSPACE_EMBEDDED,
  resolveComfyWorkspaceMode,
  resolveComfyWorkspaceUrl,
  shouldOpenComfyWorkspaceInBrowser
} from './comfyWorkspaceMode'

describe('Comfy workspace presentation', () => {
  it('defaults missing and invalid settings to the system browser', () => {
    expect(resolveComfyWorkspaceMode(undefined)).toBe(COMFY_WORKSPACE_BROWSER)
    expect(resolveComfyWorkspaceMode('unsupported')).toBe(COMFY_WORKSPACE_BROWSER)
  })

  it('preserves the explicit embedded-window opt-in', () => {
    expect(resolveComfyWorkspaceMode(COMFY_WORKSPACE_EMBEDDED)).toBe(COMFY_WORKSPACE_EMBEDDED)
  })

  it('redirects only regular Comfy workspace launches', () => {
    expect(shouldOpenComfyWorkspaceInBrowser(undefined, 'window')).toBe(true)
    expect(shouldOpenComfyWorkspaceInBrowser(COMFY_WORKSPACE_EMBEDDED, 'window')).toBe(false)
    expect(shouldOpenComfyWorkspaceInBrowser(undefined, 'console')).toBe(false)
    expect(shouldOpenComfyWorkspaceInBrowser(undefined, 'external')).toBe(false)
  })

  it('uses an explicit URL when supplied and otherwise builds the loopback URL', () => {
    expect(resolveComfyWorkspaceUrl(8189)).toBe('http://127.0.0.1:8189')
    expect(resolveComfyWorkspaceUrl(8189, 'https://example.test/comfy')).toBe(
      'https://example.test/comfy'
    )
  })
})
