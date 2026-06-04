/**
 * 计划延续注入（纯逻辑，刻意不依赖 langchain/deepagents，便于在 jest 里单测）。
 *
 * 若 runtime context 带有 `activePlan`（worker 从 DB 算出的「当前任务计划」文本），就把它 concat
 * 到本次模型调用的 systemMessage 末尾；否则原样透传。
 *
 * 为什么要追加到「末尾」：deepagents 内置的 todoListMiddleware 会往系统提示里追加一段鼓励
 * 「随时重订计划」的说明（TODO_LIST_MIDDLEWARE_SYSTEM_PROMPT），多轮里这会诱导模型整表重写
 * todos、把没做完的步骤冲掉。本函数由 planContinuationMiddleware 承载，在 createDeepAgent 的
 * middleware 链里排于 todoListMiddleware 之后 = 更内层，systemMessage.concat 发生得更晚 = 离模型
 * 最近（recency）。把「沿用既定计划、勿整表重写」放在最后，才能盖过那句「随时重订」。
 */
export function injectActivePlan(
  request: {
    systemMessage: { concat: (s: string) => unknown };
    runtime?: { context?: { activePlan?: string } };
  },
  handler: (req: unknown) => unknown,
): unknown {
  const activePlan = request.runtime?.context?.activePlan;
  if (!activePlan) return handler(request);
  return handler({
    ...request,
    systemMessage: request.systemMessage.concat(`\n\n${activePlan}`),
  });
}

/**
 * 「引用文件必读」硬规则（杠杆3）。SKILL.md 只是入口索引——它正文引用到的 references/*.md、
 * 子技能链接、模板/词库等资产，凡产出依赖其内容的结果之前都必须先 read_file 读取，禁止凭摘要臆造。
 *
 * 这条规则在 base SYSTEM_PROMPT 里已有较详版本，但 base 提示在中间件链最外层 = 最早注入，被后续
 * 一堆中间件提示（todo/skills/fs/...）挤到很靠前的位置，弱模型读到生成位置时已"忘了"。这里以
 * recency 最强的末尾位置再钉一遍（机制同 planContinuationMiddleware），专治"读了 SKILL.md 就凭
 * 摘要硬答、不下钻 references/sub-skill"。
 */
export const SKILL_READ_POLICY =
  `重要 · 引用文件必读（progressive disclosure 硬规则）：当前会话可能已激活某个技能。SKILL.md 只是入口索引——` +
  `它正文中引用到的文件（\`references/*.md\`、子技能(sub-skill)的 markdown 链接、模板/词库/示例等资产），` +
  `凡产出任何依赖其内容的结果之前，必须先用 \`read_file\` 读取对应文件并按其指示执行；尤其被标注为` +
  `「阶段前置/强制/必须先 read_file」的引用，未成功读取前禁止产出对应阶段的内容。` +
  `不要凭 SKILL.md 里的摘要或先验臆造这些被引用文件的内容。遵循按需加载：只读当前这一步真正需要的引用文件，` +
  `但绝不跳过被要求前置读取的文件。`;

/**
 * 始终把「引用文件必读」规则 concat 到 systemMessage 末尾（由 skillReadPolicyMiddleware 承载）。
 * 静态规则，与会话无关，故无条件注入。
 */
export function injectSkillReadPolicy(
  request: { systemMessage: { concat: (s: string) => unknown } },
  handler: (req: unknown) => unknown,
): unknown {
  return handler({
    ...request,
    systemMessage: request.systemMessage.concat(`\n\n${SKILL_READ_POLICY}`),
  });
}
