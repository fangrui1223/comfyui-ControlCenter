import { describe, expect, it } from 'vitest'
import { getWindowsSigningProvider } from '../../../scripts/fr-require-windows-signing.mjs'

describe('Windows signed-release preflight', () => {
  it('rejects an empty signing configuration', () => {
    expect(() => getWindowsSigningProvider({})).toThrow(/no code-signing identity/i)
  })

  it('requires the PFX location and password together', () => {
    expect(() => getWindowsSigningProvider({ WIN_CSC_LINK: 'publisher.pfx' })).toThrow(
      /must be provided together/i
    )
    expect(() => getWindowsSigningProvider({ WIN_CSC_KEY_PASSWORD: 'secret' })).toThrow(
      /must be provided together/i
    )
  })

  it('accepts a complete PFX configuration without exposing the password', () => {
    expect(
      getWindowsSigningProvider({
        WIN_CSC_LINK: 'publisher.pfx',
        WIN_CSC_KEY_PASSWORD: 'do-not-print'
      })
    ).toBe('PFX/PKCS#12 certificate (WIN_CSC_LINK)')
  })

  it('accepts a certificate selected from the Windows certificate store', () => {
    expect(getWindowsSigningProvider({ CSC_NAME: 'FR AI' })).toBe(
      'Windows certificate store (CSC_NAME)'
    )
  })
})
