import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function removeWithRetry(directory, attempts = 20) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await delay(250)
    }
  }
  throw lastError
}

async function readDevToolsPort(candidates) {
  for (const userDataPath of candidates) {
    try {
      const contents = await fs.readFile(path.join(userDataPath, 'DevToolsActivePort'), 'utf8')
      const port = Number.parseInt(contents.split(/\r?\n/, 1)[0] ?? '', 10)
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      // The app has not created this profile or its DevTools marker yet.
    }
  }
  return undefined
}

async function waitForPackagedSurfaces(child, userDataCandidates, output, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let port

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Packaged application exited before startup completed (code ${child.exitCode}).\n${output.join('')}`,
      )
    }

    port ??= await readDevToolsPort(userDataCandidates)
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        if (response.ok) {
          const targets = await response.json()
          const urls = targets.map((target) => String(target.url ?? ''))
          if (
            urls.some((url) => url.includes('panel.html')) &&
            urls.some((url) => url.includes('comfyTitleBar.html'))
          ) {
            return urls
          }
        }
      } catch {
        // DevTools can publish its port shortly before the HTTP endpoint is ready.
      }
    }

    await delay(250)
  }

  throw new Error(`Packaged application startup timed out.\n${output.join('')}`)
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The packaged Windows smoke test can only run on Windows.')
  }

  const executablePath = path.resolve(
    process.argv[2] ?? 'dist/win-unpacked/FR ComfyUI Control Center.exe',
  )
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'fr-control-center-packaged-smoke-'))
  const appDataRoot = path.join(scratch, 'AppData', 'Roaming')
  const localAppDataRoot = path.join(scratch, 'AppData', 'Local')
  const explicitUserData = path.join(scratch, 'userData')
  const userDataCandidates = [
    explicitUserData,
    path.join(appDataRoot, 'FR-ComfyUI-ControlCenter'),
    path.join(appDataRoot, 'fr-comfyui-control-center'),
  ]
  await Promise.all([
    fs.mkdir(appDataRoot, { recursive: true }),
    fs.mkdir(localAppDataRoot, { recursive: true }),
    fs.mkdir(explicitUserData, { recursive: true }),
  ])

  const output = []
  const child = spawn(executablePath, ['--remote-debugging-port=0'], {
    env: {
      ...process.env,
      APPDATA: appDataRoot,
      LOCALAPPDATA: localAppDataRoot,
      HOME: scratch,
      USERPROFILE: scratch,
      E2E: '1',
      FR_CONTROL_CENTER_E2E_USER_DATA: explicitUserData,
      E2E_SETTINGS_SEED: JSON.stringify({
        firstUseCompleted: true,
        telemetryEnabled: false,
        language: 'zh-CN',
      }),
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  child.stderr?.on('data', (chunk) => output.push(String(chunk)))

  let passed = false
  try {
    const urls = await waitForPackagedSurfaces(child, userDataCandidates, output)
    passed = true
    console.log(
      `Packaged Windows startup smoke passed: ${urls.filter((url) => url.includes('.html')).join(', ')}`,
    )
  } finally {
    if (child.exitCode === null && child.pid) {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    }
    if (passed) {
      await removeWithRetry(scratch)
    } else {
      console.error(`Packaged startup diagnostics preserved at ${scratch}`)
    }
  }
}

await main()
