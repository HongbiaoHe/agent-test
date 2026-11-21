/**
 * Web 后端画布接口的客户端（desktop 的画布数据在 Web 账号下，与 Web 端同一批画布）：
 *  - 用户操作（画布视图）：GET/POST /canvas/...，与 Web 前端同一套接口，规则（运行期只读、revision 冲突）由服务端执行；
 *  - 本机 agent：/canvas-agent/...（运行锁、以 agent 身份写入、生成 / 拼接、注入文本）。
 *
 * 返回值是我方后端的 DTO（形状由 @agent-test/canvas-schema 定义，两端共用同一份类型），这里只做轻量的
 * 形状守卫，不逐字段重复校验。
 */
import type {
  AigcCatalog,
  ApplyOpResult,
  CanvasIoType,
  CanvasListItem,
  CanvasOpInput,
  CanvasRunLock,
  CanvasSnapshot,
} from '@agent-test/canvas-schema';
import type { CanvasNodeConfigResult } from '@agent-test/agent-core/canvas/canvas-tools';
import { z } from 'zod';
import type { WebApi } from '../web-media/web-api';

const enc = encodeURIComponent;

const objectSchema = z.record(z.string(), z.unknown());

/**
 * 我方后端 DTO → 类型。只确认是个对象（接口返回已经过 Web 后端的类型约束：两端共用 canvas-schema 的定义），
 * 不在客户端重复一遍逐字段校验。断言安全的前提：路径与返回类型一一对应，由本文件集中维护。
 */
function ownDto<T>(v: unknown): T {
  return objectSchema.parse(v) as T;
}

export class CanvasWeb {
  constructor(private readonly web: WebApi) {}

  // ─── 用户操作（画布视图） ───

  async list(cursor?: string): Promise<{ items: CanvasListItem[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
    return ownDto(await this.web.get(`/canvas?${q.toString()}`));
  }

  async create(title?: string): Promise<{ sessionId: string }> {
    return ownDto(await this.web.post('/canvas', title ? { title } : {}));
  }

  async snapshot(id: string): Promise<CanvasSnapshot> {
    return ownDto(await this.web.get(`/canvas/${enc(id)}`));
  }

  async rename(id: string, title: string): Promise<void> {
    await this.web.patch(`/canvas/${enc(id)}`, { title });
  }

  async applyOp(id: string, op: CanvasOpInput, baseRevision: number): Promise<ApplyOpResult> {
    return ownDto(await this.web.post(`/canvas/${enc(id)}/ops`, { op, baseRevision }));
  }

  async move(id: string, nodeId: string, x: number, y: number): Promise<void> {
    await this.web.post(`/canvas/${enc(id)}/nodes/${enc(nodeId)}/move`, { x, y });
  }

  async generate(id: string, nodeId: string): Promise<{ generationId: string }> {
    return ownDto(await this.web.post(`/canvas/${enc(id)}/nodes/${enc(nodeId)}/generate`, {}));
  }

  async merge(id: string, nodeId: string): Promise<{ generationId: string }> {
    return ownDto(await this.web.post(`/canvas/${enc(id)}/nodes/${enc(nodeId)}/merge`, {}));
  }

  async pauseMedia(id: string, nodeId?: string): Promise<{ paused: number; skipped: number }> {
    return z
      .object({ paused: z.number(), skipped: z.number() })
      .parse(await this.web.post(`/canvas/${enc(id)}/media/pause`, nodeId ? { nodeId } : {}));
  }

  async resumeMedia(id: string, nodeId?: string): Promise<void> {
    await this.web.post(`/canvas/${enc(id)}/media/resume`, nodeId ? { nodeId } : {});
  }

  async setFocus(id: string, nodeIds: string[]): Promise<{ focusNodeIds: string[] }> {
    return ownDto(await this.web.post(`/canvas/${enc(id)}/focus`, { nodeIds }));
  }

  /** 给上传节点传文件：本机路径流式读盘发出；没有路径时直接发字节 */
  async uploadNodeFile(
    id: string,
    nodeId: string,
    file: {
      source: { kind: 'path'; path: string } | { kind: 'bytes'; bytes: Uint8Array<ArrayBuffer> };
      contentType: string;
      filename: string;
    },
  ): Promise<{ generationId: string; versionId: string }> {
    const url = `/canvas/${enc(id)}/nodes/${enc(nodeId)}/upload?filename=${enc(file.filename)}`;
    return ownDto(
      file.source.kind === 'path'
        ? await this.web.upload(url, file.source.path, file.contentType)
        : await this.web.uploadBytes(url, file.source.bytes, file.contentType),
    );
  }

  async aigcModels(type: 'image' | 'video'): Promise<AigcCatalog> {
    return ownDto(await this.web.get(`/aigc/models?type=${type}`));
  }

  // ─── 本机 agent（/canvas-agent，需持锁的写入都带 holderId） ───

  async lock(id: string, holderId: string, label: string | null): Promise<CanvasRunLock> {
    return ownDto(
      await this.web.post(`/canvas-agent/${enc(id)}/lock`, { holderId, ...(label ? { label: label.slice(0, 200) } : {}) }),
    );
  }

  async unlock(id: string, holderId: string): Promise<void> {
    await this.web.post(`/canvas-agent/${enc(id)}/unlock`, { holderId });
  }

  async agentContext(id: string): Promise<string> {
    return z.object({ text: z.string() }).parse(await this.web.get(`/canvas-agent/${enc(id)}/context`)).text;
  }

  async agentOp(id: string, holderId: string, op: CanvasOpInput): Promise<ApplyOpResult> {
    return ownDto(await this.web.post(`/canvas-agent/${enc(id)}/ops`, { holderId, op }));
  }

  async nodeConfig(
    id: string,
    type: 'image' | 'video',
    req: { model?: string; channel?: string; params?: Record<string, string>; referenceCounts: Record<CanvasIoType, number> },
  ): Promise<CanvasNodeConfigResult> {
    return ownDto(await this.web.post(`/canvas-agent/${enc(id)}/node-config`, { type, ...req }));
  }

  async agentGeneration(
    id: string,
    holderId: string,
    input: {
      type: 'image' | 'video';
      prompt: string;
      referenceVersionIds?: string[];
      config: { channel?: string; model?: string; params?: Record<string, string> };
    },
  ): Promise<{ generationId: string } | { error: unknown }> {
    return ownDto(await this.web.post(`/canvas-agent/${enc(id)}/generations`, { holderId, ...input }));
  }

  async agentConcat(id: string, holderId: string, sources: string[]): Promise<{ generationId: string } | { error: unknown }> {
    return ownDto(await this.web.post(`/canvas-agent/${enc(id)}/concats`, { holderId, sources }));
  }

  async uploadedAsset(
    id: string,
    scope: string,
    versionId: string,
  ): Promise<{ generationId: string; type: CanvasIoType; filename: string } | null> {
    const r = ownDto<{ asset: { generationId: string; type: CanvasIoType; filename: string } | null }>(
      await this.web.post(`/canvas-agent/${enc(id)}/uploaded-asset`, { scope, versionId }),
    );
    return r.asset;
  }

  async modelCatalog(type: 'image' | 'video'): Promise<unknown> {
    return this.web.get(`/media-api/models?type=${type}`);
  }
}
