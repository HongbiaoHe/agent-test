# 沙箱状态按钮 + 详情侧栏设计

日期：2026-06-11
状态：已获用户确认（含两个取舍：停机倒计时仅显示配置说明；停机态不列文件）

## 需求

顶栏增加沙箱状态按钮（心跳感指示），点击弹出侧栏：沙箱详细信息、工作区文件列表、自动停机/回收删除倒计时。

## 关键事实（已验证）

- Daytona `list({ labels: { user_id } })` 返回的 Sandbox DTO 含 `state`、`autoStopInterval`（分钟，0=禁用）、`autoDeleteInterval`（分钟，负=禁用）、`createdAt`、`updatedAt`（@daytonaio/api-client sandbox.d.ts:157/169/193）——**纯只读，不唤醒停机沙箱**（区别于 findUserSandbox 会 start）
- 删除倒计时可精确：stopped 态 `updatedAt`（停机时刻）+ autoDeleteInterval → 删除时间点
- 停机倒计时不可精确：Daytona 按活动闲置计时但不暴露 lastActivityAt → running 态显示「闲置 N 分钟自动停机」配置说明（诚实优先，不做假精确）

## 后端

新 `src/sandbox/` 模块：`GET /sandbox/status`（JwtAuthGuard，user 级）：

```
{ exists, id?, state?, createdAt?, updatedAt?, autoStopMinutes?, autoDeleteMinutes?, files?: {path}[] | null }
```

- 无 DAYTONA_API_KEY / 未找到 / 查询异常 → `{ exists: false }`（沙箱本是可降级能力，不报错）
- `files` 仅 `state === 'started'` 时附带：复用工作区 find 命令逻辑——抽 `listWorkspaceFiles(sb)` 共享函数到 `agent/sandbox.ts`，conversations.listFiles 同步改用（DRY）；停机态 `files: null`
- 文件列举失败不影响状态主体（try/catch 单独兜底）

## 前端

- **心跳按钮**（chat-thread 顶栏，详情开关旁，自包含组件 `sandbox-panel.tsx`）：
  Server 图标 + 右上状态点——`started` 绿点 + `animate-ping` 心跳、`stopped` 琥珀静态点、不存在/失败 灰点
- **状态色 token**：globals.css 新增 `--success` / `--warning`（亮暗两套，@theme inline 映射），不在组件硬编码颜色（§7）
- **侧栏**：复用 `components/ui/sheet`（side="right"）——状态徽标、沙箱 ID、创建/更新时间、自动停机/删除配置、**删除倒计时**（stopped 态逐秒跳 mm:ss，归零显「随时回收」）、文件列表（started）或「沙箱停机中，文件在下次运行时可见」（stopped）、「暂无沙箱，发送消息后自动创建」（不存在）
- 轮询：useQuery `refetchInterval: 15_000`；倒计时组件内 1s tick（不打接口）

## 测试

- sandbox.service 单测：无 key → exists:false；list 空 → exists:false；started → 字段映射 + files；stopped → files:null
- tsc/lint 双端；预览 E2E：心跳点、侧栏内容、倒计时跳动（沙箱停机态实测）
