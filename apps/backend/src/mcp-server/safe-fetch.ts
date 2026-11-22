import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * 替第三方 agent 拉取它给的公网 URL（import_asset）。URL 来自模型，必须防 SSRF：
 * - 只允许 https、不允许 URL 里带账号密码；
 * - DNS 解析结果逐个过黑名单（回环 / 私网 / 链路本地 / 云元数据 / 保留段），**在连接用的 lookup 里校验**，
 *   于是校验过的 IP 就是实际连的 IP，不存在「先查后连」被 DNS 重绑定钻空子；
 * - 重定向手动跟（最多 3 跳），每一跳重走上面的校验；
 * - 超时、字节上限边下边数，超限立即中断。
 * 不走 HTTPS_PROXY：经代理就校验不到最终连的是谁。
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** IP 是否落在禁止访问的网段（IPv4 映射的 IPv6 按 IPv4 判） */
export function isBlockedIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) return blocked.check(ip, 'ipv6');
  return true;
}

export class SafeFetchError extends Error {}

/** 解析域名并校验每个地址；有一个落在黑名单就整体拒绝 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = Array.isArray(addresses) ? addresses : [];
    const bad = list.find((a) => isBlockedIp(a.address));
    if (list.length === 0 || bad) {
      return callback(
        new SafeFetchError(`不允许访问内网或保留地址：${hostname}`),
        '',
        4,
      );
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
};

export interface FetchedFile {
  body: Buffer;
  /** 去掉参数、转小写的 MIME */
  contentType: string;
  /** URL 路径最后一段（解码后），没有则为空串 */
  filename: string;
}

export interface SafeFetchOptions {
  /** 按响应的 Content-Type 给出字节上限；返回 null = 类型不允许 */
  maxBytesFor: (contentType: string) => number | null;
  timeoutMs?: number;
  maxRedirects?: number;
  /** 调用方放弃（MCP 客户端取消 / 断开）时中止下载 */
  signal?: AbortSignal;
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError('URL 格式不对');
  }
  if (u.protocol !== 'https:') throw new SafeFetchError('只支持 https 地址');
  if (u.username || u.password) {
    throw new SafeFetchError('URL 里不能带账号密码');
  }
  // 字面 IP 不经 DNS，直接校验
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedIp(host)) {
    throw new SafeFetchError(`不允许访问内网或保留地址：${host}`);
  }
  return u;
}

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<FetchedFile> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let url = checkUrl(rawUrl);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const r = await getOnce(url, opts, deadline - Date.now());
    if ('redirect' in r) {
      url = checkUrl(new URL(r.redirect, url).href);
      continue;
    }
    return r;
  }
  throw new SafeFetchError('重定向次数过多');
}

function getOnce(
  url: URL,
  opts: SafeFetchOptions,
  timeoutMs: number,
): Promise<FetchedFile | { redirect: string }> {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) return reject(new SafeFetchError('下载超时'));
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        timeout: timeoutMs,
        signal: opts.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return reject(new SafeFetchError(`下载失败：HTTP ${status}`));
        }
        const contentType = (res.headers['content-type'] ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const max = opts.maxBytesFor(contentType);
        if (max === null) {
          res.resume();
          return reject(
            new SafeFetchError(`不支持的文件类型：${contentType || '未知'}`),
          );
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > max) {
          res.destroy();
          return reject(new SafeFetchError(`文件超过 ${max} 字节上限`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            res.destroy();
            reject(new SafeFetchError(`文件超过 ${max} 字节上限`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const last = url.pathname.split('/').pop() ?? '';
          let filename = last;
          try {
            filename = decodeURIComponent(last);
          } catch {
            // 非法百分号编码就用原样
          }
          resolve({ body: Buffer.concat(chunks), contentType, filename });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new SafeFetchError('下载超时')));
    req.on('error', (e) =>
      reject(e instanceof SafeFetchError ? e : new SafeFetchError(e.message)),
    );
    req.end();
  });
}
