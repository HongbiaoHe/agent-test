/**
 * 设置里改了语言（或「跟随系统」时系统语言变了、重新取设置）后，让界面跟着切换。
 * 实际语言由 main 解析（desktop:getLocale），键跟着设置里的偏好走，偏好一变就重新取。
 * 切换后让所有 query 重新拉取：agent-host 返回的文案（如 /skills add 的说明）也按新语言生成。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSettings } from '@/features/settings/sections/use-settings';
import { applyLocale } from './i18n';

/** 放在 QueryClientProvider 里面（要用设置的 query） */
export function LocaleSync(): null {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const preference = settings.data?.language;
  const locale = useQuery({
    queryKey: ['locale', preference],
    queryFn: () => window.desktop.getLocale(),
    enabled: preference !== undefined,
  });
  useEffect(() => {
    const next = locale.data;
    if (!next) return;
    void applyLocale(next).then((changed) => {
      if (changed) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'locale' });
    });
  }, [locale.data, qc]);
  return null;
}
