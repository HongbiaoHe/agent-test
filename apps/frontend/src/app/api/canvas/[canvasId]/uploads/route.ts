import { proxyUpload } from "../../../_lib/proxy-upload";

/** 画布对话的附件上传：流式转给后端 POST /canvas/:id/uploads（为什么要单独一条路由见 proxyUpload）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ canvasId: string }> },
) {
  const { canvasId } = await params;
  return proxyUpload(
    request,
    `/canvas/${encodeURIComponent(canvasId)}/uploads`,
  );
}
