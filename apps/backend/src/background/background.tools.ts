import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { GuardedSandbox } from '../agent/guarded-sandbox';
import { modelToolName } from '../mcp/mcp-naming';
import { effectivePermission } from '../mcp/mcp-types';
import type { RuntimeServer } from '../mcp/mcp.service';
import { type BackgroundService } from './background.service';
import { LIMITS } from './background.types';
import { startScript } from './sandbox-command';

export interface BackgroundToolContext {
  conversationId: string;
  userId: string;
  /** 没有沙箱时不提供 run_in_background */
  sandbox: GuardedSandbox | null;
  mcpServers: RuntimeServer[];
}

const STARTED_NOTE =
  'Started in the background. You will automatically receive a <task-notification> message when it finishes — do NOT poll, re-check or sleep. Tell the user it is running in the background and end your turn now unless you have other independent work.';

function clamp(
  n: number | undefined,
  min: number,
  max: number,
  dflt: number,
): number {
  if (n === undefined || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function started(row: { id: string; kind: string; title: string }): string {
  return JSON.stringify({
    taskId: row.id,
    kind: row.kind,
    title: row.title,
    status: 'running',
    note: STARTED_NOTE,
  });
}

function failed(message: string): string {
  return JSON.stringify({ error: message });
}

/** arguments_json → 参数对象：模型给的是 JSON 字符串（工具 schema 里不能用自由键对象，Gemini 不收）。 */
function parseArgs(raw: string | undefined): Prisma.InputJsonObject | string {
  if (!raw?.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // JSON.parse 的产物只可能是 JSON 值，作为 Json 列写入是安全的
      return v;
    }
    return 'arguments_json must be a JSON object';
  } catch {
    return 'arguments_json is not valid JSON';
  }
}

/** 找到 agent 侧工具名对应的 MCP server / 原始工具；只放行「始终允许」的工具（后台轮询绕过人工审批）。 */
function resolveWatchTarget(servers: RuntimeServer[], name: string) {
  for (const s of servers) {
    for (const t of s.tools) {
      if (modelToolName(s.slug, t.name) !== name) continue;
      if (!t.visibility.includes('model')) return null;
      if (effectivePermission(t, s.permissions) !== 'allow') {
        return {
          error: `${name} requires approval, so it cannot be polled in the background. Only tools set to "Always allow" (typically read-only status tools) can be watched.`,
        };
      }
      return { server: s, toolName: t.name };
    }
  }
  return null;
}

/**
 * 后台任务工具（设计：服务端代替模型轮询，结束后通知唤醒 agent）：
 * - watch_until：反复调一个只读 MCP 工具直到某字段到达目标值；
 * - run_in_background：在沙箱里后台跑长命令；
 * - schedule_wakeup：过一段时间带着备注唤醒自己；
 * - cancel_background_task：取消。
 */
export function createBackgroundTools(
  bg: BackgroundService,
  ctx: BackgroundToolContext,
) {
  const base = { conversationId: ctx.conversationId, userId: ctx.userId };

  const watchUntil = tool(
    async (input) => {
      const target = resolveWatchTarget(ctx.mcpServers, input.tool);
      if (!target) return failed(`Unknown MCP tool ${input.tool}`);
      if ('error' in target) return failed(target.error ?? '');
      const args = parseArgs(input.arguments_json);
      if (typeof args === 'string') return failed(args);
      try {
        await bg.assertCapacity(ctx.conversationId);
        const intervalSec = clamp(
          input.interval_seconds,
          LIMITS.watch.minIntervalSec,
          LIMITS.watch.maxIntervalSec,
          10,
        );
        const row = await bg.create({
          ...base,
          kind: 'watch',
          title: input.title,
          spec: {
            serverId: target.server.id,
            serverName: target.server.name,
            toolName: target.toolName,
            modelToolName: input.tool,
            args,
            untilPath: input.until_path,
            doneValues: input.done_values,
            failValues: input.fail_values ?? [],
            intervalSec,
            consecutiveErrors: 0,
          },
          timeoutMin: clamp(
            input.timeout_minutes,
            1,
            LIMITS.maxTimeoutMin,
            LIMITS.watch.defaultTimeoutMin,
          ),
          notify: input.notify ?? true,
          firstTickMs: intervalSec * 1000,
        });
        return started(row);
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    {
      name: 'watch_until',
      description:
        'Poll a read-only MCP tool in the background (server-side, no model calls) until a field in its result reaches a target value, e.g. wait for a generation task: tool="buzzvideo__get_task", arguments_json=\'{"taskId":"123"}\', until_path="status", done_values=["completed"], fail_values=["failed"]. ' +
        'Use this instead of calling a status tool repeatedly or sleeping. Returns immediately; you get a <task-notification> with the final tool result when it finishes or times out.',
      schema: z.object({
        title: z
          .string()
          .describe(
            'Short label shown to the user, e.g. "Waiting for cat image"',
          ),
        tool: z
          .string()
          .describe(
            'Full MCP tool name to poll (as listed in your tools), must be "Always allow"',
          ),
        arguments_json: z
          .string()
          .describe('Arguments for that tool as a JSON object string'),
        until_path: z
          .string()
          .describe(
            'Dot path of the field to check in the tool result, e.g. "status" or "tasks.0.status"',
          ),
        done_values: z.array(z.string()).describe('Values meaning success'),
        fail_values: z
          .array(z.string())
          .optional()
          .describe('Values meaning failure'),
        interval_seconds: z
          .number()
          .optional()
          .describe(
            `Poll interval, ${LIMITS.watch.minIntervalSec}-${LIMITS.watch.maxIntervalSec}s (default 10). Use the server's suggested poll interval if it gives one.`,
          ),
        timeout_minutes: z
          .number()
          .optional()
          .describe(
            `Give up after this long (default ${LIMITS.watch.defaultTimeoutMin}, max ${LIMITS.maxTimeoutMin})`,
          ),
        notify: z
          .boolean()
          .optional()
          .describe('Wake you up when done (default true)'),
      }),
    },
  );

  const scheduleWakeup = tool(
    async (input) => {
      try {
        await bg.assertCapacity(ctx.conversationId);
        const delayMin = clamp(
          input.delay_minutes,
          LIMITS.wakeup.minDelayMin,
          LIMITS.wakeup.maxDelayMin,
          5,
        );
        const row = await bg.create({
          ...base,
          kind: 'wakeup',
          title: input.title,
          spec: { note: input.note },
          timeoutMin: delayMin,
          notify: true,
          firstTickMs: delayMin * 60_000,
        });
        return started(row);
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    {
      name: 'schedule_wakeup',
      description:
        'Wake yourself up after a delay with a note to your future self (e.g. check back on something that changes slowly). Returns immediately; you get a <task-notification> containing the note when the time comes.',
      schema: z.object({
        title: z.string().describe('Short label shown to the user'),
        note: z
          .string()
          .describe(
            'What to do when you wake up — include every detail you will need',
          ),
        delay_minutes: z
          .number()
          .describe(
            `Minutes from now (${LIMITS.wakeup.minDelayMin}-${LIMITS.wakeup.maxDelayMin})`,
          ),
      }),
    },
  );

  const cancelTask = tool(
    async ({ task_id }) => {
      try {
        const view = await bg.cancel(ctx.userId, task_id);
        return JSON.stringify({ taskId: view.id, status: view.status });
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    {
      name: 'cancel_background_task',
      description: 'Cancel a running background task by its taskId.',
      schema: z.object({ task_id: z.string() }),
    },
  );

  const tools: StructuredToolInterface[] = [
    watchUntil,
    scheduleWakeup,
    cancelTask,
  ];

  const sandbox = ctx.sandbox;
  if (sandbox) {
    tools.push(
      tool(
        async (input) => {
          try {
            await bg.assertCapacity(ctx.conversationId);
            const row = await bg.create({
              ...base,
              kind: 'command',
              title: input.title,
              spec: { command: input.command },
              timeoutMin: clamp(
                input.timeout_minutes,
                1,
                LIMITS.maxTimeoutMin,
                LIMITS.command.defaultTimeoutMin,
              ),
              notify: input.notify ?? true,
              firstTickMs: LIMITS.command.pollIntervalSec * 1000,
            });
            const out = await sandbox.execute(
              startScript(row.id, input.command),
            );
            if (!out.output.includes('started')) {
              await bg.failUnexpected(
                row.id,
                new Error(out.output.slice(0, 500)),
              );
              return failed(`Failed to start: ${out.output.slice(0, 500)}`);
            }
            return started(row);
          } catch (e) {
            return failed(e instanceof Error ? e.message : String(e));
          }
        },
        {
          name: 'run_in_background',
          description:
            'Run a long shell command in the sandbox in the background (e.g. a big ffmpeg render, a build, a long script). Same working directory as execute. Output goes to .bg/<taskId>/out.log. ' +
            'Returns immediately; you get a <task-notification> with the exit code and output tail when it ends. Use execute for anything that finishes within a minute.',
          schema: z.object({
            title: z.string().describe('Short label shown to the user'),
            command: z.string().describe('Shell command to run'),
            timeout_minutes: z
              .number()
              .optional()
              .describe(
                `Kill after this long (default ${LIMITS.command.defaultTimeoutMin}, max ${LIMITS.maxTimeoutMin})`,
              ),
            notify: z
              .boolean()
              .optional()
              .describe('Wake you up when done (default true)'),
          }),
        },
      ),
    );
  }
  return tools;
}

/** 后台任务的系统提示块（与工具一起注入）。 */
export function backgroundPrompt(hasSandbox: boolean): string {
  return (
    '\n\n## 后台任务与等待\n' +
    '需要等待异步结果（生成任务的状态、长时间运行的命令、过一会儿再检查的事）时，不要反复调用状态查询工具，也不要用 sleep 等待——每一次调用都要消耗一整轮模型推理。改用：\n' +
    '- `watch_until`：在后台轮询一个只读 MCP 工具（如生成任务的 get_task），直到某字段到达目标值；\n' +
    (hasSandbox
      ? '- `run_in_background`：在沙箱后台跑超过一分钟的长命令；\n'
      : '') +
    '- `schedule_wakeup`：过一段时间带着备注唤醒自己。\n' +
    '发起后台任务后，告诉用户任务在后台进行，然后**直接结束本轮**（除非还有不依赖其结果的其它工作）。' +
    '任务结束时系统会以一条 `<task-notification>` 消息唤醒你——它由系统生成，不是用户发言；据其中的结果继续完成用户的请求，并用一两句话向用户汇报。'
  );
}
