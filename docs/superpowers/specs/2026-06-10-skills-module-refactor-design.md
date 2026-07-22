# Skills 模块重构设计：对齐 Claude Code 效果 + Daytona 沙箱执行

日期：2026-06-10
状态：已批准（方案 A）
基准：deepagents@1.10.2 官方文档（`.claude/skills/deepagents-dev/reference.md` §9/§14/§15 + https://docs.langchain.com/oss/javascript/deepagents/skills）

## 目标

把现有 skills 实现重构为 Claude Code 同等效果：

1. **Progressive disclosure**：启动只见 frontmatter，命中才读 SKILL.md，reference/脚本按需加载。
2. **可执行**：技能 `scripts/` 能在云沙箱里跑（bash/python/node），由 `execute` 工具驱动。
3. **可安装**：从 GitHub 下载开源 skills（如 anthropics/skills 的 docx/xlsx）。
4. **可配置**：用户级安装/启用/禁用（后端 API 优先，前端最小页面）。
5. **文件管理**：沙箱即 agent 的工作区文件系统，产物可取回。

## 现状问题（已核实）

| 问题 | 位置 |
| --- | --- |
| 每个 job 把全部技能目录全文注入 per-thread state，线性膨胀、跨线程不持久 | `apps/backend/src/worker/agent.processor.ts:76`（buildSkillFiles） |
| StateBackend 无 `execute`，脚本跑不了 | `apps/backend/src/agent/agent.factory.ts:74` |
| 技能只来自启动扫描的本地目录，无安装/隔离/开关 | `apps/backend/src/commands/command-registry.service.ts:75` |
| system prompt 规则散落三处（factory/plan-injection/processor） | 同上各文件 |

## 架构（官方模式）

来自官方 skills 文档「Executing skill scripts in a sandbox」原文模式：

```
SkillsService（注册表：内置目录 + 安装目录 + DB 元数据）
  └─ effectiveSkillsFor(userId) ── worker 每次 run 前懒播种（diff 同步）→ InMemoryStore
       键 = namespace [userId, "skills"]，key /skills/<name>/<rel>，SKILL.md 经 absolutizeRefPaths 改写

agent = createDeepAgent({
  backend: new CompositeBackend(
    daytonaSandbox /* 无 DAYTONA_API_KEY 时回退 new StateBackend() */,
    { "/skills/": readOnly(new StoreBackend({ namespace: rt => {
        const userId = rt.context.userId;
        if (!userId) throw new Error("userId missing in runtime context"); // 禁止静默降级
        return [userId, "skills"];
      } })) },
  ),
  store,
  skills: ["/skills/"],
  middleware: [skillSandboxSyncMiddleware /* beforeAgent: store → sandbox.uploadFiles */, ...现有],
})
```

关键时序与接线（评审补强）：

- **播种时机**：worker 在每次 run 构建 agent **之前**，用 `effectiveSkillsFor(userId)`（内置 + 该用户已启用安装技能，按优先级合并）对 namespace `[userId, "skills"]` 做 diff 同步（put 变更、delete 移除）。源 of truth 是磁盘 + DB；install/PATCH/DELETE 接口只改磁盘和 DB，**不直接动 Store**，下次 run 自然生效。首次运行的用户也由此拿到完整内置技能集，不存在空 namespace。
- **userId 接线**：worker 已取 `conv`（含非空 `userId`），随 `context: { activePlan, userId }` 传入；namespace 工厂缺 userId 时抛错而非回退，杜绝静默共享。
- **/skills/ 只读**：StoreBackend 外包一层 policy wrapper（官方 §9.5 模式）拒绝 `write/edit` 落在 `/skills/` 下，防止 agent 跨线程污染技能库。

- **/skills/ 读取**走 host 端 StoreBackend：快、无沙箱也可用（progressive disclosure 不依赖云）。
- **执行**走默认后端（DaytonaSandbox 的 `execute`）；`beforeAgent` 中间件把当前 namespace 的技能文件上传进沙箱，使 `execute` 能跑 `/skills/<name>/scripts/*`。
- **沙箱即工作区**：agent 的 `ls/read/write/edit/glob/grep`（非 /skills/ 路径）落在沙箱文件系统。
- 模型 API key 永远留在 host（官方 §15.4 sandbox-as-tool 模式）；secrets 不进沙箱（§15.6）。

