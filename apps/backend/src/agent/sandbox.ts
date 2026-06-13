/**
 * 用户级（user-scoped）沙箱工厂。
 *
 * 分配粒度：**一个用户一个沙箱**（标签 user_id）——同一用户的所有会话共享同一个
 * 工作区（已装依赖、生成产物跨会话可见）；不同用户之间完全隔离。
 * （此前为 thread-scoped 每会话一个，按用户要求 2026-06-11 改为用户级。）
 *
 * 为什么单独抽成一个文件？
 * - 沙箱生命周期管理（查找→复用→补拉起 / 创建）对 agent worker 和 conversations
 *   文件接口都有用，抽出来避免循环依赖。
 * - `getUserSandbox` 是幂等的：同一 userId 只维护一个沙箱；如果已停机，
 *   拉起后再返回；如果不存在，新建。
 * - 无 DAYTONA_API_KEY 时静默返回 null，调用方回退到 StateBackend（纯内存/DB）。
 */

import { Daytona } from '@daytonaio/sdk';
import { DaytonaSandbox } from '@langchain/daytona';
import type { FileData } from 'deepagents';
import { GuardedSandbox } from './guarded-sandbox';

/** agent 专用工作区目录名（相对于沙箱 home） */
export const AGENT_WORKSPACE_DIR = 'agent-workspace';

// ─── 验证过的 API 事实 ─────────────────────────────────────────────
// @daytonaio/sdk 0.185.0 Daytona.d.ts:
//   · list(query?: ListSandboxesQuery): AsyncIterableIterator<Sandbox>   — 无 findOne
//   · ListSandboxesQuery.labels?: Record<string,string>                  — 按标签过滤
// @daytonaio/sdk Sandbox.d.ts:
//   · state?: SandboxState  （字符串常量枚举，"started"/"stopped" 等）    — 无 isRunning
// @langchain/daytona 0.2.0 index.d.ts:
//   · DaytonaSandbox.create(options?)                                     — 静态工厂
//   · DaytonaSandbox.fromId(id, options?)                                 — 静态，按 SDK sandbox.id 连接
//   · DaytonaSandbox.deleteAll(labels, options?)                          — 静态，按标签批量删
//   · DaytonaSandbox.isRunning: boolean — ⚠️ 只表示「实例已初始化」（#sandbox !== null），
//     fromId 之后恒为 true，与沙箱真实运行状态无关（dist/index.js:254）。
//     判断是否需要 start() 必须用 SDK list() 返回的 sandbox.state === 'started'。
//   · DaytonaSandbox.start(timeout?)                                      — 实例方法，委托 SDK start 并等待 started
//   · DaytonaSandboxOptions.autoStopInterval / autoArchiveInterval / autoDeleteInterval — 单位：分钟
//     （JSDoc: "Auto-stop interval in minutes" 等；三者 wrapper 均透传给 SDK create）
// ──────────────────────────────────────────────────────────────────

/** Daytona list() 返回项中本模块及状态接口用到的字段（避免 SDK 类型深耦合）。 */
export interface SandboxListing {
  id: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
}

/**
 * 在用户的全部沙箱中确定性选择一个（纯函数，便于单测）。
 *
 * 为什么需要选择而不是取 list 第一个：历史 bug 曾让同一用户裂变出多个沙箱
 * （见 getUserSandbox 错误处理说明），list 顺序又不确定——worker 写文件连 A、
 * 状态面板查 B，表现为「文件消失」。规则：
 *  - started 优先（可直接用），其次 stopped（可拉起），过渡/异常态最后；
 *  - 同级取 createdAt 最早（最可能持有历史工作区文件）。
 */
export function pickPreferredSandbox<T extends SandboxListing>(
  all: T[],
): T | null {
  if (all.length === 0) return null;
  const rank = (s: SandboxListing) =>
    s.state === 'started' ? 0 : s.state === 'stopped' ? 1 : 2;
  return [...all].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
  )[0];
}

/** list 该用户全部沙箱并确定性选择（getUserSandbox / findUserSandbox / 状态接口共用）。 */
export async function pickUserSandbox(
  userId: string,
): Promise<SandboxListing | null> {
  const client = new Daytona();
  const all: SandboxListing[] = [];
  for await (const s of client.list({ labels: { user_id: userId } })) {
    all.push(s);
  }
  return pickPreferredSandbox(all);
}

/**
 * 按 userId 获取（或创建）该用户的 Daytona 沙箱。
 *
 * 逻辑：
 *  1. 无 DAYTONA_API_KEY → 立即返回 null（调用方用 StateBackend 兜底）。
 *  2. pickUserSandbox 确定性选择已有沙箱（started 优先、createdAt 最早）。
 *  3. 找到 → fromId 拿 DaytonaSandbox wrapper；非 started 先 start() 再返回。
 *     （停机实例 execute/downloadFiles 会失败，必须先拉起——设计 §5 停机恢复）
 *  4. 确认列表为空 → create 新沙箱，绑 user_id 标签。
 *
 * 错误处理策略（2026-06-11 修订）：
 *  - 查找/连接/启动失败一律**向上抛**，由调用方降级（worker → StateBackend + 提示）。
 *  - ⚠️ 此前任何异常都落到 create 路径——start() 超时等瞬时错误会凭空裂变新沙箱
 *    （同一用户多沙箱、文件“消失”，已实际发生），create 仅在确认无沙箱时执行。
 */
