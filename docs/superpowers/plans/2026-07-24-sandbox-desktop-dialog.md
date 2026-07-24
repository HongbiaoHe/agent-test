# Sandbox 桌面查看窗口实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sandbox 状态面板加「打开桌面」按钮，弹 Dialog 内嵌 noVNC 桌面可查看可操作；打开懒启动 computerUse，关闭即停。

**Architecture:** 后端在 `agent/sandbox.ts` 加 SDK 层 helper（GuardedSandbox 不暴露 computerUse，须走 `new Daytona().get(id)` 原生对象），`sandbox.service/controller` 加 POST/DELETE `/sandbox/desktop`；前端 shadcn Dialog + iframe。

**Tech Stack:** @daytonaio/sdk 0.185（computerUse / getSignedPreviewUrl）、NestJS、Next.js 16 + shadcn Dialog。

**约束（覆盖模板默认）：** CLAUDE.md 禁自动 commit——Commit 步骤替换为「标记完成，用户 review 后统一提交」。测试前 `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH`。

**设计文档：** docs/superpowers/specs/2026-07-24-sandbox-desktop-dialog-design.md

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/backend/src/agent/sandbox.ts` | 修改 | `startUserDesktop(userId)` / `stopUserDesktop(userId)`（SDK 直连） |
| `apps/backend/src/common/errors/error-code.ts` | 修改 | 新增 `SANDBOX_NOT_RUNNING`(40008) |
| `apps/backend/src/sandbox/sandbox.service.ts` | 修改 | `startDesktop` / `stopDesktop`（薄封装 + 错误语义） |
| `apps/backend/src/sandbox/sandbox.controller.ts` | 修改 | `POST /sandbox/desktop`、`DELETE /sandbox/desktop` |
| `apps/backend/src/sandbox/sandbox.service.spec.ts` | 修改 | desktop 用例（沿用既有 jest.mock 模式） |
| `apps/frontend/src/components/ui/dialog.tsx` | 新增 | `pnpm dlx shadcn@latest add dialog` |
| `apps/frontend/src/lib/api.ts` | 修改 | `startSandboxDesktop` / `stopSandboxDesktop` |
| `apps/frontend/src/app/agent/_components/desktop-dialog.tsx` | 新增 | Dialog + loading + iframe + 错误重试；关闭时 DELETE |
| `apps/frontend/src/app/agent/_components/sandbox-panel.tsx` | 修改 | 「打开桌面」入口按钮 |

### Task 1: SDK 层 helper（agent/sandbox.ts）

- [ ] **Step 1.1** 在 `apps/backend/src/agent/sandbox.ts` 末尾追加：

```ts
/** noVNC web 客户端端口（computerUse.start 拉起的 novnc 进程监听 6080） */
const DESKTOP_PORT = 6080;
/** 签名预览 URL 有效期（秒）：单次 Dialog 会话足够，重开重签 */
const DESKTOP_URL_TTL_S = 3600;

/**
 * 启动用户沙箱的图形桌面并返回 noVNC 访问地址。
 *
 * GuardedSandbox 不暴露 computerUse/getSignedPreviewUrl，须走 SDK 原生对象
 * （client.get(id)）。沙箱不存在或未运行返回 null（是否报错由调用方定语义）。
 * computerUse.start() 幂等：已 active 时秒回。
 */
export async function startUserDesktop(userId: string): Promise<string | null> {
  if (!process.env.DAYTONA_API_KEY) return null;
  const existing = await pickUserSandbox(userId);
  if (!existing || existing.state !== 'started') return null;

  const sb = await new Daytona().get(existing.id);
  await sb.computerUse.start();
  const signed = await sb.getSignedPreviewUrl(DESKTOP_PORT, DESKTOP_URL_TTL_S);
  return `${signed.url}/vnc.html?autoconnect=true&resize=scale`;
}

/**
 * 停止用户沙箱的图形桌面（Dialog 关闭时调用）。
 * 收尾语义：沙箱不存在/已停/stop 失败一律静默——桌面进程随沙箱 auto-stop 一并回收。
 */
export async function stopUserDesktop(userId: string): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) return;
  try {
    const existing = await pickUserSandbox(userId);
    if (!existing || existing.state !== 'started') return;
    const sb = await new Daytona().get(existing.id);
    await sb.computerUse.stop();
  } catch {
    // 收尾失败无害，见上
  }
}
```

- [ ] **Step 1.2** `tsc --noEmit` 0 error。

### Task 2: 错误码 + service（TDD）

- [ ] **Step 2.1** `error-code.ts` SANDBOX_NOT_FOUND 后追加：

```ts
  SANDBOX_NOT_RUNNING: {
    code: 40008,
    message: 'Sandbox is not running; desktop unavailable',
  },