## 模块设计

### 1. `apps/backend/src/skills/`（新模块，按 CLAUDE.md §5 高内聚）

```
skills/
├── skills.module.ts
├── skills.controller.ts      # REST API（JWT 守卫，按 userId 隔离）
├── skills.service.ts          # 注册表：扫描内置 + 安装目录、合并 DB 元数据、effectiveSkillsFor(userId)
├── skill-parser.ts            # SKILL.md frontmatter 解析 + agentskills.io 规范校验
├── skill-installer.ts         # GitHub codeload tarball 下载子目录、校验、落盘（免 git 依赖）
├── skill-store.seed.ts        # worker 每 run 前调用：effectiveSkillsFor(userId) → diff 同步进 InMemoryStore（含 absolutizeRefPaths）
└── dto/
```

- `skill-parser.ts` 校验：`name` 小写字母数字连字符 1-64 字符且与目录名一致；`description` 必填 ≤1024 字符；可选 `license`/`compatibility`(≤500)/`metadata`(含 `entrypoint`)/`allowed-tools`。
- 现有 `commands` 模块保留 `/` 补全路由，数据源改为 SkillsService；`parse-command.ts` 不动。
- 现有 `worker/skill-files.ts` 的 `buildSkillFiles`（per-run 注入）删除；`absolutizeRefPaths` 移入 skills 模块继续用于播种（解决 read_file 相对路径 404，已实测的问题）。

### 2. 存储布局与 DB

技能只有两层（评审裁剪：原 `_global` 安装层无创建路径，属死态，删除）：

- **内置**：`apps/backend/skills/`（现状不动，所有用户可见，不建 DB 行）。
- **用户安装**：`SKILLS_DATA_DIR`（默认 `apps/backend/data/skills/`）`/<userId>/<name>/`。

```prisma
model Skill {
  id          String   @id @default(cuid())
  name        String
  description String   @db.Text
  source      String   // 如 "github:anthropics/skills#skills/docx@main"
  userId      String   // 非空：安装技能必属于某用户（MySQL 可空唯一键允许重复 NULL，故不留可空层）
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, name])
}
```

- 同名优先级：用户安装 > 内置（对齐官方 §14.6「后者覆盖前者」语义，`effectiveSkillsFor` 合并时体现）。
- 多租户说明：技能按 userId 隔离、内置技能跨租户共享，**本期不做 per-tenant 技能**（YAGNI，Conversation 已有 tenantId，将来要做时在 namespace 工厂加一段即可）。

### 3. REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/skills` | 列表（内置 + 本用户安装；含 enabled/source） |
| POST | `/skills/install` | `{ repo: "anthropics/skills", path: "skills/docx", ref?: "main" }` |
| PATCH | `/skills/:name` | `{ enabled }` |
| DELETE | `/skills/:name` | 删除安装技能（落盘目录 + DB 行） |

安装流程：codeload tarball（`https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`）→ 解压指定子目录 → `skill-parser` 校验 → 落盘 → DB upsert（按 `[userId, name]`）。**不直接动 Store**——下次 run 由 worker 懒播种生效（见架构节）。大小上限沿用 512KB/文件，目录总量上限 20MB。

接口按用户解析（评审补强）：`/` 补全的 `GET /commands` 与运行时按名取技能都改为接收 userId——`SkillsService.effectiveSkillsFor(userId)` 返回**完整 CommandDef（含 files 内容）**，供补全列表、worker 的 `buildSkillPrompt`（需要 SKILL.md 全文）与播种共用；同名时用户安装技能覆盖内置。

### 4. Agent 装配（`agent.factory.ts`）

- backend 改为上述 CompositeBackend；`contextSchema` 增加 `userId`（必填接线见架构节）。
- `BuildAgentOptions` 变更：backend/store 由 worker 构建后**传入**（沙箱是 per-thread 资源，工厂内部不再自建后端）。
- 新增 `skillSandboxSyncMiddleware`（官方写法）：`beforeAgent` 里 `store.search([userId, "skills"])` → `backend.uploadFiles([["/skills/...", bytes]])`；无沙箱（回退 StateBackend）时跳过。
- `SYSTEM_PROMPT` 用 `/optimize-agent-prompt` skill 重写：收编斜杠命令、progressive disclosure 策略、execute/脚本守则（含「跑脚本前先读 SKILL.md 对应指示」「产物写入工作区」）；**execute 守则段仅在沙箱可用时注入**（StateBackend 回退时无 execute 工具，无条件注入会诱发 tool-not-found）；保留多轮防重读（`buildSkillPrompt`）与 plan 回注（`plan-injection.ts`）机制。

