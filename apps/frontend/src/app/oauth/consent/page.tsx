"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CornerDownLeft,
  Eye,
  Loader2,
  PenLine,
  Sparkles,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { AgentLogo } from "@/components/mcp-server/agent-logo";
import {
  type ConsentDetails,
  decideConsent,
  getConsent,
  type McpScope,
  SCOPE_INFO,
} from "@/components/mcp-server/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 第三方 agent 的 OAuth 同意页：后端 /oauth/authorize 把浏览器送到这里（?request=<id>），
 * 用户核对「哪个 agent、授权的是哪个账号、要什么权限、授权码送回哪里」后允许 / 拒绝，
 * 再整页跳回客户端的 redirect_uri。未登录时 middleware 先送去登录，登录完带着 request 参数回来。
 */
export default function OAuthConsentPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 font-sans">
      <Suspense fallback={<ConsentSkeleton />}>
        <Consent />
      </Suspense>
    </main>
  );
}

/** 每个权限配一个图标；会花钱的那一项单独标出来 */
const SCOPE_ICON: Record<McpScope, typeof Eye> = {
  "canvas:read": Eye,
  "canvas:write": PenLine,
  "media:generate": WandSparkles,
};

function Consent() {
  const requestId = useSearchParams().get("request") ?? "";
  const details = useQuery({
    queryKey: ["mcp-server", "consent", requestId],
    queryFn: () => getConsent(requestId),
    enabled: requestId !== "",
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (d: "approve" | "deny") => decideConsent(requestId, d),
    onSuccess: ({ redirectUrl }) => {
      window.location.href = redirectUrl;
    },
  });

  if (!requestId || details.isError) return <Expired />;
  if (!details.data) return <ConsentSkeleton />;

  return (
    <ConsentCard
      details={details.data}
      pending={decide.isPending ? decide.variables : null}
      done={decide.isSuccess ? decide.variables : null}
      error={decide.error instanceof Error ? decide.error.message : null}
      onDecide={(d) => decide.mutate(d)}
    />
  );
}

function ConsentCard({
  details,
  pending,
  done,
  error,
  onDecide,
}: {
  details: ConsentDetails;
  pending: "approve" | "deny" | null | undefined;
  done: "approve" | "deny" | null | undefined;
  error: string | null;
  onDecide: (d: "approve" | "deny") => void;
}) {
  const { clientName, redirectHost, scopes } = details;
  const busy = Boolean(pending) || Boolean(done);

  return (
    <Card className="w-full max-w-md gap-0 p-0 shadow-sm animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none">
      <div className="flex flex-col items-center gap-5 px-6 pt-8 pb-6 text-center sm:px-8">
        <ConnectionMark clientName={clientName} />
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            {clientName} wants to access your canvases
          </h1>
          <SignedInAs />
        </div>
      </div>

      <div className="border-t border-border px-6 py-5 sm:px-8">
        <p className="mb-3 text-xs font-medium text-muted-foreground">
          This will allow {clientName} to
        </p>
        <ul className="space-y-4">
          {scopes.map((s) => {
            const Icon = SCOPE_ICON[s];
            return (
              <li key={s} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 space-y-0.5 pt-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {SCOPE_INFO[s].label}
                    {s === "media:generate" && (
                      <Badge variant="outline" className="font-normal">
                        Uses credits
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {SCOPE_INFO[s].description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-4 border-t border-border bg-muted/40 px-6 py-5 sm:px-8">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <CornerDownLeft className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            You&apos;ll be sent back to{" "}
            <span className="font-medium text-foreground">{redirectHost}</span>.
            Only allow apps you trust — you can revoke access any time in{" "}
            <Link
              href="/settings/mcp-server"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Settings
            </Link>
            .
          </span>
        </p>

        {done === "approve" ? (
          <p
            role="status"
            className="flex h-9 items-center justify-center gap-2 text-sm font-medium"
          >
            <CircleCheck className="size-4" aria-hidden />
            Access allowed — returning to {clientName}…
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={() => onDecide("deny")}
            >
              {pending === "deny" && <Loader2 className="animate-spin" />}
              Deny
            </Button>
            <Button size="lg" disabled={busy} onClick={() => onDecide("approve")}>
              {pending === "approve" && <Loader2 className="animate-spin" />}
              Allow access
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}

/** agent ⇄ 本站：两枚标识之间一条虚线，常见 OAuth 授权页的形态，一眼看出是谁连谁 */
function ConnectionMark({ clientName }: { clientName: string }) {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <span className="flex size-12 items-center justify-center rounded-xl border border-border bg-card">
        <AgentLogo agent={clientName} className="size-6" />
      </span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <span className="size-1 rounded-full bg-current" />
        <span className="w-6 border-t border-dashed border-current" />
        <span className="size-1 rounded-full bg-current" />
      </span>
      <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Sparkles className="size-5" />
      </span>
    </div>
  );
}

/** 授权落在哪个账号上：同意页最容易被忽略、又最该核对的一点；不是自己就换号重来 */
function SignedInAs() {
  const { data } = useSession();
  const email = data?.user?.email;
  if (!email) return null;
  const switchAccount = () => {
    const next = window.location.pathname + window.location.search;
    void signOut({ callbackUrl: `/login?next=${encodeURIComponent(next)}` });
  };
  return (
    <div className="flex flex-col items-center gap-0.5 text-sm text-muted-foreground">
      <p className="max-w-full">
        Signed in as{" "}
        {/* 邮箱不在连字符处折断；超长时截断，悬停看全 */}
        <span
          title={email}
          className="inline-block max-w-full truncate align-bottom font-medium text-foreground"
        >
          {email}
        </span>
      </p>
      <button
        type="button"
        onClick={switchAccount}
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        Switch account
      </button>
    </div>
  );
}

function Expired() {
  return (
    <Card className="w-full max-w-md items-center gap-3 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
        <TriangleAlert className="size-5 text-muted-foreground" aria-hidden />
      </span>
      <h1 className="text-base font-semibold">This request has expired</h1>
      <p className="max-w-xs text-sm text-muted-foreground">
        Authorization links are valid for 10 minutes and can be used once. Go back
        to your app and connect again.
      </p>
    </Card>
  );
}

function ConsentSkeleton() {
  return <Skeleton className="h-[30rem] w-full max-w-md rounded-xl" />;
}
