/**
 * 后台任务工具（desktop 版，名称 / 参数 / 说明对照 apps/backend/src/background/background.tools.ts）：
 * - watch_until：反复调一个只读 MCP 工具直到某字段到达目标值；
 * - run_in_background：在本机工作区后台跑长命令（只读权限的会话不提供；询问权限的会话要先审批）；
 * - schedule_wakeup：过一段时间带着备注唤醒自己；
 * - cancel_background_task：取消。
 */
import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import { modelToolName } from '@agent-test/agent-core/mcp/mcp-naming';
import { effectivePermission, type RuntimeServer } from '@agent-test/agent-core/mcp/mcp-types';
import { z } from 'zod';
import type { WorkspacePermission } from '../../shared/workspace';
import type { BackgroundService } from './background-service';
import { LIMITS } from './background-types';

export const RUN_IN_BACKGROUND_TOOL = 'run_in_background';

export interface BackgroundToolContext {
  conversationId: string;
  /** 命令的工作目录（会话工作区） */
  workspaceDir: string;
  /** 后台命令日志目录（会话运行目录下，agent 只读可达） */
  logDir: string;
  permission: WorkspacePermission;
  mcpServers: RuntimeServer[];
}

const STARTED_NOTE =
  'Started in the background. You will automatically receive a <task-notification> message when it finishes — do NOT poll, re-check or sleep. Tell the user it is running in the background and end your turn now unless you have other independent work.';

