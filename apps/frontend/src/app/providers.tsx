"use client";

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";

/** 全局接口异常提示：query/mutation 失败统一 toast，杜绝静默空数据。id 按消息去重防刷屏。 */
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  toast.error(message, { id: message });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000 } },
        queryCache: new QueryCache({ onError: reportError }),
        mutationCache: new MutationCache({ onError: reportError }),
      }),
  );

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        {/* attribute="class"：在 <html> 上挂/摘 .dark，配合 globals.css 的 @custom-variant；
            defaultTheme="system" + enableSystem：默认跟随系统并实时响应其变化；
            选择持久化到 localStorage（刷新不丢失），预水合脚本避免首屏闪烁。 */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster position="top-center" />
        </ThemeProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
