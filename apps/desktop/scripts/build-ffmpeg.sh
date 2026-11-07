#!/usr/bin/env bash
# 从官方源码编译剪辑器随应用分发的 ffmpeg / ffprobe（macOS，GPL 版，绝不含 nonfree）。
#
#   apps/desktop/scripts/build-ffmpeg.sh            # 本机架构（uname -m）
#   apps/desktop/scripts/build-ffmpeg.sh x86_64     # 在 Apple Silicon 上交叉编译 Intel 版（自检需 Rosetta）
#
# 产物：apps/desktop/resources/ffmpeg/darwin-<arm64|x64>/{ffmpeg,ffprobe,BUILDINFO.txt}
#       （目录名用 electron-builder 的 ${arch} / Node 的 process.arch 命名，x86_64 → x64）
# 许可证：同步刷新 apps/desktop/resources/ffmpeg-licenses/ 下各组件的许可证原文。
# 缓存：下载与中间产物放 ${SPARK_FFMPEG_BUILD_DIR:-$HOME/.cache/spark-ffmpeg-build}（仓库外）。
#
# 构建工具（Homebrew）：nasm pkgconf meson ninja autoconf automake libtool
# 依赖全部静态编译进独立 prefix；PKG_CONFIG_LIBDIR 只指向该 prefix，避免捡到 /opt/homebrew 的库。
set -euo pipefail
# 兼容 macOS 自带 bash 3.2：空数组用 ${A[@]+"${A[@]}"} 展开，避免 set -u 报 unbound

# ---------- 版本钉死（改版本 = 同时改 URL 与 SHA256） ----------
FFMPEG_VERSION=9.0.2
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e

# x264 没有正式 release，取 stable 分支的固定 commit（code.videolan.org 官方仓库的归档）
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_URL="https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/x264-${X264_COMMIT}.tar.bz2"
X264_SHA256=6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224

FREETYPE_VERSION=2.15.0
FREETYPE_URL="https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz"
FREETYPE_SHA256=93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5

FRIBIDI_VERSION=1.0.18
FRIBIDI_URL="https://github.com/fribidi/fribidi/releases/download/v${FRIBIDI_VERSION}/fribidi-${FRIBIDI_VERSION}.tar.xz"
FRIBIDI_SHA256=1de5e8073d035388b71d0b2d452b1da1f8caeea8a7702997b401fe1b6250727f

HARFBUZZ_VERSION=15.1.0
HARFBUZZ_URL="https://github.com/harfbuzz/harfbuzz/releases/download/${HARFBUZZ_VERSION}/harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
HARFBUZZ_SHA256=0fc7c565443a5f4be7da65ac5ee5bd737d9b158dc908708b7689a0a5796b0c8d

LIBASS_VERSION=0.17.5
LIBASS_URL="https://github.com/libass/libass/releases/download/${LIBASS_VERSION}/libass-${LIBASS_VERSION}.tar.xz"
LIBASS_SHA256=2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc

# Electron 45 最低支持 macOS 12
MACOS_MIN=12.0

# ---------- 参数与目录 ----------
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64) OUT_ARCH=arm64 ;;
  x86_64) OUT_ARCH=x64 ;;
  *) echo "不支持的架构：$ARCH（只支持 arm64 / x86_64）" >&2; exit 1 ;;
esac
[[ "$(uname -s)" == Darwin ]] || { echo "只支持在 macOS 上构建" >&2; exit 1; }
HOST_ARCH="$(uname -m)"
CROSS=0
[[ "$ARCH" != "$HOST_ARCH" ]] && CROSS=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$DESKTOP_DIR/resources/ffmpeg/darwin-$OUT_ARCH"
LICENSE_DIR="$DESKTOP_DIR/resources/ffmpeg-licenses"

CACHE="${SPARK_FFMPEG_BUILD_DIR:-$HOME/.cache/spark-ffmpeg-build}"
DL="$CACHE/downloads"
SRC="$CACHE/src-$ARCH"
PREFIX="$CACHE/prefix-$ARCH"
mkdir -p "$DL"
rm -rf "$SRC" "$PREFIX"
mkdir -p "$SRC" "$PREFIX"

for tool in nasm pkg-config meson ninja make clang; do
  command -v "$tool" >/dev/null || { echo "缺少构建工具：$tool（brew install nasm pkgconf meson ninja autoconf automake libtool）" >&2; exit 1; }
