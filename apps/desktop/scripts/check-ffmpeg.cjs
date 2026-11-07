// electron-builder 的 beforePack 钩子：确认要打进包的 ffmpeg / ffprobe 是 scripts/build-ffmpeg.sh 自建的 GPL 版。
// 对应架构的产物不存在、或 `-L` / `-buildconf` 显示 nonfree（不可再分发）→ 抛错让打包失败。
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('electron-builder');

/** @param {import('electron-builder').BeforePackContext} context */
module.exports = async function checkFfmpeg(context) {
  const arch = Arch[context.arch]; // 'arm64' / 'x64'，与 electron-builder.yml 里的 ${arch} 一致
  const platform = context.electronPlatformName;
  const dir = join(context.packager.projectDir, 'resources', 'ffmpeg', `${platform}-${arch}`);
  const hint = `请先运行 apps/desktop/scripts/build-ffmpeg.sh${arch === 'x64' ? ' x86_64' : ''} 构建 ${platform}-${arch} 的 ffmpeg`;
  for (const name of ['ffmpeg', 'ffprobe']) {
    const bin = join(dir, name);
    if (!existsSync(bin)) throw new Error(`缺少自建 ${name}：${bin}。${hint}`);
    const license = execFileSync(bin, ['-hide_banner', '-L'], { encoding: 'utf8' });
    if (/not legally redistributable/i.test(license) || !license.includes('GNU General Public License')) {
      throw new Error(`${bin} 不是可分发的 GPL 版（-L 显示 nonfree 或非 GPL）。${hint}`);
    }
    const buildconf = execFileSync(bin, ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
    if (buildconf.includes('nonfree')) throw new Error(`${bin} 编译时开了 nonfree，不可分发。${hint}`);
  }
  console.log(`  • ffmpeg check passed  dir=${dir}`);
};
