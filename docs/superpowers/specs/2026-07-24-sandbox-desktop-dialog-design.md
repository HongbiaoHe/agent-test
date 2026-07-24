# Sandbox 桌面查看窗口设计

日期：2026-07-24
状态：已确认（用户批准）

## 目标

Sandbox 状态面板加「打开桌面」入口：点击弹 Dialog 内嵌 noVNC 桌面，可查看并直接操作沙箱的图形界面。

## 已验证的技术事实（本会话实测）

- Daytona 默认镜像开箱支持 `sandbox.computerUse.start()`：拉起 Xvfb + XFCE4 + x11vnc + noVNC 四进程（实测全 Running，首次约 3-5s）。
- `sandbox.getSignedPreviewUrl(6080, ttl)` 返回免鉴权签名 URL（curl 200）；noVNC 页面路径 `/vnc.html?autoconnect=true&resize=scale`（Daytona 控制台 VNC tab 同款，iframe 内可看可操作）。
- 已知拦截页：签名 URL 浏览器首访显示 Daytona「Preview URL Warning」，点一次「I Understand, Continue」即可；Daytona 自家 dashboard 也在 iframe 里这么用，说明不禁嵌。

## 已确认的需求决策

| 决策点 | 结论 |
| --- | --- |
| 桌面生命周期 | 打开 Dialog 时懒启动（幂等 start）；**关闭 Dialog 即 computerUse.stop()** |
| 入口形态 | 状态面板里一行带图标按钮（lucide `Monitor`），仅沙箱 Running 时可用 |
| 拦截页处理 | 用户在 iframe 内点一次继续；若实测 CSP 禁嵌 → 降级为新标签打开 |

## 架构

```
SandboxStatusButton (Sheet)
  └─ 「打开桌面」按钮（state==='started' 才可用）
       └─ DesktopDialog
            open → POST /sandbox/desktop → { url } → <iframe src={url}>
            close → DELETE /sandbox/desktop（fire-and-forget）

POST /sandbox/desktop:  findUserSandbox → computerUse.start()（幂等）
                        → getSignedPreviewUrl(6080, 3600)
                        → { url: `${signed}/vnc.html?autoconnect=true&resize=scale` }
DELETE /sandbox/desktop: computerUse.stop()；沙箱不存在/已停 → 静默成功
```

## 组件与改动面

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/backend/src/sandbox/sandbox.service.ts` | 修改 | `startDesktop(userId)` / `stopDesktop(userId)` |
| `apps/backend/src/sandbox/sandbox.controller.ts` | 修改 | `POST /sandbox/desktop`、`DELETE /sandbox/desktop` |
| `apps/backend/src/sandbox/sandbox.service.spec.ts` | 修改 | desktop start/stop 单测（mock SDK） |
| `apps/frontend/src/lib/api.ts` | 修改 | `startSandboxDesktop()` / `stopSandboxDesktop()` |
| `apps/frontend/src/app/agent/_components/desktop-dialog.tsx` | 新增 | Dialog + loading 骨架 + iframe + 错误重试 |
| `apps/frontend/src/app/agent/_components/sandbox-panel.tsx` | 修改 | 入口按钮 |
| `apps/frontend/src/components/ui/dialog.tsx` | 新增（如缺） | shadcn Dialog 原语 |

## 错误处理

- 沙箱不存在/未运行：POST 返回明确错误；前端按钮本身仅 Running 可用（双保险）。
- POST 失败：Dialog 内错误文案 + 重试按钮。
- DELETE 失败：静默忽略（桌面随沙箱 5 分钟闲置 auto-stop 一并回收）。
- 签名 URL 有效期 3600s：Dialog 单次打开会话足够；重开重新签发。

## 测试

- 后端：service 单测（start 幂等调用链、stop 静默容错）。
- 前端：`pnpm lint` + `tsc` 0 error。
- preview 实测：开 Dialog → 过拦截页 → XFCE 桌面可见可操作 → 关 Dialog → `computerUse.getStatus()` 为非 active。

## 明确不做（YAGNI）

- 不做实时缩略图/截图轮询。
- 不做后端 VNC websocket 代理（拦截页与域名暴露可接受）。
- 不做多桌面会话管理（一个用户一个沙箱一个桌面）。