done

# ---------- 隔离环境：不让任何 Homebrew 库混进来 ----------
unset PKG_CONFIG_PATH CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH OBJC_INCLUDE_PATH \
  CFLAGS CXXFLAGS CPPFLAGS LDFLAGS DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
ARCH_FLAGS="-arch $ARCH -mmacosx-version-min=$MACOS_MIN"
export CC="clang" CXX="clang++"
export CFLAGS="$ARCH_FLAGS -O2 -I$PREFIX/include"
export CXXFLAGS="$ARCH_FLAGS -O2 -I$PREFIX/include"
export LDFLAGS="$ARCH_FLAGS -L$PREFIX/lib"
JOBS="$(sysctl -n hw.ncpu)"
AUTOTOOLS_HOST=()
[[ $CROSS == 1 ]] && AUTOTOOLS_HOST=(--host="$ARCH-apple-darwin")

MESON_CROSS=()
if [[ $CROSS == 1 ]]; then
  cat >"$CACHE/meson-cross-$ARCH.ini" <<EOF
[binaries]
c = 'clang'
cpp = 'clang++'
objc = 'clang'
ar = 'ar'
strip = 'strip'
pkg-config = 'pkg-config'

[built-in options]
c_args = ['-arch', '$ARCH', '-mmacosx-version-min=$MACOS_MIN']
cpp_args = ['-arch', '$ARCH', '-mmacosx-version-min=$MACOS_MIN']
c_link_args = ['-arch', '$ARCH', '-mmacosx-version-min=$MACOS_MIN']
cpp_link_args = ['-arch', '$ARCH', '-mmacosx-version-min=$MACOS_MIN']

[host_machine]
system = 'darwin'
cpu_family = '$ARCH'
cpu = '$ARCH'
endian = 'little'
EOF
  MESON_CROSS=(--cross-file "$CACHE/meson-cross-$ARCH.ini")
fi

START_TS=$(date +%s)
log() { printf '\n==> %s\n' "$*"; }

# 下载（已缓存则跳过）+ SHA256 校验 + 解压到 $SRC/<name>
fetch() {
  local name="$1" url="$2" sha="$3" file
  file="$DL/$(basename "$url")"
  if [[ ! -f "$file" ]]; then
    log "下载 $url"
    curl -fL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  local got
  got="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [[ "$got" != "$sha" ]]; then
    echo "SHA256 不匹配：$file" >&2
    echo "  期望 $sha" >&2
    echo "  实际 $got" >&2
    exit 1
  fi
  mkdir -p "$SRC/$name"
  tar -xf "$file" -C "$SRC/$name" --strip-components 1
}

meson_build() {
  local dir="$1"; shift
  (cd "$dir" && meson setup build ${MESON_CROSS[@]+"${MESON_CROSS[@]}"} --prefix="$PREFIX" --libdir=lib \
    --buildtype=release -Ddefault_library=static --wrap-mode=nodownload "$@" \
    && ninja -C build -j "$JOBS" && ninja -C build install)
}

# ---------- 依赖 ----------
log "x264 ($X264_COMMIT)"
fetch x264 "$X264_URL" "$X264_SHA256"
(cd "$SRC/x264" && ./configure --prefix="$PREFIX" ${AUTOTOOLS_HOST[@]+"${AUTOTOOLS_HOST[@]}"} \
  --enable-static --disable-cli --enable-pic --disable-opencl \
  --extra-cflags="$ARCH_FLAGS" --extra-ldflags="$ARCH_FLAGS" \
  && make -j "$JOBS" && make install-lib-static)

log "freetype $FREETYPE_VERSION"
fetch freetype "$FREETYPE_URL" "$FREETYPE_SHA256"
(cd "$SRC/freetype" && ./configure --prefix="$PREFIX" ${AUTOTOOLS_HOST[@]+"${AUTOTOOLS_HOST[@]}"} \
  --disable-shared --enable-static \
  --with-zlib=no --with-bzip2=no --with-png=no --with-harfbuzz=no --with-brotli=no --with-librsvg=no \
  && make -j "$JOBS" && make install)

log "fribidi $FRIBIDI_VERSION"
fetch fribidi "$FRIBIDI_URL" "$FRIBIDI_SHA256"
meson_build "$SRC/fribidi" -Ddocs=false -Dbin=false -Dtests=false

