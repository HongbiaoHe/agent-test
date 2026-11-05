import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
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
      <App />
      <Toaster theme={theme} position="top-center" />
    </QueryClientProvider>
  );
}

const el = document.getElementById('root');
if (!el) throw new Error('#root 不存在');
createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
