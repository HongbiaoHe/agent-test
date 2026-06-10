"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

import { InstallForm } from "./_components/install-form";
import { SkillList } from "./_components/skill-list";

// /skills：技能管理页（最小版）——列表 / 从 GitHub 安装 / 启停 / 删除。
// 客户端组件：用 TanStack Query 取数与变更（项目既有数据获取范式），mutation 后 invalidate 列表自动刷新。
export default function SkillsPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 font-sans sm:p-8">
      <header className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          // 用 Link 渲染出 <a>（客户端导航），需告知 base-ui 这不是原生 button，否则会报 nativeButton 警告
          nativeButton={false}
          render={<Link href="/agent" />}
          className="-ml-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" /> 返回会话
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">技能</h1>
        <p className="text-sm text-muted-foreground">
          管理 agent 可用的技能：内置技能随系统提供，亦可从 GitHub
          安装第三方技能并按需启停或删除。
        </p>
      </header>

      <InstallForm />
      <SkillList />
    </main>
  );
}
