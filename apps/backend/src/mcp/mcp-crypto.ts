import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * MCP 凭据（OAuth token、DCR client 信息）落库前的对称加密：AES-256-GCM。
 *
 * 密钥来自 env MCP_TOKEN_ENC_KEY（任意长度字符串，sha256 后作 32 字节密钥）。
 * 惰性读取：模块加载时不快照 env，缺失时在第一次加解密时报清晰的错。
 * 密文格式 `v1.<iv>.<tag>.<data>`（均 base64url），带版本前缀便于将来换算法 / 轮换密钥。
 */
const VERSION = 'v1';

function key(): Buffer {
  const raw = process.env.MCP_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error('MCP_TOKEN_ENC_KEY 未配置，无法加解密 MCP 凭据');
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** 解密失败（密钥换了 / 密文被改）返回 undefined：调用方按「没有凭据」处理，走重新授权。 */
export function decryptJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  const [version, iv, tag, data] = text.split('.');
  if (version !== VERSION || !iv || !tag || !data) return undefined;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    // 我方自己加密写入的数据，形状由写入方保证
    return JSON.parse(plain) as T;
  } catch {
    return undefined;
  }
}
