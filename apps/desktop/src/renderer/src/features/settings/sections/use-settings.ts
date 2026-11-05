import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export const SETTINGS_KEY = ['settings'] as const;

/** 设置读写（main 持有 settings.json）；改完刷新同一个 query */
export function useSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => window.desktop.getSettings() });
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof window.desktop.updateSettings>[0]) => window.desktop.updateSettings(patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
    onError: (e) => toast.error(e.message),
  });
  return { settings, update };
}
