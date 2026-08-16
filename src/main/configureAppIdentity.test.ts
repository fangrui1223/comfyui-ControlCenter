import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FR_PRODUCT_NAME } from '../shared/frProduct'

describe('FR Electron identity bootstrap', () => {
  const originalE2E = process.env['E2E']
  const originalUserData = process.env['FR_CONTROL_CENTER_E2E_USER_DATA']
  const originalPosthog = process.env['POSTHOG_ENABLED']

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('electron')
    if (originalE2E === undefined) delete process.env['E2E']
    else process.env['E2E'] = originalE2E
    if (originalUserData === undefined) delete process.env['FR_CONTROL_CENTER_E2E_USER_DATA']
    else process.env['FR_CONTROL_CENTER_E2E_USER_DATA'] = originalUserData
    if (originalPosthog === undefined) delete process.env['POSTHOG_ENABLED']
    else process.env['POSTHOG_ENABLED'] = originalPosthog
  })

  it('sets product name, isolated userData, logs and fail-closed telemetry before main loads', async () => {
    const setName = vi.fn()
    const setPath = vi.fn()
    const setAppLogsPath = vi.fn()
    const isolated = path.resolve('C:\\e2e\\fr-profile')
    process.env['E2E'] = '1'
    process.env['FR_CONTROL_CENTER_E2E_USER_DATA'] = isolated
    vi.doMock('electron', () => ({
      app: {
        setName,
        setPath,
        setAppLogsPath,
        getPath: vi.fn(() => 'C:\\Users\\test\\AppData\\Roaming')
      }
    }))

    await import('./configureAppIdentity')

    expect(setName).toHaveBeenCalledExactlyOnceWith(FR_PRODUCT_NAME)
    expect(setPath).toHaveBeenCalledExactlyOnceWith('userData', isolated)
    expect(setAppLogsPath).toHaveBeenCalledExactlyOnceWith(path.join(isolated, 'logs'))
    expect(process.env['POSTHOG_ENABLED']).toBe('0')
  })
})