function clamp(n: number | undefined, min: number, max: number, dflt: number): number {
  if (n === undefined || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function started(view: { id: string; kind: string; title: string }, extra: Record<string, string> = {}): string {
  return JSON.stringify({
    taskId: view.id,
    kind: view.kind,
    title: view.title,
    status: 'running',
    ...extra,
    note: STARTED_NOTE,
  });
}

function failed(message: string): string {
  return JSON.stringify({ error: message });
}

/** arguments_json → 参数对象：工具 schema 里不能用自由键对象（Gemini 不收），模型给 JSON 字符串 */
function parseArgs(raw: string | undefined): Record<string, z.infer<ReturnType<typeof z.json>>> | string {
  if (!raw?.trim()) return {};
  const parsed = z.record(z.string(), z.json()).safeParse(safeJson(raw));
  if (parsed.success) return parsed.data;
  return safeJson(raw) === undefined ? 'arguments_json is not valid JSON' : 'arguments_json must be a JSON object';
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 找到 agent 侧工具名对应的 MCP server / 原始工具；只放行「始终允许」的工具（后台轮询绕过人工审批） */
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

export function createBackgroundTools(bg: BackgroundService, ctx: BackgroundToolContext): StructuredToolInterface[] {
  const { conversationId } = ctx;

  const watchUntil = tool(
    (input) => {
      const target = resolveWatchTarget(ctx.mcpServers, input.tool);
      if (!target) return failed(`Unknown MCP tool ${input.tool}`);
      if ('error' in target) return failed(target.error ?? '');
      const args = parseArgs(input.arguments_json);
      if (typeof args === 'string') return failed(args);
      try {
        bg.assertCapacity(conversationId);
        const intervalSec = clamp(input.interval_seconds, LIMITS.watch.minIntervalSec, LIMITS.watch.maxIntervalSec, 10);
        const view = bg.create({
          conversationId,
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
          timeoutMin: clamp(input.timeout_minutes, 1, LIMITS.maxTimeoutMin, LIMITS.watch.defaultTimeoutMin),
          notify: input.notify ?? true,
          firstTickMs: intervalSec * 1000,
        });
        return started(view);
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    {
      name: 'watch_until',
      description:
        'Poll a read-only MCP tool in the background (no model calls) until a field in its result reaches a target value, e.g. wait for a generation task: tool="buzzvideo__get_task", arguments_json=\'{"taskId":"123"}\', until_path="status", done_values=["completed"], fail_values=["failed"]. ' +
        'Use this instead of calling a status tool repeatedly or sleeping. Returns immediately; you get a <task-notification> with the final tool result when it finishes or times out.',
      schema: z.object({
        title: z.string().describe('Short label shown to the user, e.g. "Waiting for cat image"'),
        tool: z.string().describe('Full MCP tool name to poll (as listed in your tools), must be "Always allow"'),
        arguments_json: z.string().describe('Arguments for that tool as a JSON object string'),
        until_path: z
          .string()
          .describe('Dot path of the field to check in the tool result, e.g. "status" or "tasks.0.status"'),
        done_values: z.array(z.string()).describe('Values meaning success'),
        fail_values: z.array(z.string()).optional().describe('Values meaning failure'),
        interval_seconds: z
          .number()
          .optional()
          .describe(
            `Poll interval, ${LIMITS.watch.minIntervalSec}-${LIMITS.watch.maxIntervalSec}s (default 10). Use the server's suggested poll interval if it gives one.`,
          ),
        timeout_minutes: z
          .number()
          .optional()
          .describe(`Give up after this long (default ${LIMITS.watch.defaultTimeoutMin}, max ${LIMITS.maxTimeoutMin})`),
        notify: z.boolean().optional().describe('Wake you up when done (default true)'),
      }),
    },
  );

  const scheduleWakeup = tool(
    (input) => {
      try {
        bg.assertCapacity(conversationId);
        const delayMin = clamp(input.delay_minutes, LIMITS.wakeup.minDelayMin, LIMITS.wakeup.maxDelayMin, 5);
        const view = bg.create({
          conversationId,
          kind: 'wakeup',
          title: input.title,
          spec: { note: input.note },
          timeoutMin: delayMin,
          notify: true,
          firstTickMs: delayMin * 60_000,
        });
        return started(view);
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
        note: z.string().describe('What to do when you wake up — include every detail you will need'),
        delay_minutes: z
          .number()
          .describe(`Minutes from now (${LIMITS.wakeup.minDelayMin}-${LIMITS.wakeup.maxDelayMin})`),
      }),
    },
  );

  const cancelTask = tool(
    ({ task_id }) => {
      try {
        const view = bg.cancel(task_id);
        if (view.conversationId !== conversationId) return failed(`Unknown task ${task_id}`);
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

  const tools: StructuredToolInterface[] = [watchUntil, scheduleWakeup, cancelTask];

  // 只读会话不能执行命令：不提供后台命令
  if (ctx.permission !== 'read_only') {
    tools.push(
      tool(
        async (input) => {
          try {
            bg.assertCapacity(conversationId);
            const view = await bg.startCommand({
              conversationId,
              title: input.title,
              command: input.command,
              cwd: ctx.workspaceDir,
              logDir: ctx.logDir,
              timeoutMin: clamp(input.timeout_minutes, 1, LIMITS.maxTimeoutMin, LIMITS.command.defaultTimeoutMin),
              notify: input.notify ?? true,
            });
            return started(view, { log: `${ctx.logDir}/${view.id}/out.log` });
          } catch (e) {
            return failed(e instanceof Error ? e.message : String(e));
          }
        },
        {
          name: RUN_IN_BACKGROUND_TOOL,
          description:
            'Run a long shell command on the user\'s computer in the background (e.g. a big ffmpeg render, a build, a long script). Same working directory as execute. The tool result tells you where the output log is. ' +
            'Returns immediately; you get a <task-notification> with the exit code and output tail when it ends. Use execute for anything that finishes within a minute.',
          schema: z.object({
            title: z.string().describe('Short label shown to the user'),
            command: z.string().describe('Shell command to run'),
            timeout_minutes: z
              .number()
              .optional()
              .describe(`Kill after this long (default ${LIMITS.command.defaultTimeoutMin}, max ${LIMITS.maxTimeoutMin})`),
            notify: z.boolean().optional().describe('Wake you up when done (default true)'),
          }),
        },
      ),
    );
  }
  return tools;
}

/** 后台任务的系统提示块（与工具一起注入，口径同 backend backgroundPrompt） */
export function backgroundPrompt(canRunCommands: boolean): string {
  return (
    '\n\n## 后台任务与等待\n' +
    '需要等待异步结果（生成任务的状态、长时间运行的命令、过一会儿再检查的事）时，不要反复调用状态查询工具，也不要用 sleep 等待——每一次调用都要消耗一整轮模型推理。改用：\n' +
    '- `watch_until`：在后台轮询一个只读 MCP 工具（如生成任务的 get_task），直到某字段到达目标值；\n' +
    (canRunCommands ? '- `run_in_background`：在后台跑超过一分钟的长命令（execute 单条最长 120 秒）；\n' : '') +
    '- `schedule_wakeup`：过一段时间带着备注唤醒自己。\n' +
    '发起后台任务后，告诉用户任务在后台进行，然后**直接结束本轮**（除非还有不依赖其结果的其它工作）。' +
    '任务结束时系统会以一条 `<task-notification>` 消息唤醒你——它由系统生成，不是用户发言；据其中的结果继续完成用户的请求，并用一两句话向用户汇报。'
  );
}
