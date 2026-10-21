import { auth } from "@/auth";

// 服务端直连后端内网地址（同 SSR 取数）
const BACKEND = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3101";

/**
 * 附件上传的同源入口：把浏览器发来的文件**流式**转给后端 POST /conversations/:id/uploads。
 *
 * 为什么不走 /api-backend 反代：那条路径要经 middleware 注入 token，而 middleware 会把请求体
 * 整块缓冲且超过 proxyClientMaxBodySize（默认 10MB）**静默截断**——大视频必坏。本路由不在
 * middleware matcher 里，请求体原样往下游 pipe；token 在这里从 session 取（不下发浏览器）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const session = await auth();
  const token = (session as { backendToken?: string } | null)?.backendToken;
  if (!token) {
    return Response.json(
      { code: 401, message: "Unauthorized", data: null },
      { status: 401 },
    );
  }
  const { conversationId } = await params;
  const filename = new URL(request.url).searchParams.get("filename") ?? "";

  // 流式 body 必须带 duplex:'half'；DOM 版 RequestInit 类型没有这个字段，用交叉类型补上
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": request.headers.get("content-type") ?? "",
      // 后端按它校验大小并向 aigc 申请签名（签名锁死字节数），必须原样透传
      "Content-Length": request.headers.get("content-length") ?? "",
    },
    body: request.body,
    duplex: "half",
  };
  const res = await fetch(
    `${BACKEND}/conversations/${encodeURIComponent(conversationId)}/uploads?filename=${encodeURIComponent(filename)}`,
    init,
  );
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
    },
  });
}
