import { proxyUpload } from "../../../../../_lib/proxy-upload";

/** 给上传节点传文件：流式转给后端 POST /canvas/:id/nodes/:nodeId/upload（为什么要单独一条路由见 proxyUpload）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ canvasId: string; nodeId: string }> },
) {
  const { canvasId, nodeId } = await params;
  return proxyUpload(
    request,
    `/canvas/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/upload`,
  );
}
