/**
 * 沙箱换档迁移的纯逻辑（不依赖沙箱 SDK，单测直接跑）：用户选的排除项校验、盘点 / 统计 / 打包 /
 * 拉取解包脚本、输出解析。编排见 sandbox-migration.service.ts。
 *
 * 排除项由用户在迁移前盘点时自己选（设置页列出文件 / 文件夹占用与文件类型），不写死：
 * - paths：相对工作区的文件或文件夹，精确匹配、区分大小写；
 * - exts：扩展名，任意层级、不区分大小写。
 * 统计（find）与打包（tar）按同一份排除项生成，迁移前后两次统计才能对得上。
 *
 * 数据路径（2026-11-04 实测 2.5 GB 工作区后定下）：旧沙箱 tar 成一个文件 → 新沙箱用 curl 拉旧沙箱的
 * 下载直链、边下边解包。文件只在 E2B 两台沙箱之间走，不经后端与本机代理——之前经后端中转 2.5 GB，
 * 几分钟后 fetch failed。归档不压缩：工作区大头是视频 / 图片，gzip 在 2 vCPU 上白耗几分钟。
 */

export interface MigrationExcludes {
  /** 相对工作区的文件或文件夹（如 work/reel、out/a.mp4） */
  paths: string[];
  /** 扩展名，不带点、小写（如 mp4） */
  exts: string[];
}

export const NO_EXCLUDES: MigrationExcludes = { paths: [], exts: [] };

/** 盘点时自动找出、默认帮用户勾掉的依赖目录（任意层级同名）；用户可以改回来 */
export const DEPENDENCY_DIR_NAMES = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pnpm-store',
] as const;

/** 总是不迁移：后台任务状态（换档前后台任务必须都结束了） */
const ALWAYS_EXCLUDED_PATHS = ['.bg'];

const MAX_PATHS = 2000;
const MAX_EXTS = 50;

/** 相对工作区的安全路径：非空、不以 / 开头、不含 .. 段与控制字符 */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith('/')) return false;
  if ([...p].some((c) => c.charCodeAt(0) < 0x20)) return false;
  return p.split('/').every((seg) => seg !== '..' && seg !== '');
}

/** 用户提交的排除项 → 规整（去重、去尾 /、扩展名小写去点）；不合法返回 null */
export function normalizeExcludes(input: unknown): MigrationExcludes | null {
  if (input === undefined || input === null) return NO_EXCLUDES;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const rawPaths: unknown = 'paths' in input ? input.paths : [];
  const rawExts: unknown = 'exts' in input ? input.exts : [];
  if (!Array.isArray(rawPaths) || !Array.isArray(rawExts)) return null;
  if (rawPaths.length > MAX_PATHS || rawExts.length > MAX_EXTS) return null;
  const paths = new Set<string>();
  for (const p of rawPaths) {
    if (typeof p !== 'string') return null;
    const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!isSafeRelPath(clean)) return null;
    paths.add(clean);
  }
  const exts = new Set<string>();
  for (const e of rawExts) {
    if (typeof e !== 'string') return null;
    const clean = e.replace(/^\./, '').toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(clean)) return null;
    exts.add(clean);
  }
  return { paths: [...paths], exts: [...exts] };
}

/** 迁移归档在旧沙箱里的落点（新沙箱边下边解，不落文件） */
export const MIGRATION_ARCHIVE = '/tmp/spark-workspace-migrate.tar';

