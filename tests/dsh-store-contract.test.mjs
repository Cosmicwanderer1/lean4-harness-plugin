/**
 * @author ygw
 *
 * 验证插件固定 Commit 可分发契约，防止后续改动重新引入安装期构建依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/**
 * 读取插件 manifest。
 * 参数：无。
 * 返回：解析后的 package.json 对象。
 */
async function readManifest() {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
}

test('DSH STORE 固定 Commit 包含运行产物、许可证和精确兼容性声明', async () => {
  const manifest = await readManifest()

  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'https://github.com/Cosmicwanderer1/lean4-harness-plugin.git',
  })
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.dsh.compatibility.dsh, '0.1.3-alpha.2')
  assert.equal(manifest.dsh.compatibility.dshReleases['0.1.3-alpha.2'], 'compatible')
  assert.deepEqual(manifest.dsh.compatibility.profiles, ['web'])
  assert.deepEqual(manifest.os, ['win32'])
  assert.ok(manifest.files.includes('dist/'))

  await access(resolve(root, 'LICENSE'), constants.R_OK)
  await access(resolve(root, 'dist/index.js'), constants.R_OK)
  await access(resolve(root, 'dist/index.d.ts'), constants.R_OK)
})

test('DSH STORE 发行包不依赖安装期生命周期脚本', async () => {
  const manifest = await readManifest()

  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[name], undefined, `${name} 不应存在`)
  }
})
