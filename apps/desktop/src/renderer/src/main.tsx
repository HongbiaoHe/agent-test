import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { initI18n } from '@/lib/i18n';
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
const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
