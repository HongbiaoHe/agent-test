import { proxyUpload } from "../../_lib/proxy-upload";

/** Spark 会话的附件上传：流式转给后端 POST /conversations/:id/uploads（为什么要单独一条路由见 proxyUpload）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  return proxyUpload(
    request,
    `/conversations/${encodeURIComponent(conversationId)}/uploads`,
  );
}
