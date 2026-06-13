import { Sparkles } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

import { ThemeToggle } from "./theme-toggle";

/** 落地页顶栏：品牌 + 锚点导航 + 主题切换 + 登录入口。浮于 hero 之上。 */
export function LandingNav() {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </span>
          Agent
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
            nativeButton={false}
            render={<a href="#features" />}
          >
            Features
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
            nativeButton={false}
            render={<Link href="/agent" />}
          >
            Workspace
          </Button>
          <ThemeToggle />
          <Button size="sm" nativeButton={false} render={<Link href="/login" />}>
            Sign in
          </Button>
        </div>
      </nav>
    </header>
  );
}