```

- [ ] **Step 2.2** `sandbox.service.spec.ts` 追加失败测试（mock 区新增 `startUserDesktop`/`stopUserDesktop`）：

```ts
const mockStartUserDesktop = jest.fn();
const mockStopUserDesktop = jest.fn();
// jest.mock('../agent/sandbox', ...) 工厂里追加：
//   startUserDesktop: (...args: unknown[]) => mockStartUserDesktop(...args),
//   stopUserDesktop: (...args: unknown[]) => mockStopUserDesktop(...args),

describe('desktop', () => {
  it('startDesktop：helper 返回 url → 原样返回', async () => {
    mockStartUserDesktop.mockResolvedValue('https://x/vnc.html?autoconnect=true&resize=scale');
    expect(await service.startDesktop('u1')).toEqual({
      url: 'https://x/vnc.html?autoconnect=true&resize=scale',
    });
  });

  it('startDesktop：helper 返回 null（无沙箱/未运行）→ SANDBOX_NOT_RUNNING', async () => {
    mockStartUserDesktop.mockResolvedValue(null);
    await expect(service.startDesktop('u1')).rejects.toMatchObject({
      // BusinessException 携带 SANDBOX_NOT_RUNNING 错误码（按项目异常结构断言）
    });
  });

  it('stopDesktop：透传 helper 且不抛错', async () => {
    mockStopUserDesktop.mockResolvedValue(undefined);
    await expect(service.stopDesktop('u1')).resolves.toBeUndefined();
    expect(mockStopUserDesktop).toHaveBeenCalledWith('u1');
  });
});
```

- [ ] **Step 2.3** 跑测试确认失败（service 无此方法）。
- [ ] **Step 2.4** `sandbox.service.ts` 实现：

```ts
// import 区追加 startUserDesktop, stopUserDesktop

  /** 启动桌面并返回 noVNC 地址；沙箱不存在或未运行 → SANDBOX_NOT_RUNNING */
  async startDesktop(userId: string): Promise<{ url: string }> {
    const url = await startUserDesktop(userId);
    if (!url) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_RUNNING,
        HttpStatus.CONFLICT,
      );
    }
    return { url };
  }

  /** 停止桌面（收尾语义，永不抛错） */
  async stopDesktop(userId: string): Promise<void> {
    await stopUserDesktop(userId);
  }
```

- [ ] **Step 2.5** controller 追加：

```ts
// import Delete, Post
  @Post('desktop')
  startDesktop(@CurrentUser() user: AuthUser) {
    return this.sandbox.startDesktop(user.id);
  }

  @Delete('desktop')
  stopDesktop(@CurrentUser() user: AuthUser) {
    return this.sandbox.stopDesktop(user.id);
  }
```

（按 controller 现有 user 取值方式对齐——先读文件确认是 `user.id` 还是 `user.sub`。）

- [ ] **Step 2.6** 全量后端测试 + tsc 全绿。

### Task 3: 前端 Dialog

- [ ] **Step 3.1** `cd apps/frontend && pnpm dlx shadcn@latest add dialog --yes`
- [ ] **Step 3.2** `lib/api.ts` 追加：

```ts
/** 启动沙箱桌面（幂等），返回 noVNC iframe 地址 */
export function startSandboxDesktop(): Promise<{ url: string }> {
  return request<{ url: string }>("/sandbox/desktop", { method: "POST" });
}

/** 停止沙箱桌面（Dialog 关闭时 fire-and-forget） */
export function stopSandboxDesktop(): Promise<void> {
  return request<void>("/sandbox/desktop", { method: "DELETE" });
}
```

- [ ] **Step 3.3** 新增 `desktop-dialog.tsx`：受控 Dialog；open 时 useQuery(POST) 显示「正在启动桌面…」骨架 → iframe（`className="h-full w-full border-0"`，容器 `h-[85vh]`）；失败显示错误 + 重试；`onOpenChange(false)` 时 `stopSandboxDesktop().catch(() => {})`。iframe 上方一行 `text-xs text-muted-foreground` 说明「首次访问需在窗口内点一次 “I Understand, Continue”」。
- [ ] **Step 3.4** `sandbox-panel.tsx`：状态区下加一行按钮（lucide `Monitor`，`variant="outline" size="sm"`，`disabled={state !== 'started'}`）→ 打开 DesktopDialog。
- [ ] **Step 3.5** `pnpm lint` + 前端 `tsc --noEmit` 0 error。

### Task 4: 端到端验证（preview）

- [ ] **Step 4.1** 开 preview → Sandbox 面板 → 点「打开桌面」→ 过 Daytona 拦截页 → 看到 XFCE 桌面（截图留证）。
- [ ] **Step 4.2** iframe 内点击开始菜单等，确认可操作。
- [ ] **Step 4.3** 关闭 Dialog → 用脚本查 `computerUse.getStatus()` 应为非 active。
- [ ] **Step 4.4** 沙箱停机态：按钮禁用（可改 DB/等停机或代码路径确认）。

## 完成标准

后端测试全绿、双端 tsc 0 error、lint 0 error、preview 实测三步通过；不 commit，带 Verification 汇报。
