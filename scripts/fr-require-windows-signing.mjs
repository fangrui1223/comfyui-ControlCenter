import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function getWindowsSigningProvider(env = process.env) {
  const link = env.WIN_CSC_LINK?.trim()
  const password = env.WIN_CSC_KEY_PASSWORD?.trim()
  const subjectName = env.CSC_NAME?.trim()

  if (link || password) {
    if (!link || !password) {
      throw new Error(
        'Signed release blocked: WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD must be provided together.'
      )
    }
    return 'PFX/PKCS#12 certificate (WIN_CSC_LINK)'
  }

  if (subjectName) return 'Windows certificate store (CSC_NAME)'

  throw new Error(
    'Signed release blocked: no code-signing identity is configured. Set WIN_CSC_LINK plus WIN_CSC_KEY_PASSWORD, or select an installed certificate with CSC_NAME.'
  )
}

function main() {
  try {
    const provider = getWindowsSigningProvider()
    console.log(`Windows signing preflight passed: ${provider}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()
