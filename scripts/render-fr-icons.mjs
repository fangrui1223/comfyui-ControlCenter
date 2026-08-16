import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const source = await readFile(path.join(root, 'assets', 'FR_ControlCenter.svg'), 'utf8')
const browserCandidates = [
  chromium.executablePath(),
  process.env['PROGRAMFILES(X86)']
    ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : '',
  process.env['PROGRAMFILES']
    ? path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    : '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter((candidate) => candidate && existsSync(candidate))

if (browserCandidates.length === 0) {
  throw new Error('No Chromium-compatible browser was found for FR icon rendering')
}

const browser = await chromium.launch({ headless: true, executablePath: browserCandidates[0] })

try {
  for (const size of [32, 64, 256, 512, 1024]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1
    })
    await page.setContent(
      `<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`
    )
    await page.locator('svg').screenshot({
      path: path.join(root, 'assets', `FR_ControlCenter_x${size}.png`),
      omitBackground: true
    })
    await page.close()
  }

  const macSource = path.join(root, 'assets', 'FR_ControlCenter_x1024.png')
  const macTarget = path.join(root, 'assets', 'FR_ControlCenter_mac_x1024.png')
  const { copyFile } = await import('node:fs/promises')
  await copyFile(macSource, macTarget)
} finally {
  await browser.close()
}
