import { createHmac, timingSafeEqual } from 'node:crypto';

/** 签名长度（hex 字符数）：128bit 足够不可枚举，又不会把 URL 撑得太长。 */
const TOKEN_LEN = 32;

/**
 * 公开资产链接的签名。
 *
 * 为什么需要它：aigc 侧要**自己去下载**我们给的参考图（reference_resources 只收公网 URL，
 * 不收 base64），而正常的资产接口带 JWT 鉴权，aigc 拿不到用户 token。于是单开一条
 * 无鉴权路由，用「versionId + 服务端密钥」派生的签名当凭据——链接不可猜、也不必发新 token。
 *
 * 密钥复用 AUTH_JWT_SECRET：同一进程内已有的服务端密钥，不再多引入一个配置项。
 */
export function signAssetToken(versionId: string): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('缺少 AUTH_JWT_SECRET 环境变量');
  return createHmac('sha256', secret)
    .update(`media-asset:${versionId}`)
    .digest('hex')
    .slice(0, TOKEN_LEN);
}

/** 校验签名（等长定时比较，避免按前缀试探）。 */
export function verifyAssetToken(versionId: string, token: string): boolean {
  if (typeof token !== 'string' || token.length !== TOKEN_LEN) return false;
  const expected = Buffer.from(signAssetToken(versionId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