### 5. 沙箱生命周期（worker）

官方 §15.3 thread-scoped 写法：

```typescript
let sb;
try { sb = await client.findOne({ labels: { thread_id: conversationId } }); }
catch { sb = await client.create({ labels: { thread_id: conversationId }, autoStopInterval: 15, autoDeleteInterval: 3600 }); }
const backend = await DaytonaSandbox.fromId(sb.id);
```

- env：`DAYTONA_API_KEY`；未配置时回退 `StateBackend`（无 execute，本地/CI 可用）。
- **停机恢复**：闲置 15 分钟后沙箱处于 stopped 态，后续轮次 `findOne` 拿到的是停机实例——`DaytonaSandbox.fromId` 是否自动 start 以实际包为准（实现时验证；需要则显式 `client.start(sb)`）。
- 免费额度控制：短 autoStop + 1h autoDelete；按秒计费、停机只付存储。
- **单进程假设**：InMemoryStore 是进程级缓存；当前 API 与 BullMQ worker 同进程，成立。多实例部署时播种发生在 worker 进程、每 run 前从磁盘+DB diff 同步重建，不依赖跨进程失效通知（写入接口不动 Store 正是为此）。

### 6. 文件管理（最小）

- `GET /conversations/:id/files` → 列出该 thread 沙箱工作区文件（经 backend `ls`/`glob`，排除 `/skills/`）——`downloadFiles` 需要显式路径，先有列表才可发现产物。
- `GET /conversations/:id/files?path=` → 经 `downloadFiles` 取回单个产物。
- 沙箱不存在/已删时返回 404 业务码。

### 7. 前端（最小，遵守 §6/§7 设计系统）

- `/skills` 页面：技能列表（名称/描述/来源 badge/Switch 开关）+「从 GitHub 安装」表单（repo/path/ref）。shadcn/ui + 语义 tokens。
- 聊天内 `execute` 工具调用复用现有 tool_start/tool_end 工具卡通道，不新增组件。

### 8. 错误处理与安全

- 安装：校验失败/下载失败返回业务异常（现有 `BusinessException` 体系）；路径穿越防护（解压时拒绝 `..`）。
- 沙箱：`execute` 输出过大由 deepagents 自动落盘（§6）；沙箱创建失败 → 降级 StateBackend 并在消息流提示「本轮无执行能力」。
- secrets：模型 key 只在 host；不向沙箱注入任何 env secret。

## 测试与验证

1. 单测（jest，node 22）：parser 校验矩阵、installer 解包（本地 fixture tarball、路径穿越拒绝）、store 播种键名/absolutize、用户 namespace 隔离、同名覆盖优先级。
2. 真实开源技能 e2e（手动）：安装 `anthropics/skills` 的 `docx` 或 `xlsx` + 1 个社区 skill；验证 (a) 命中技能后按需 read_file reference；(b) execute 在 Daytona 跑 scripts 产出文件；(c) `/conversations/:id/files` 取回产物。
3. 回归：既有 conversation 流式/审批/多轮计划回注不破（现有 spec 全绿）。

## 不做（YAGNI）

- 前端完整技能市场/编辑器 UI（下期）。
- 内置技能的 per-user 禁用。
- Assistant-scoped 共享沙箱、auth proxy、网络封锁策略（需要时再加）。
- StoreBackend 换持久化存储（InMemoryStore 由注册表随时重建，磁盘+DB 才是 source of truth）。

## 风险

- `@langchain/daytona@0.2.0` 很新：实现以实际包 API 为准，若与文档出入以包为准并在代码注释记录。
- anthropics/skills 的 python 脚本可能需要 pip 依赖：由 agent 按 SKILL.md 指示在沙箱内 `pip install`（Daytona 默认镜像含 python）。
