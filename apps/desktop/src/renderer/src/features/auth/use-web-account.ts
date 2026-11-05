import { useQuery } from '@tanstack/react-query';

export const WEB_ACCOUNT_KEY = ['web-account'] as const;

/** Web 账号登录状态（令牌在 main，renderer 只拿邮箱 / 有效期 / 后端地址） */
export function useWebAccount() {
  return useQuery({ queryKey: WEB_ACCOUNT_KEY, queryFn: () => window.desktop.getWebAccount() });
}