export async function getUserSandbox(
  userId: string,
): Promise<GuardedSandbox | null> {
  if (!process.env.DAYTONA_API_KEY) return null;

  let sb: DaytonaSandbox;

  const existing = await pickUserSandbox(userId);
  if (existing) {
    // 找到已有沙箱：用 LangChain wrapper 连接，以便 execute/upload 等高级方法可用
    sb = await DaytonaSandbox.fromId(existing.id);
    // ⚠️ 不能用 sb.isRunning 判断（fromId 后恒为 true，见文件顶部 API 事实），
    // 须用 SDK list() 返回的 state；非 started（stopped/starting 等）都走 start()
    // 等待就绪（停机沙箱不拉起，后续 getWorkDir/execute 会 400 "no IP address found"）。
    if (existing.state !== 'started') {
      await sb.start();
    }
  } else {
    // 确认列表为空才创建（auto*Interval 单位：分钟，已验证；delete 从停机时刻起算）。
    // 不配置 autoArchiveInterval：停机直接等删除，无归档中间态。
    sb = await DaytonaSandbox.create({
      labels: { user_id: userId },
      autoStopInterval: 5, // 闲置 5 分钟自动停机，停机态只计存储费用
      autoDeleteInterval: 10, // 停机 10 分钟后自动删除
    });
  }

  // 建立（或确认）工作区目录，返回守卫 wrapper
  const home = await sb.getWorkDir();
  const ws = `${home}/${AGENT_WORKSPACE_DIR}`;
  await sb.execute(`mkdir -p '${ws}'`);
  return new GuardedSandbox(sb, ws);
}

/**
 * 列出沙箱工作区的产物文件（相对路径）。conversations 文件接口与沙箱状态接口共用。
 *
 * 为什么用 find 而不是 ls：find 支持 -maxdepth 限制深度、-type f 只列文件、
 * -not -path 排除 node_modules 和隐藏目录，一条命令搞定，避免递归实现。
 * /skills/ 路径是 agent worker 注入的技能代码，不属于用户产物，排除之。
 */
export async function listWorkspaceFiles(
  sb: GuardedSandbox,
): Promise<{ path: string }[]> {
  const workdir = await sb.getWorkDir();
  const cmd = `find "${workdir}" -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.*' -not -path '*/skills/*'`;
  const result = await sb.execute(cmd);

  return (
    result.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // GuardedSandbox 出站脱敏后路径已是虚拟根（/xxx），去掉前导 / 得相对路径
      .map((p) => ({ path: p.replace(/^\//, '') }))
  );
}

/** 树节点：工作区某目录下的直接子项（相对虚拟路径，无前导 /）。 */
export interface DirEntry {
  /** 末级名（展示用） */
  name: string;
  /** 相对工作区根的虚拟路径（如 my-blog/pages），点目录时回传以列下一层 */
  path: string;
  isDir: boolean;
  /** 文件字节数；目录为 0 */
  size: number;
}

/** 树里不展示的项：依赖目录、隐藏文件、注入的技能代码（与 listWorkspaceFiles 口径一致）。 */
const HIDDEN_TREE_NAMES = new Set(['node_modules', 'skills']);
function isHiddenTreeEntry(name: string): boolean {
  return name.startsWith('.') || HIDDEN_TREE_NAMES.has(name);
}

/**
 * 列出工作区某目录的直接子项（非递归，按需懒加载用）。
 *
 * 与 listWorkspaceFiles（一次性扁平 find）的区别：这里只列**单层**，前端展开目录
 * 才调一次——「不展开不加载」。底层用 GuardedSandbox.ls（find -maxdepth 1 + stat，
 * 已做路径守卫与出站脱敏，返回虚拟路径：目录带尾 /、文件不带）。
 *
 * dir 为相对虚拟路径（''/'/' = 根）。排除 node_modules/隐藏/skills，目录优先排序。
 */
export async function listDir(
  sb: GuardedSandbox,
  dir: string,
): Promise<DirEntry[]> {
  const res = await sb.ls(dir && dir !== '/' ? dir : '/');
  const entries: DirEntry[] = [];
  for (const f of res.files ?? []) {
    // ls 返回虚拟路径：目录尾随 /、前导 /；取末级名并归一相对路径
    const rel = f.path.replace(/^\//, '').replace(/\/$/, '');
    const name = rel.split('/').filter(Boolean).pop() ?? '';
    if (!name || isHiddenTreeEntry(name)) continue;
    entries.push({
      name,
      path: rel,
      isDir: f.is_dir ?? false,
      size: f.size ?? 0,
    });
  }
  // 目录在前、同类按名排序（区分大小写无碍，工作区文件名以 ASCII 为主）
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
  return entries;
}

/** 可内联高亮预览的文本扩展名（未列入的当二进制处理，避免 read() 误走二进制分支被脱敏破坏）。 */
const TEXT_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'graphql',
  'gql',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'xml',
  'vue',
  'svelte',
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'log',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'csv',
  'tsv',
  'properties',
  'gitignore',
  'dockerignore',
  'editorconfig',
]);
/** 无扩展名但属文本的常见文件名（树已过滤隐藏文件，故无需点开头项）。 */
const TEXT_NOEXT_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'procfile',
]);
/** 走 readRaw → base64 dataUrl 内联预览的图片扩展名。 */
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
]);

