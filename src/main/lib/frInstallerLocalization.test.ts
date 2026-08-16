import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..', '..', '..')
const installerPath = path.join(root, 'scripts', 'installer.nsh')
const builderPath = path.join(root, 'electron-builder.yml')

describe('FR Windows installer localization', () => {
  const installer = fs.readFileSync(installerPath, 'utf8')
  const builder = fs.readFileSync(builderPath, 'utf8')

  it('builds one multilingual English and Simplified Chinese installer', () => {
    expect(builder).toMatch(/installerLanguages:\s*\r?\n\s*- en_US\s*\r?\n\s*- zh_CN/)
    expect(builder).toMatch(/multiLanguageInstaller:\s*true/)
    expect(builder).toMatch(/displayLanguageSelector:\s*false/)
  })

  it('defines every FR-owned LangString in both languages', () => {
    const definitions = [...installer.matchAll(/^\s*LangString\s+(FR\w+)\s+(1033|2052)\s+/gm)]
    const byName = new Map<string, Set<string>>()
    for (const definition of definitions) {
      const name = definition[1]
      const locale = definition[2]
      if (!name || !locale) continue
      const locales = byName.get(name) ?? new Set<string>()
      locales.add(locale)
      byName.set(name, locales)
    }

    expect(byName.size).toBeGreaterThan(20)
    const incomplete = [...byName.entries()]
      .filter(([, locales]) => !locales.has('1033') || !locales.has('2052'))
      .map(([name, locales]) => `${name}: ${[...locales].join(',')}`)
    expect(incomplete, `missing installer language pair:\n${incomplete.join('\n')}`).toEqual([])
  })

  it('does not leave user-facing custom install output hard-coded in English', () => {
    const hardCoded = installer
      .split(/\r?\n/)
      .filter((line) => /^\s*(DetailPrint|MessageBox)\b/.test(line))
      .filter((line) => !line.includes('$(FR') && !/^\s*DetailPrint\s+""/.test(line))
    expect(hardCoded).toEqual([])
  })
})