/** 单引号包住任意字符串给 shell 用（签名直链、带空格 / 引号的文件名） */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** find -path 的模式要转义 glob 元字符，才能按字面精确匹配 */
function globEscape(s: string): string {
  return s.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/**
 * find 的过滤段（不含 -printf）：排除路径整棵剪掉、排除扩展名的文件跳过，其余普通文件往下走。
 * 生成形如：`\( -path './.bg' -o -path './work/reel' \) -prune -o -type f \( -iname '*.mp4' \) -o -type f`
 */
function findFilter(ex: MigrationExcludes): string {
  const paths = [...ALWAYS_EXCLUDED_PATHS, ...ex.paths]
    .map((p) => `-path ${shellQuote(`./${globEscape(p)}`)}`)
    .join(' -o ');
  const exts = ex.exts.length
    ? `-type f \\( ${ex.exts.map((e) => `-iname '*.${e}'`).join(' -o ')} \\) -o `
    : '';
  return `\\( ${paths} \\) -prune -o ${exts}-type f`;
}

/**
 * 统计工作区（按排除项）的普通文件数与总字节数，输出「FILES n」「BYTES b」两行。
 * 用 %.0f 而不是 %d：沙箱里的 mawk 按 32 位整数输出 %d，超过 2 GB 会卡在 2147483647（实测踩过），
 * 两边一起溢出就会「校验通过」。%.0f 走双精度，2^53 以内精确。
 */
export function statsScript(ex: MigrationExcludes): string {
  return (
    `find . ${findFilter(ex)} -printf '%s\\n' ` +
    `| awk '{n++; s+=$1} END {printf "FILES %.0f\\nBYTES %.0f\\n", n, s}'`
  );
}

/**
 * tar 的排除参数。tar 的匹配选项是「位置参数」，只作用于其后的 --exclude（2026-11-04 实测）：
 * 扩展名放前面（不锚定、通配、不区分大小写）；路径放后面（锚定、字面量、区分大小写），与 find 一致。
 */
function tarExcludes(ex: MigrationExcludes): string {
  return [
    '--ignore-case',
    '--wildcards',
    ...ex.exts.map((e) => `--exclude='*.${e}'`),
    '--no-ignore-case',
    '--no-wildcards',
    '--anchored',
    ...[...ALWAYS_EXCLUDED_PATHS, ...ex.paths].map(
      (p) => `--exclude=${shellQuote(`./${p}`)}`,
    ),
  ].join(' ');
}

/**
 * 旧沙箱里执行：统计（FILES / BYTES）+ 打包（不压缩），成功最后输出 PACKED；工作区不存在输出 NO_WORKSPACE。
 */
export function packScript(ws: string, ex: MigrationExcludes): string {
  return (
    `if [ ! -d '${ws}' ]; then echo NO_WORKSPACE; exit 0; fi; ` +
    `cd '${ws}' && ${statsScript(ex)} && ` +
    `tar -cf ${MIGRATION_ARCHIVE} ${tarExcludes(ex)} -C '${ws}' . && echo PACKED`
  );
}

/** 旧沙箱里执行：删掉迁移归档（失败回滚时清理，免得几个 GB 留在 /tmp） */
export const cleanupArchiveScript = `rm -f ${MIGRATION_ARCHIVE}`;

/**
 * 新沙箱里执行：curl 拉旧沙箱的归档直链，管道直接 tar 解到工作区（pipefail：下载或解包任一失败即失败），
 * 再按同一份排除项统计一次（与打包时同口径）。
 */
export function pullScript(
  ws: string,
  downloadUrl: string,
  ex: MigrationExcludes,
): string {
  return (
    `set -o pipefail; mkdir -p '${ws}' && ` +
    `curl -fsS --retry 3 --retry-delay 2 ${shellQuote(downloadUrl)} | tar -xf - -C '${ws}' && ` +
    `cd '${ws}' && ${statsScript(ex)}`
  );
}

export function parseStats(output: string): { files: number; bytes: number } {
  const files = Number(/FILES (\d+)/.exec(output)?.[1]);
  const bytes = Number(/BYTES (\d+)/.exec(output)?.[1]);
  if (!Number.isFinite(files) || !Number.isFinite(bytes)) {
    throw new Error(`统计工作区失败：${output.slice(-300)}`);
  }
  return { files, bytes };
}

// ─── 盘点（迁移前给用户看占用，挑排除项） ───

export interface InventoryEntry {
  name: string;
  type: 'dir' | 'file' | 'link';
  /** 占用字节（文件夹 = 其下全部内容） */
  bytes: number;
  /** 其下普通文件数（文件 = 1） */
  files: number;
}

/** 单层最多返回多少项（按大小排序）；超出部分汇总成 truncated */
export const INVENTORY_LIMIT = 300;

/**
 * 列出工作区里某个目录的直接子项及各自占用：E 段 = 类型与名字，S 段 = du 字节数，C 段 = 每个子项下的文件数。
 * 以制表符分隔；名字里带制表符 / 换行的极少数文件解析时跳过。
 */
export function listDirScript(rel: string): string {
  const dir = rel ? shellQuote(rel) : '.';
  return (
    `cd -- ${dir} || exit 3; ` +
    `echo '##E'; find . -mindepth 1 -maxdepth 1 -printf '%y\\t%P\\n'; ` +
    `echo '##S'; find . -mindepth 1 -maxdepth 1 -print0 | xargs -0 -r du -sb --apparent-size; ` +
    `echo '##C'; find . -mindepth 1 -type f -printf '%P\\n' | awk -F/ '{c[$1]++} END {for (k in c) printf "%d\\t%s\\n", c[k], k}'`
  );
}

/**
 * 根目录额外的盘点：依赖目录（任意层级，找到就整棵剪掉，不再往里数）、按扩展名汇总（不含依赖目录）、
 * 工作区全部文件的总数与总大小。
 */
export function rootExtrasScript(): string {
  const deps = DEPENDENCY_DIR_NAMES.map((d) => `-name '${d}'`).join(' -o ');
  return (
    `echo '##D'; find . -type d \\( ${deps} \\) -prune -print0 | xargs -0 -r du -sb --apparent-size; ` +
    `echo '##T'; find . -type d \\( ${deps} \\) -prune -o -type f -printf '%s\\t%f\\n' ` +
    `| awk -F'\\t' '{n=split($2,a,"."); e=(n>1)?tolower(a[n]):""; if (e ~ /^[a-z0-9]+$/ && e ~ /[a-z]/ && length(e)<=10) {s[e]+=$1; c[e]++}} END {for (e in s) printf "%.0f\\t%d\\t%s\\n", s[e], c[e], e}' ` +
    `| sort -rn | head -20; ` +
    `echo '##A'; ${statsScript(NO_EXCLUDES)}`
  );
}

function section(output: string, tag: string): string[] {
  const start = output.indexOf(`##${tag}\n`);
  if (start < 0) return [];
  const rest = output.slice(start + tag.length + 3);
  const end = rest.search(/^##[A-Z]$/m);
  return (end < 0 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((l) => l.length > 0);
}

export function parseListDir(output: string): {
  entries: InventoryEntry[];
  truncated: { count: number; bytes: number } | null;
} {
  const types = new Map<string, InventoryEntry['type']>();
  for (const line of section(output, 'E')) {
    const [t, name] = line.split('\t');
    if (!name) continue;
    types.set(name, t === 'd' ? 'dir' : t === 'l' ? 'link' : 'file');
  }
  const sizes = new Map<string, number>();
  for (const line of section(output, 'S')) {
    const [b, path] = line.split('\t');
    if (path?.startsWith('./')) sizes.set(path.slice(2), Number(b));
  }
  const counts = new Map<string, number>();
  for (const line of section(output, 'C')) {
    const [c, name] = line.split('\t');
    if (name) counts.set(name, Number(c));
  }
  const all = [...types].map(([name, type]) => ({
    name,
    type,
    bytes: sizes.get(name) ?? 0,
    files: type === 'file' ? 1 : (counts.get(name) ?? 0),
  }));
  all.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const rest = all.slice(INVENTORY_LIMIT);
  return {
    entries: all.slice(0, INVENTORY_LIMIT),
    truncated: rest.length
      ? { count: rest.length, bytes: rest.reduce((s, e) => s + e.bytes, 0) }
      : null,
  };
}

export function parseRootExtras(output: string): {
  dependencies: { path: string; bytes: number }[];
  types: { ext: string; bytes: number; files: number }[];
  total: { files: number; bytes: number };
} {
  const dependencies = section(output, 'D').flatMap((line) => {
    const [b, path] = line.split('\t');
    return path?.startsWith('./')
      ? [{ path: path.slice(2), bytes: Number(b) }]
      : [];
  });
  dependencies.sort((a, b) => b.bytes - a.bytes);
  const types = section(output, 'T').flatMap((line) => {
    const [b, c, ext] = line.split('\t');
    return ext ? [{ ext, bytes: Number(b), files: Number(c) }] : [];
  });
  return {
    dependencies,
    types,
    total: parseStats(section(output, 'A').join('\n')),
  };
}
