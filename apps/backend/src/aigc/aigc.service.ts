import { Injectable, Logger } from '@nestjs/common';
import { AigcClient } from './aigc.client';
import {
  agentDerivedDims,
  audioReferenceIssues,
  resolveAgentModel,
  toAgentCatalog,
  validateAgentRequest,
  VOICE_CLONE_MODEL,
  type AgentCatalogView,
  type AgentParamIssue,
  type ReferenceCounts,
} from './aigc.agent';
import {
  buildTaskBody,
  defaultConfig,
  derivedDims,
  findModel,
  sanitizeParams,
  taskPath,
  toCatalog,
  videoRefRole,
} from './aigc.catalog';
import {
  type AigcCatalog,
  type AigcChannel,
  type AigcMediaConfig,
  type AigcMediaType,
  type AigcReference,
  type AigcTask,
} from './aigc.types';

/** 能力目录缓存时长：模型清单在后台配，几分钟的滞后可以接受，省掉每次生成都去拉一遍。 */
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * aigc 业务层：能力目录（带缓存）、模型选择的归一化、接单。
 *
 * 不碰数据库、不认识 MediaVersion —— 谁调它谁负责落库（见 MediaProcessor）。
 * 这样「模型目录 / 参数约束」这一摊知识收在本目录里，媒体域只管状态流转。
 */
@Injectable()
export class AigcService {
  private readonly logger = new Logger(AigcService.name);
  private readonly cache = new Map<
    AigcMediaType,
    { channels: AigcChannel[]; at: number }
  >();

  constructor(private readonly client: AigcClient) {}

  /** 某类型的能力目录（含默认模型）。 */
  async catalog(type: AigcMediaType): Promise<AigcCatalog> {
    return toCatalog(type, await this.channels(type));
  }

  /** 给对话 agent 看的精简目录（list_media_models 工具的返回）。 */
  async agentCatalog(type: AigcMediaType): Promise<AgentCatalogView> {
    return toAgentCatalog(type, await this.channels(type));
  }

  /**
   * agent 发起生成前的严格校验（见 aigc.agent）：解析模型名、逐项校验档位/提示词/参考图张数。
   * 不合法时返回 issues 交回模型改参，**不**像 resolveConfig 那样静默回落或收窄。
   */
  async prepareAgentGeneration(
    type: AigcMediaType,
    req: {
      model?: string;
      channel?: string;
      params?: Record<string, string>;
      prompt: string;
      referenceCounts: ReferenceCounts;
    },
  ): Promise<
    | { ok: true; config: AigcMediaConfig }
    | { ok: false; issues: AgentParamIssue[] }
  > {
    const resolved = resolveAgentModel(await this.channels(type), req);
    if ('issue' in resolved) return { ok: false, issues: [resolved.issue] };
    const { channel, model } = resolved;
    const checked = validateAgentRequest(model, {
      params: req.params ?? {},
      prompt: req.prompt,
      referenceCounts: req.referenceCounts,
      derived: agentDerivedDims(type, model.model_alias, req.referenceCounts),
    });
    const extra =
      type === 'audio' ? audioReferenceIssues(req.referenceCounts) : [];
    if (!checked.ok) {
      return { ok: false, issues: [...checked.issues, ...extra] };
    }
    if (extra.length) return { ok: false, issues: extra };
    return {
      ok: true,
      config: { channel, model: model.model_alias, params: checked.params },
    };
  }

  /**
   * 画布 agent 给生成节点设模型前的严格校验（set_node_model）：解析模型名、逐项校验档位，
   * 不合法返回 issues 交回模型改参。与 prepareAgentGeneration 的差别：画布的参考素材取自入边，
   * 超出模型上限的部分提交时丢掉（submit / MediaProcessor.loadRefUrls）而不是拒绝——所以先按同样的
   * 规则把张数截一下再推 derived 维度，不因上游连多了就不让换模型；也不查提示词（换模型时还没定稿）。
   * dropped：按这个模型，各类上游素材有几个不会被提交（工具回给模型，让它知道这个选择的代价）。
   */
  async prepareNodeConfig(
    type: 'image' | 'video',
    req: {
      model?: string;
      channel?: string;
      params?: Record<string, string>;
      referenceCounts: ReferenceCounts;
    },
  ): Promise<
    | { ok: true; config: AigcMediaConfig; dropped: ReferenceCounts }
    | { ok: false; issues: AgentParamIssue[] }
  > {
    const resolved = resolveAgentModel(await this.channels(type), req);
    if ('issue' in resolved) return { ok: false, issues: [resolved.issue] };
    const { channel, model } = resolved;
    const firstFrame =
      type === 'video' && videoRefRole(model.model_alias) === 'first_frame';
    const used: ReferenceCounts = {
      // 首帧模式只取第一张图（MediaProcessor.loadRefUrls），其余按模型上限截（AigcService.submit）
      image: Math.min(
        req.referenceCounts.image,
        firstFrame ? 1 : model.image_input_number,
        model.image_input_number,
      ),
      video: Math.min(req.referenceCounts.video, model.video_input_number),
      audio: Math.min(req.referenceCounts.audio, model.audio_input_number),
    };
    const checked = validateAgentRequest(model, {
      params: req.params ?? {},
      prompt: '',
      referenceCounts: used,
      derived: agentDerivedDims(type, model.model_alias, used),
    });
    if (!checked.ok) return checked;
    return {
      ok: true,
      config: { channel, model: model.model_alias, params: checked.params },
      dropped: {
        image: req.referenceCounts.image - used.image,
        video: req.referenceCounts.video - used.video,
        audio: req.referenceCounts.audio - used.audio,
      },
    };
  }

