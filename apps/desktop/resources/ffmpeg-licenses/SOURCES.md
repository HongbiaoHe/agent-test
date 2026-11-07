# Spark 随附的 ffmpeg / ffprobe：组件、许可证与对应源码

Spark 桌面端在 `Spark.app/Contents/Resources/ffmpeg/` 附带的 `ffmpeg`、`ffprobe` 由我们从下列官方源码
**未经修改**地编译（GPL 版，未启用 `--enable-nonfree`）。整体按 **GNU GPL v2 或更高版本** 分发，
许可证原文见本目录；每次构建的精确版本与参数另见同级的 `../BUILDINFO.txt`。

## 组件

| 组件 | 版本 | 许可证 | 官方源码 | SHA256 |
| --- | --- | --- | --- | --- |
| FFmpeg | 9.0.2 | GPL-2.0-or-later（因 `--enable-gpl`；见 `ffmpeg-COPYING.GPLv2`、`ffmpeg-LICENSE.md`） | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| x264 | stable 分支 commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | GPL-2.0-or-later（`x264-COPYING`） | https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2 | `6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224` |
| FreeType | 2.15.0 | FTL 或 GPL-2.0 双许可，本分发选用 GPL-2.0（`freetype-LICENSE.TXT`、`freetype-GPLv2.TXT`、`freetype-FTL.TXT`） | https://download.savannah.gnu.org/releases/freetype/freetype-2.15.0.tar.xz | `93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5` |
| GNU FriBidi | 1.0.18 | LGPL-2.1-or-later（`fribidi-COPYING`） | https://github.com/fribidi/fribidi/releases/download/v1.0.18/fribidi-1.0.18.tar.xz | `1de5e8073d035388b71d0b2d452b1da1f8caeea8a7702997b401fe1b6250727f` |
| HarfBuzz | 15.1.0 | MIT（"Old MIT"，`harfbuzz-COPYING`） | https://github.com/harfbuzz/harfbuzz/releases/download/15.1.0/harfbuzz-15.1.0.tar.xz | `0fc7c565443a5f4be7da65ac5ee5bd737d9b158dc908708b7689a0a5796b0c8d` |
| libass | 0.17.5 | ISC（`libass-COPYING`） | https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz | `2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc` |

所有组件均静态链接；运行时只依赖 macOS 系统库与系统框架（VideoToolbox、AudioToolbox、CoreText 等）。

## 如何获得对应源码并复现构建

1. 从上表的官方地址下载源码包，并用 `shasum -a 256` 核对哈希。
2. 构建脚本：Spark 源码仓库中的 `apps/desktop/scripts/build-ffmpeg.sh`（包含全部依赖的编译参数）。
   在 macOS 上安装 `nasm pkgconf meson ninja autoconf automake libtool` 后运行
   `apps/desktop/scripts/build-ffmpeg.sh`（Apple Silicon）或 `apps/desktop/scripts/build-ffmpeg.sh x86_64`（Intel）。
3. FFmpeg 的 configure 参数（`<prefix>` 为依赖的安装目录，`<arch>` 为 arm64 / x86_64）：

```
--prefix=<prefix> --cc=clang --cxx=clang++ --enable-gpl --enable-libx264 --enable-libass
--enable-libfreetype --enable-libfribidi --enable-libharfbuzz --enable-videotoolbox
--enable-audiotoolbox --disable-ffplay --disable-sdl2 --disable-doc --disable-debug --disable-shared --enable-static
--pkg-config-flags=--static
--extra-cflags='-arch <arch> -mmacosx-version-min=12.0 -I<prefix>/include'
--extra-ldflags='-arch <arch> -mmacosx-version-min=12.0 -L<prefix>/lib'
--extra-libs=-lc++
（x86_64 交叉编译时另加 --enable-cross-compile --arch=x86_64 --target-os=darwin）
```

