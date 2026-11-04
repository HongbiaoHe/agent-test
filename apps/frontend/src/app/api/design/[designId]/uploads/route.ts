import { proxyUpload } from "../../../_lib/proxy-upload";

/** 设计稿的图片上传（图层贴图 / agent 附件）：流式转给后端 POST /design/:id/uploads（为什么要单独一条路由见 proxyUpload）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ designId: string }> },
) {
  const { designId } = await params;
  return proxyUpload(request, `/design/${encodeURIComponent(designId)}/uploads`);
}