# ffmpeg 的 drawtext 用 hb-ft.h：harfbuzz 要带 FreeType 集成（FreeType 本身不反向依赖 harfbuzz，无循环）
log "harfbuzz $HARFBUZZ_VERSION"
fetch harfbuzz "$HARFBUZZ_URL" "$HARFBUZZ_SHA256"
meson_build "$SRC/harfbuzz" -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
  -Dicu=disabled -Dgraphite2=disabled -Dfreetype=enabled -Dcoretext=disabled -Dtests=disabled \
  -Ddocs=disabled -Dintrospection=disabled -Dutilities=disabled -Dbenchmark=disabled

log "libass $LIBASS_VERSION"
fetch libass "$LIBASS_URL" "$LIBASS_SHA256"
(cd "$SRC/libass" && ./configure --prefix="$PREFIX" ${AUTOTOOLS_HOST[@]+"${AUTOTOOLS_HOST[@]}"} \
  --disable-shared --enable-static \
  --disable-fontconfig --enable-coretext --disable-libunibreak --enable-require-system-font-provider \
  && make -j "$JOBS" && make install)

# ---------- ffmpeg ----------
FFMPEG_ARGS=(
  --prefix="$PREFIX"
  --cc=clang --cxx=clang++
  --enable-gpl
  --enable-libx264
  --enable-libass
  --enable-libfreetype
  --enable-libfribidi
  --enable-libharfbuzz
  --enable-videotoolbox
  --enable-audiotoolbox
  --disable-ffplay
  # sdl2 会经 PATH 里 Homebrew 的 sdl2-config 绕过 PKG_CONFIG_LIBDIR 被自动探测到（虽然关了 ffplay 后无人使用），显式关掉
  --disable-sdl2
  --disable-doc
  --disable-debug
  --disable-shared --enable-static
  --pkg-config-flags=--static
  --extra-cflags="$ARCH_FLAGS -I$PREFIX/include"
  --extra-ldflags="$ARCH_FLAGS -L$PREFIX/lib"
  # harfbuzz 是 C++ 写的，静态链接要补 libc++（系统库 /usr/lib/libc++.1.dylib）
  --extra-libs=-lc++
)
[[ $CROSS == 1 ]] && FFMPEG_ARGS+=(--enable-cross-compile --arch="$ARCH" --target-os=darwin)

# 硬检查：nonfree 的产物不可再分发，绝不允许出现
for a in "${FFMPEG_ARGS[@]}"; do
  if [[ "$a" == *nonfree* ]]; then echo "configure 参数里出现 nonfree：$a —— 拒绝构建" >&2; exit 1; fi
done

log "ffmpeg $FFMPEG_VERSION"
fetch ffmpeg "$FFMPEG_URL" "$FFMPEG_SHA256"
(cd "$SRC/ffmpeg" && ./configure "${FFMPEG_ARGS[@]}")
# 防漏：configure 结果里不许出现 Homebrew / /usr/local 的头文件或库路径（会让产物在别的机器跑不起来）
if grep -nE '/opt/homebrew|/usr/local' "$SRC/ffmpeg/ffbuild/config.mak"; then
  echo "ffmpeg configure 捡到了 Homebrew / /usr/local 的依赖（见上），拒绝继续" >&2; exit 1
fi
(cd "$SRC/ffmpeg" && make -j "$JOBS")

mkdir -p "$OUT_DIR"
install -m 755 "$SRC/ffmpeg/ffmpeg" "$OUT_DIR/ffmpeg"
install -m 755 "$SRC/ffmpeg/ffprobe" "$OUT_DIR/ffprobe"

# ---------- 许可证原文（随 extraResources 进 Resources/ffmpeg/licenses） ----------
mkdir -p "$LICENSE_DIR"
cp "$SRC/ffmpeg/COPYING.GPLv2" "$LICENSE_DIR/ffmpeg-COPYING.GPLv2"
cp "$SRC/ffmpeg/LICENSE.md" "$LICENSE_DIR/ffmpeg-LICENSE.md"
cp "$SRC/x264/COPYING" "$LICENSE_DIR/x264-COPYING"
cp "$SRC/freetype/LICENSE.TXT" "$LICENSE_DIR/freetype-LICENSE.TXT"
cp "$SRC/freetype/docs/GPLv2.TXT" "$LICENSE_DIR/freetype-GPLv2.TXT"
cp "$SRC/freetype/docs/FTL.TXT" "$LICENSE_DIR/freetype-FTL.TXT"
cp "$SRC/fribidi/COPYING" "$LICENSE_DIR/fribidi-COPYING"
cp "$SRC/harfbuzz/COPYING" "$LICENSE_DIR/harfbuzz-COPYING"
cp "$SRC/libass/COPYING" "$LICENSE_DIR/libass-COPYING"

