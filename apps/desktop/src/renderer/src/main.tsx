import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { initI18n } from '@/lib/i18n';
import { syncFullScreenAttribute } from '@/lib/fullscreen-sync';
import { LocaleSync } from '@/lib/locale-sync';
import { useSystemTheme } from '@/lib/use-system-theme';
import { App } from './app';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
  mutationCache: new MutationCache(),
});

function Root() {
  const theme = useSystemTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleSync />
      <App />
      <Toaster theme={theme} position="top-center" />
    </QueryClientProvider>
  );
}

// 先拿到界面语言再渲染，首屏不会闪一下别的语言
await initI18n();
syncFullScreenAttribute();
const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
const root = createRoot(el);
root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
// 开发模式热更新：改了非组件模块（如 i18n 词典）时更新会冒泡到这里、整个入口重新执行。
// 先卸载旧的根，否则每次都多挂一整份应用（多份 ⌘K 监听 → 一按就叠出好几个搜索弹窗）
import.meta.hot?.dispose(() => root.unmount());