/** 文件预览负载：文本（带行号原文，前端剥）/ 图片（dataUrl）/ 不可预览二进制。 */
export type FilePreview =
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string; mimeType: string }
  | { kind: 'binary'; size: number };

const PREVIEW_MAX_LINES = 2000;

/**
 * 读取单个工作区文件用于前端预览（点击文件时按需调用）。
 *
 * 按扩展名路由，避免 GuardedSandbox.read 的二进制分支问题——read() 对非文本 mime
 * 会回退到 downloadFiles，其 Uint8Array 结果经 GuardedSandbox.sanitize 的对象深拷贝
 * 会被破坏成普通对象；故二进制/图片**不走 read()**，改用 readRaw（成功结果不脱敏）。
 *  - 文本扩展：read() 取前 PREVIEW_MAX_LINES 行（带行号原文，前端 stripLineNumbers）。
 *  - 图片扩展：readRaw() → base64 dataUrl。
 *  - 其余：返回 binary 占位（不下载，省流量）。
 */
export async function readFilePreview(
  sb: GuardedSandbox,
  filePath: string,
): Promise<FilePreview> {
  const name = filePath.split('/').filter(Boolean).pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const isText =
    (ext && TEXT_EXTS.has(ext)) ||
    (!ext && TEXT_NOEXT_NAMES.has(name.toLowerCase()));
  const isImage = ext !== '' && IMAGE_EXTS.has(ext);

  if (isText) {
    const res = await sb.read(filePath, 0, PREVIEW_MAX_LINES);
    if (res.error || typeof res.content !== 'string') {
      throw new Error(res.error ?? '读取文件失败');
    }
    const lineCount = res.content === '' ? 0 : res.content.split('\n').length;
    return {
      kind: 'text',
      content: res.content,
      truncated: lineCount >= PREVIEW_MAX_LINES,
    };
  }

  if (isImage) {
    const res = await sb.readRaw(filePath);
    if (res.error || !res.data) throw new Error(res.error ?? '读取文件失败');
    const buf = fileDataToBuffer(res.data);
    const mimeType = fileDataMime(res.data);
    return {
      kind: 'image',
      dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
      mimeType,
    };
  }

  // 其余二进制：仅取大小（readRaw 拿字节数），不内联内容
  const res = await sb.readRaw(filePath);
  const size = res.data ? fileDataToBuffer(res.data).length : 0;
  return { kind: 'binary', size };
}

/**
 * deepagents FileData 联合（V1=行数组 / V2=string|Uint8Array）→ Buffer。
 * readRaw 实际返回 V2，但类型是联合，逐分支收窄以零断言取字节。
 */
function fileDataToBuffer(data: FileData): Buffer {
  const c = data.content;
  if (Array.isArray(c)) return Buffer.from(c.join('\n'), 'utf8');
  return Buffer.from(c);
}

/** FileData mime：仅 V2 带 mimeType，V1 回退 octet-stream。 */
function fileDataMime(data: FileData): string {
  return 'mimeType' in data ? data.mimeType : 'application/octet-stream';
}

/**
 * 只查不建（conversations 文件接口用），按 userId 查找。
 *
 * - 找到且在运行 → 直接返回。
 * - 找到但停机   → start() 拉起后返回（downloadFiles 对停机实例会失败）。
 * - 未找到       → 返回 null。
 * - 任何错误     → 返回 null（调用方做好 null 检查即可）。
 */
export async function findUserSandbox(
  userId: string,
): Promise<GuardedSandbox | null> {
  if (!process.env.DAYTONA_API_KEY) return null;

  try {
    // 与 getUserSandbox / 状态接口共用同一确定性选择，保证各处看到同一个沙箱
    const existing = await pickUserSandbox(userId);
    if (!existing) return null;

    const sb = await DaytonaSandbox.fromId(existing.id);
    // 同 getUserSandbox：isRunning 不可信，须用 list() 的 state 判断
    if (existing.state !== 'started') {
      await sb.start();
    }
    // 建立工作区目录后返回守卫 wrapper
    const home = await sb.getWorkDir();
    const ws = `${home}/${AGENT_WORKSPACE_DIR}`;
    await sb.execute(`mkdir -p '${ws}'`);
    return new GuardedSandbox(sb, ws);
  } catch {
    return null;
  }
}
