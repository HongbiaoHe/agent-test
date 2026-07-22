# 设计：pnpm dev 启动健康检查 + 清缓存

日期：2026-06-15
状态：已确认，待实现

## 背景与问题

当前 `pnpm dev` = `PM2_HOME=./.pm2 pm2 start ecosystem.config.cjs`，拉起两个进程：

- **backend** → `pnpm --filter backend start:dev`（`nest start --watch`，端口 3101）
- **frontend** → 等 3101 起来后 `pnpm --filter frontend dev`（`next dev -p 3100`）

PM2 是守护进程模型：`pm2 start` 发出后进程立刻被标 `online` 并返回，哪怕里面的 `nest` / `next`
几秒后编译报错崩掉，终端也看不出来，必须 `pnpm dev:logs` 才知道服务没正常起。

另外开发时常因构建缓存陈旧（如 Turbopack 陈旧编译错误）踩坑，希望每次启动前清干净。

## 目标

1. **启动失败即时反馈**：`pnpm dev` 在终端就能看出服务起没起成功，失败时打印原因 + 日志并退出非 0。
2. **每次启动清缓存**：清掉前后端构建缓存，避免陈旧缓存导致的假象。

## 非目标

- 不改 PM2 守护进程模型（preview 流程、`PM2_HOME=./.pm2` 端口守护依赖它）。
- 不改 `pnpm dev` 的后台常驻语义（健康检查通过即退出，daemon 后台留着）。
- 不做生产环境编排。

## 方案选型

- **A（采用）**：新增 `scripts/dev.mjs` 包装脚本，`pnpm dev` 改为 `node scripts/dev.mjs`。
  逻辑集中、退出码与报错可控、可读好维护。代价：约 120 行脚本。
- **B（否决）**：package.json 串 shell + 一行健康检查。健康检查逻辑非平凡，塞不进一行，报错弱。
- **C（否决）**：pm2 `--wait-ready` + 应用内 `process.send('ready')`。`next dev` 非我方代码，
  无法干净发 ready 信号，侵入式改 bootstrap。

## 详细设计（`scripts/dev.mjs`）

`pnpm dev` → `node scripts/dev.mjs`，脚本顺序：

1. **清缓存**：递归删 `apps/frontend/.next`（含 Turbopack 缓存）+ `apps/backend/dist`，
   存在才删并打印清了啥。
2. **启动**：以 `PM2_HOME=./.pm2` 跑 `pm2 start ecosystem.config.cjs`。
3. **健康检查**（窗口 90s，脚本顶部常量可调），每约 1s 轮询，命中任一失败条件即停：
   - **PM2 状态**：`pm2 jlist` 解析，任一 app `status === 'errored'`，或 `restart_time`
     较启动基线增长（崩溃重启）→ 判失败。
   - **端口探活**：TCP 探 backend `3101`、frontend `3100`。
   - **日志错误扫描**（best-effort）：扫 PM2 各 app 日志尾部，命中
     `Failed to compile` / `Module not found` / `Error:` / nest `Found N error(s)` 等标记 → 判失败。
   - **成功条件**：两端口都通 + 两进程 `online` + 期间未命中错误标记。
4. **结果输出**：
   - ✅ 成功：打印 `backend  http://localhost:3101`、`frontend http://localhost:3100`，
     退出 0，PM2 daemon 后台留着（行为同现状）。
   - ❌ 失败：打印是哪个服务、命中的失败原因 + 该服务最近 ~40 行日志，退出 1；
     **进程保留不动**，可 `pnpm dev:logs` 查完整日志、`pnpm dev:stop` 手动清。

## 已知取舍

- `next dev` 编译报错时进程不崩、端口仍通，只能靠扫日志标记抓 → best-effort，标记可能漏；
  但「进程崩溃 / 端口起不来」这类硬失败 100% 抓得到。
- 超时窗口内未全部 ready 视为失败并 dump 日志。

## 模块边界

- **唯一新增单元**：`scripts/dev.mjs`，职责单一（编排启动 + 健康判定 + 反馈），
  对外接口就是「被 `pnpm dev` 调用，退出码 0/非 0」。
- `ecosystem.config.cjs` 不动；`package.json` 仅改 `dev` 脚本指向。

## 验证计划

- **正常路径**：`pnpm dev` → 看到清缓存日志 + ✅ + 两个 URL，退出 0，`pnpm dev:status` 显示 online。
- **后端硬失败**：临时制造一个后端启动崩溃（如占用 3101 / 故意 import 崩），`pnpm dev` 应退出非 0
  并打印 backend 日志尾部。
- **前端编译失败**：临时在前端引入一个编译错误，`pnpm dev` 应命中日志标记并退出非 0。
- 验证后还原所有临时改动。
