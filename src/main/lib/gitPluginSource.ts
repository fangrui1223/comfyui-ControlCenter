import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function git(cwd: string, args: string[], env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      }
    )
  })
}

/** Materialize Git's checkout bytes using a disposable index and object database.
 * No checkout, index refresh, hooks, or custom filters run in the installed repo.
 */
export async function exportGitPluginCheckout(
  source: string,
  ref: string,
  destination: string
): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'fr-plugin-git-checkout-'))
  try {
    const metadata = path.join(scratch, 'repo.git')
    const emptyHooks = path.join(scratch, 'hooks')
    await fs.mkdir(emptyHooks)
    // Carry only checkout formatting into the disposable repo. In particular,
    // global filter commands, templates, URL rewrites and hooks are not copied.
    const config = new Map<string, string>()
    for (const key of ['core.autocrlf', 'core.eol', 'core.attributesFile']) {
      const value = await git(source, ['config', '--null', '--get', key]).catch(() => '')
      if (value) config.set(key, value.replace(/\0$/, ''))
    }
    if (config.has('core.attributesFile')) {
      const attributePath = await git(source, ['config', '--path', '--get', 'core.attributesFile'])
      config.set('core.attributesFile', path.resolve(source, attributePath.trim()))
    }
    const objects = path.resolve(
      source,
      (await git(source, ['rev-parse', '--git-path', 'objects'])).trim()
    )
    const infoAttributes = path.resolve(
      source,
      (await git(source, ['rev-parse', '--git-path', 'info/attributes'])).trim()
    )
    const commit = (await git(source, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
    const currentEntries = (await git(source, ['ls-tree', '-r', '-z', 'HEAD']))
      .split('\0')
      .filter(Boolean)
    const unchanged = new Map(
      currentEntries.map((entry) => {
        const separator = entry.indexOf('\t')
        return [entry.slice(separator + 1), entry.slice(0, separator)]
      })
    )
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid target Git commit.')
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        /^GIT_CONFIG(?:_|$)/.test(key) ||
        [
          'GIT_DIR',
          'GIT_WORK_TREE',
          'GIT_INDEX_FILE',
          'GIT_OBJECT_DIRECTORY',
          'GIT_ALTERNATE_OBJECT_DIRECTORIES',
          'GIT_COMMON_DIR'
        ].includes(key)
      )
        delete env[key]
    }
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' })
    await git(scratch, ['init', '--bare', `--template=${emptyHooks}`, metadata], env)
    await fs.mkdir(path.join(metadata, 'info'), { recursive: true })
    await fs.writeFile(
      path.join(metadata, 'objects', 'info', 'alternates'),
      objects.replaceAll('\\', '/') + '\n'
    )
    if (
      await fs.stat(infoAttributes).then(
        (stat) => stat.isFile(),
        () => false
      )
    )
      await fs.copyFile(infoAttributes, path.join(metadata, 'info', 'attributes'))
    const args = [
      `--git-dir=${metadata}`,
      `--work-tree=${destination}`,
      '-c',
      'core.symlinks=false',
      '-c',
      'core.longpaths=true',
      '-c',
      `core.hooksPath=${emptyHooks}`,
      ...[...config].flatMap(([key, value]) => ['-c', `${key}=${value}`])
    ]
    await git(scratch, [...args, 'read-tree', commit], env)
    const entries = (await git(scratch, [...args, 'ls-tree', '-r', '-l', '-z', commit], env))
      .split('\0')
      .filter(Boolean)
    if (entries.length > 50_000) throw new Error('Git tree exceeds compatibility staging limits.')
    let bytes = 0
    const files = entries.map((entry) => {
      const match = /^(100644|100755) blob [a-f0-9]+\s+(\d+)\t(.+)$/s.exec(entry)
      if (!match) throw new Error('Git links or submodules require separate compatibility review.')
      bytes += Number(match[2])
      if (bytes > 1024 * 1024 * 1024)
        throw new Error('Git tree exceeds compatibility staging limits.')
      const relative = match[3]!
      if (
        relative.includes('\\') ||
        !path.resolve(destination, relative).startsWith(path.resolve(destination) + path.sep)
      )
        throw new Error('Git tree path escaped staging directory.')
      return relative
    })
    // An inspection must not execute a repository's LFS/custom smudge filter.
    // Reject it before checkout instead of approving its unfiltered pointer.
    for (let offset = 0; offset < files.length; offset += 100) {
      const attributes = (
        await git(
          scratch,
          [
            ...args,
            'check-attr',
            '--cached',
            '-z',
            'filter',
            'working-tree-encoding',
            '--',
            ...files.slice(offset, offset + 100)
          ],
          env
        )
      ).split('\0')
      for (let index = 0; index + 2 < attributes.length; index += 3) {
        if (!['unspecified', 'unset'].includes(attributes[index + 2]!))
          throw new Error(
            `Git checkout attribute ${attributes[index + 1]} requires separate review: ${attributes[index]}`
          )
      }
    }
    await git(
      scratch,
      [
        ...args,
        'checkout-index',
        '--all',
        '--force',
        `--prefix=${path.resolve(destination).replaceAll('\\', '/')}/`
      ],
      env
    )
    // A normal pull retains files whose tree entries did not change. Their
    // existing checkout bytes may predate an autocrlf/config change, so a fresh
    // checkout's bytes would incorrectly reject an otherwise clean update.
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\s+\d+\t(.+)$/s.exec(entry)!
      const relative = match[3]!
      if (unchanged.get(relative) !== `${match[1]} blob ${match[2]}`) continue
      const previous = path.resolve(source, relative)
      if (!(await fs.lstat(previous)).isFile())
        throw new Error('Existing Git source is not a regular file.')
      await fs.copyFile(previous, path.resolve(destination, relative))
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
