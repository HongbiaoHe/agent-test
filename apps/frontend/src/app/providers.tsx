"use client";

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";

/** 全局接口异常提示：query/mutation 失败统一 toast，杜绝静默空数据。id 按消息去重防刷屏。 */
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  toast.error(message, { id: message });
}

export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000 } },
        queryCache: new QueryCache({ onError: reportError }),
        mutationCache: new MutationCache({ onError: reportError }),
      }),
  );

  return (
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <QueryClientProvider client={queryClient}>
        {/* attribute="class"：在 <html> 上挂/摘 .dark，配合 globals.css 的 @custom-variant；
             仅支持 light / dark 两档，不跟随系统（enableSystem=false）；默认 light。
             选择持久化到 localStorage（刷新不丢失），预水合脚本避免首屏闪烁。 */}
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          <Toaster position="top-center" />
        </ThemeProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
