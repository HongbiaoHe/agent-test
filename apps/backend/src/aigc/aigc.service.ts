import { Injectable, Logger } from '@nestjs/common';
import { AigcClient } from './aigc.client';
import {
  buildTaskBody,
  defaultConfig,
  derivedDims,
  findModel,
  sanitizeParams,
  taskPath,
  toCatalog,
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
    const channels = await this.channels(input.type);
    const found = findModel(channels, input.config.channel, input.config.model);
    if (!found) {
      throw new Error(
        `aigc 目录里没有模型 ${input.config.channel}/${input.config.model}`,
      );
    }
    const references = input.references.slice(
      0,
      found.model.image_input_number,
    );
    if (references.length < input.references.length) {
      this.logger.warn(
        `${input.config.model} 只接受 ${found.model.image_input_number} 张参考图，丢掉多余 ${
          input.references.length - references.length
        } 张`,
      );
    }
    const config: AigcMediaConfig = {
      channel: found.channel,
      model: found.model.model_alias,
      params: sanitizeParams(
        found.model,
        input.config.params,
        derivedDims(references),
      ),
    };
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
    this.logger.log(
      `aigc 接单 task=${taskId} ${config.channel}/${config.model} params=${JSON.stringify(
        config.params,
      )} refs=${references.length}`,
    );
    return { taskId, config };
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