  /**
   * 归一化一次生成的模型选择：
   * 节点上没配 / 配的模型已下线 → 回落该类型的默认模型（目录第一个）；
   * 档位参数按模型维度收窄（缺必填补第一个取值，多余维度丢掉）。
   */
  async resolveConfig(
    type: AigcMediaType,
    requested?: Partial<AigcMediaConfig> | null,
  ): Promise<AigcMediaConfig> {
    const channels = await this.channels(type);
    const found =
      requested?.channel && requested?.model
        ? findModel(channels, requested.channel, requested.model)
        : null;
    if (!found) {
      const fallback = defaultConfig(channels);
      if (!fallback) {
        throw new Error(`aigc 目录里没有可用的 ${type} 模型`);
      }
      if (requested?.channel || requested?.model) {
        this.logger.warn(
          `模型 ${requested.channel}/${requested.model} 不在目录里，回落默认 ${fallback.channel}/${fallback.model}`,
        );
      }
      return fallback;
    }
    return {
      channel: found.channel,
      model: found.model.model_alias,
      params: sanitizeParams(found.model, requested?.params ?? {}),
    };
  }

  /**
   * 提交前的收窄（submit 与画布测试模式共用）：参考素材按类型截到模型上限（保持原顺序），
   * 再按截后的参考重算 derived 维度、收窄档位。kept 与传入的 references 一一对应：哪些会被提交。
   */
  async prepareSubmission(input: {
    type: AigcMediaType;
    config: AigcMediaConfig;
    references: readonly AigcReference[];
  }): Promise<{
    config: AigcMediaConfig;
    references: AigcReference[];
    kept: boolean[];
  }> {
    const channels = await this.channels(input.type);
    const found = findModel(channels, input.config.channel, input.config.model);
    if (!found) {
      throw new Error(
        `aigc 目录里没有模型 ${input.config.channel}/${input.config.model}`,
      );
    }
    // 按类型各自截到模型上限（保持原顺序）：图 / 视频 / 音频的上限互相独立
    const limits: ReferenceCounts = {
      image: found.model.image_input_number,
      video: found.model.video_input_number,
      audio: found.model.audio_input_number,
    };
    const used: ReferenceCounts = { image: 0, video: 0, audio: 0 };
    // voice 的源录音走独立字段 source_audio_url（目录里三个 *_input_number 都是 0），不按上限截
    const kept = input.references.map(
      (r) => input.type === 'voice' || used[r.type]++ < limits[r.type],
    );
    const references = input.references.filter((_, i) => kept[i]);
    if (references.length < input.references.length) {
      this.logger.warn(
        `${input.config.model} 参考素材上限 图${limits.image}/视频${limits.video}/音频${limits.audio}，丢掉多余 ${
          input.references.length - references.length
        } 个`,
      );
    }
    return {
      config: {
        channel: found.channel,
        model: found.model.model_alias,
        params: sanitizeParams(
          found.model,
          input.config.params,
          derivedDims(references),
        ),
      },
      references,
      kept,
    };
  }

  /**
   * 接单：按本次参考资源重算 derived 维度、再收窄档位后提交，返回 task_id 与**实际生效**的档位
   * （调用方据此落库，好让界面显示的与真提交的一致）。参考资源超过模型上限的部分丢掉。
   */
  async submit(input: {
    type: AigcMediaType;
    prompt: string;
    config: AigcMediaConfig;
    references: readonly AigcReference[];
    callbackUrl?: string;
    metadata?: Record<string, string>;
    traceId?: string;
  }): Promise<{ taskId: string; config: AigcMediaConfig }> {
    const { config, references } = await this.prepareSubmission(input);
    const body = buildTaskBody({
      type: input.type,
      prompt: input.prompt,
      config,
      references,
      callbackUrl: input.callbackUrl,
      metadata: input.metadata,
    });
    const { taskId } = await this.client.createTask(
      taskPath(input.type),
      body,
      input.traceId,
    );
    // 带上参考资源的 role：它不由用户选、而是按模型能力推出来的（见 videoRefRole），
    // 出问题时第一个要看的就是「这单到底按参考图还是首帧提交的」。
    const refInfo = references.length
      ? `${references.length}(${references[0].role})`
      : '0';
    this.logger.log(
      `aigc 接单 task=${taskId} ${config.channel}/${config.model} params=${JSON.stringify(
        config.params,
      )} refs=${refInfo}`,
    );
    return { taskId, config };
  }

  /**
   * 克隆音色模型的可选语言与 demo 文案上限（给 agent 看，list_media_models type=audio 里附带）。
   * 目录里没有这个模型（被下线）时返回 null。
   */
  async voiceCloneSpec(): Promise<{
    languages: { value: string; label: string }[];
    maxDemoChars?: number;
  } | null> {
    const found = findModel(
      await this.channels('voice'),
      VOICE_CLONE_MODEL.channel,
      VOICE_CLONE_MODEL.model,
    );
    if (!found) return null;
    const language = found.model.params.find(
      (p) => p.param_type === 'language',
    );
    return {
      languages: (language?.options ?? []).map((o) => ({
        value: o.value,
        label: o.label,
      })),
      maxDemoChars: found.model.max_prompt,
    };
  }

  /** 查任务详情（回调没到时的对账）。 */
  getTask(taskId: string): Promise<AigcTask> {
    return this.client.getTask(taskId);
  }

  private async channels(type: AigcMediaType): Promise<AigcChannel[]> {
    const hit = this.cache.get(type);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.channels;
    const channels = await this.client.listChannels(type);
    this.cache.set(type, { channels, at: Date.now() });
    return channels;
  }
}
