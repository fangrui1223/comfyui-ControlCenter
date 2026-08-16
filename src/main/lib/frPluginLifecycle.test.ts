import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evaluateDedicatedInstallPolicy,
  evaluateManagerV4Policy,
  isManagerLoopback,
  scanLegacyPluginCatalog
} from './frPluginLifecycle'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Manager v4 policy mirror', () => {
  it('matches the local and remote middle+ network-position rules', () => {
    expect(
      evaluateManagerV4Policy({
        risk: 'middle+',
        securityLevel: 'normal',
        networkMode: 'public',
        listenAddress: '127.0.0.1'
      }).allowed
    ).toBe(true)
    expect(
      evaluateManagerV4Policy({
        risk: 'middle+',
        securityLevel: 'weak',
        networkMode: 'public',
        listenAddress: '0.0.0.0'
      })
    ).toEqual({ allowed: false, reason: 'network-position' })
    expect(
      evaluateManagerV4Policy({
        risk: 'middle+',
        securityLevel: 'normal',
        networkMode: 'personal_cloud',
        listenAddress: '0.0.0.0'
      }).allowed
    ).toBe(true)
  })

  it('requires weak for remote high+ and never allows block', () => {
    expect(
      evaluateManagerV4Policy({
        risk: 'high+',
        securityLevel: 'normal-',
        networkMode: 'personal_cloud',
        listenAddress: '0.0.0.0'
      }).allowed
    ).toBe(false)
    expect(
      evaluateManagerV4Policy({
        risk: 'high+',
        securityLevel: 'weak',
        networkMode: 'personal_cloud',
        listenAddress: '0.0.0.0'
      }).allowed
    ).toBe(true)
    expect(
      evaluateManagerV4Policy({
        risk: 'block',
        securityLevel: 'weak',
        networkMode: 'personal_cloud',
        listenAddress: '127.0.0.1'
      }).allowed
    ).toBe(false)
  })

  it('keeps direct git and pip flags independent from security level', () => {
    expect(
      evaluateDedicatedInstallPolicy({
        enabled: true,
        networkMode: 'public',
        listenAddress: '127.0.0.1'
      })
    ).toBe(true)
    expect(
      evaluateDedicatedInstallPolicy({
        enabled: true,
        networkMode: 'public',
        listenAddress: '0.0.0.0'
      })
    ).toBe(false)
    expect(
      evaluateDedicatedInstallPolicy({
        enabled: false,
        networkMode: 'personal_cloud',
        listenAddress: '0.0.0.0'
      })
    ).toBe(false)
  })

  it('accepts only literal loopback IP addresses like Manager v4', () => {
    expect(isManagerLoopback('127.12.0.3')).toBe(true)
    expect(isManagerLoopback('::1')).toBe(true)
    expect(isManagerLoopback('localhost')).toBe(false)
    expect(isManagerLoopback('0.0.0.0')).toBe(false)
  })
})

describe('legacy plugin catalog', () => {
  it('holds plugins back and identifies ABI-sensitive and redundant plugins', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-plugins-'))
    temporaryRoots.push(root)
    const source = path.join(root, 'stable')
    const target = path.join(root, 'next')
    const customNodes = path.join(source, 'custom_nodes')
    fs.mkdirSync(path.join(customNodes, 'ComfyUI-Rife-Tensorrt'), { recursive: true })
    fs.writeFileSync(
      path.join(customNodes, 'ComfyUI-Rife-Tensorrt', 'requirements.txt'),
      'tensorrt\n'
    )
    fs.mkdirSync(path.join(customNodes, 'ComfyUI_Memory_Cleanup'), { recursive: true })
    fs.writeFileSync(path.join(customNodes, 'ComfyUI_Memory_Cleanup', '__init__.py'), '')

    const catalog = scanLegacyPluginCatalog(source, target, '2026-08-16T00:00:00.000Z')

    expect(catalog.summary.total).toBe(2)
    expect(catalog.summary.compiledDependencyCandidates).toBe(1)
    expect(catalog.summary.retireCandidates).toBe(1)
    expect(
      catalog.entries.find((entry) => entry.directoryName === 'ComfyUI-Rife-Tensorrt')
        ?.migrationDisposition
    ).toBe('clean-install-required')
    expect(
      catalog.entries.find((entry) => entry.directoryName === 'ComfyUI_Memory_Cleanup')?.lifecycle
    ).toBe('retired')
  })
})
