"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000 } },
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
        </ThemeProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
