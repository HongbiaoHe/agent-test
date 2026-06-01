import { redirect } from "next/navigation";
import { auth } from "@/auth";

// SSR 服务端取数：直连后端内网地址（NEXT_PUBLIC_API_BASE_URL 已改为浏览器侧同源前缀）
const API_BASE = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3101";

interface ConvItem {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
}

// 服务端取数（SSR）：用 next-auth 的 backendToken 调 NestJS
async function getConversations(token: string): Promise<ConvItem[]> {
  const res = await fetch(`${API_BASE}/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = (await res.json()) as { code: number; data?: ConvItem[] };
  return body.code === 0 ? (body.data ?? []) : [];
}

const STATUS_STYLE: Record<string, string> = {
  done: "text-green-600",
  failed: "text-destructive",
  waiting_approval: "text-amber-600",
  running: "text-muted-foreground",
  queued: "text-muted-foreground",
};

// Server Component：SSR 阶段就完成鉴权 + 取数 + 渲染
export default async function ConversationsPage() {
  const session = (await auth()) as { backendToken?: string } | null;
  if (!session?.backendToken) redirect("/login");

  const items = await getConversations(session.backendToken);

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8 font-sans">
      <h1 className="text-2xl font-bold">我的会话</h1>
      <p className="text-sm text-muted-foreground">
        本页为 Server Component，在服务端用 next-auth session 鉴权并取数（SSR）。
      </p>

      {items.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          还没有会话，去 <code className="rounded bg-muted px-1">/agent</code>{" "}
          提交一个吧。
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{c.goal}</span>
                <span
                  className={`shrink-0 text-xs ${STATUS_STYLE[c.status] ?? "text-muted-foreground"}`}
                >
                  {c.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
