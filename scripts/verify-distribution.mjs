/**
 * @author ygw
 *
 * DSH STORE 固定 Commit 发行契约的本地只读检查。
 * 参数：无。
 * 返回：成功时输出检查通过信息；失败时抛出错误并使进程以非零状态退出。
 */
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifestPath = resolve(root, 'package.json')
const lifecycleNames = ['preinstall', 'install', 'postinstall', 'prepare']

/**
 * 断言条件成立。
 * 参数：condition 为待判断条件；message 为失败说明。
 * 返回：条件不成立时抛出 Error，成立时不返回值。
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 确认固定 Commit 必须携带的普通文件存在。
 * 参数：relativePath 为相对仓库根目录的路径。
 * 返回：文件存在时完成；缺失时抛出 Error。
 */
async function assertReadableFile(relativePath) {
  try {
    await access(resolve(root, relativePath), constants.R_OK)
  } catch {
    throw new Error(`发行文件缺失或不可读：${relativePath}`)
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const repositoryUrl = typeof manifest.repository === 'string'
  ? manifest.repository
  : manifest.repository?.url

assert(repositoryUrl === 'https://github.com/Cosmicwanderer1/lean4-harness-plugin.git',
  'repository 必须精确指向 canonical GitHub 仓库')
assert(manifest.license === 'MIT', 'manifest license 必须为 MIT')
assert(Array.isArray(manifest.files) && manifest.files.includes('dist/'),
  'files 必须包含受控运行目录 dist/')
assert(typeof manifest.engines?.node === 'string' && manifest.engines.node !== '',
  '必须声明 Node.js 兼容范围')
assert(manifest.dsh?.compatibility?.dsh === '0.1.3-alpha.2',
  '必须声明经过验证的精确 DSH 版本')
assert(manifest.dsh?.compatibility?.dshReleases?.['0.1.3-alpha.2'] === 'compatible',
  '必须将已验证的 DSH 版本标记为 compatible')

for (const name of lifecycleNames) {
  assert(typeof manifest.scripts?.[name] !== 'string', `禁止安装期生命周期脚本：${name}`)
}

for (const path of ['LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
  await assertReadableFile(path)
}

process.stdout.write('DSH_STORE_DISTRIBUTION_OK\n')