# ---------- 自检（任何一项失败即非零退出） ----------
log "自检"
FF="$OUT_DIR/ffmpeg"
FP="$OUT_DIR/ffprobe"
RUN=()
[[ $CROSS == 1 && "$ARCH" == x86_64 ]] && RUN=(arch -x86_64)
fail() { echo "自检失败：$*" >&2; exit 1; }

for bin in "$FF" "$FP"; do
  file "$bin" | grep -q "Mach-O 64-bit executable $ARCH" || fail "$(file "$bin")"
  # 只允许依赖系统库（/usr/lib、/System/Library）
  bad="$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)' || true)"
  [[ -z "$bad" ]] || fail "$(basename "$bin") 依赖了非系统库：$bad"
done
# 先把输出存进变量再 grep：直接 `ffmpeg ... | grep -q` 时 grep 先退出会让 ffmpeg 收到 SIGPIPE，
# pipefail 下整条管道算失败——「有」被误判成「没有」，「| grep -q X && fail」则被静默跳过
ff_out() { ${RUN[@]+"${RUN[@]}"} "$@"; }
FF_LICENSE="$(ff_out "$FF" -hide_banner -L)"
FP_LICENSE="$(ff_out "$FP" -hide_banner -L)"
FF_BUILDCONF="$(ff_out "$FF" -hide_banner -buildconf)"
FF_FILTERS="$(ff_out "$FF" -hide_banner -filters)"
FF_ENCODERS="$(ff_out "$FF" -hide_banner -encoders)"
if grep -qi "not legally redistributable" <<<"$FF_LICENSE"; then fail "ffmpeg -L 显示 not legally redistributable"; fi
if grep -qi "not legally redistributable" <<<"$FP_LICENSE"; then fail "ffprobe -L 显示 not legally redistributable"; fi
grep -q "GNU General Public License" <<<"$FF_LICENSE" || fail "ffmpeg -L 不是 GPL"
if grep -q nonfree <<<"$FF_BUILDCONF"; then fail "ffmpeg -buildconf 含 nonfree"; fi
grep -qE '^ \S+ subtitles ' <<<"$FF_FILTERS" || fail "缺 subtitles 滤镜"
grep -qE '^ V\S* libx264 ' <<<"$FF_ENCODERS" || fail "缺 libx264 编码器"
grep -qE '^ A\S* aac ' <<<"$FF_ENCODERS" || fail "缺 aac 编码器"

# ---------- BUILDINFO ----------
{
  echo "Spark 自建 ffmpeg / ffprobe（GPL 版，无 nonfree）"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)  arch: $ARCH  macOS min: $MACOS_MIN  host: $(sw_vers -productVersion) $(clang --version | head -1)"
  echo "script: apps/desktop/scripts/build-ffmpeg.sh"
  echo
  echo "components (name  version  url  sha256):"
  echo "ffmpeg    $FFMPEG_VERSION  $FFMPEG_URL  $FFMPEG_SHA256"
  echo "x264      $X264_COMMIT  $X264_URL  $X264_SHA256"
  echo "freetype  $FREETYPE_VERSION  $FREETYPE_URL  $FREETYPE_SHA256"
  echo "fribidi   $FRIBIDI_VERSION  $FRIBIDI_URL  $FRIBIDI_SHA256"
  echo "harfbuzz  $HARFBUZZ_VERSION  $HARFBUZZ_URL  $HARFBUZZ_SHA256"
  echo "libass    $LIBASS_VERSION  $LIBASS_URL  $LIBASS_SHA256"
  echo
  echo "ffmpeg -version:"
  ff_out "$FF" -hide_banner -version
} | sed "s#$CACHE#\$SPARK_FFMPEG_BUILD_DIR#g" >"$OUT_DIR/BUILDINFO.txt"

log "完成（$(( $(date +%s) - START_TS ))s）：$OUT_DIR"
ls -la "$OUT_DIR"
