/**
 * 节点产物的真实画幅（宽 / 高），按媒体版本 id 记在本机。
 *
 * 卡片在资产到手之前就要摆出最终的形状，否则一打开画布，几十张卡会随着图片 / 视频陆续加载
 * 一张张撑开、整片画布跟着抖。生成节点的画幅参数不一定等于产物的真实比例（模型自适应、
 * 生成后又改过参数、上传素材根本没有这个参数），所以第一次看到产物时量一次真实尺寸记下来，
 * 之后再打开就按它占位，加载前后卡片完全同形。
 *
 * 只是体验优化：存不了（隐私模式 / 配额满）就退回节点参数占位，不影响功能。
 */

const STORAGE_KEY = "canvas:media-aspect:v1";
/** 只留最近这么多条，够覆盖常用画布又不至于撑大 localStorage */
const MAX_ENTRIES = 2000;

let cache: Map<string, number> | null = null;

function isEntry(e: unknown): e is [string, number] {
  return (
    Array.isArray(e) &&
    typeof e[0] === "string" &&
    typeof e[1] === "number" &&
    Number.isFinite(e[1]) &&
    e[1] > 0
  );
}

function load(): Map<string, number> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const e of parsed) if (isEntry(e)) cache.set(e[0], e[1]);
    }
  } catch {
    // 读不到就当没有记录
  }
  return cache;
}

/** 这个版本以前量到的真实画幅；没量过返回 undefined */
export function knownAspect(versionId: string | null | undefined): number | undefined {
  if (!versionId || typeof window === "undefined") return undefined;
  return load().get(versionId);
}

/** 记下这个版本的真实画幅（与已有记录几乎相同就不写） */
export function rememberAspect(versionId: string, aspect: number): void {
  if (typeof window === "undefined" || !Number.isFinite(aspect) || aspect <= 0) {
    return;
  }
  const map = load();
  const prev = map.get(versionId);
  if (prev !== undefined && Math.abs(prev - aspect) < 1e-3) return;
  map.delete(versionId); // 重新插入 = 移到最新
  map.set(versionId, aspect);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  schedulePersist();
}

/** 合并写入：一屏几十张卡会在几百毫秒内陆续量完，不必每量一张就整表序列化、同步写一次存储 */
const PERSIST_DELAY_MS = 1000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_DELAY_MS);
}

function persist(): void {
  if (!cache) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...cache]));
  } catch {
    // 配额满 / 隐私模式：内存里仍有，本次会话照样不跳
  }
}
