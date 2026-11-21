import { Bot } from "lucide-react";
import type { StaticImageData } from "next/image";
import claudeSvg from "simple-icons/icons/claude.svg";
import cursorSvg from "simple-icons/icons/cursor.svg";
import copilotSvg from "simple-icons/icons/githubcopilot.svg";
import geminiSvg from "simple-icons/icons/googlegemini.svg";
import kimiSvg from "simple-icons/icons/kimi.svg";
import opencodeSvg from "simple-icons/icons/opencode.svg";
import qwenSvg from "simple-icons/icons/qwen.svg";
import traeSvg from "simple-icons/icons/trae.svg";
import windsurfSvg from "simple-icons/icons/windsurf.svg";

import { cn } from "@/lib/utils";

/**
 * 经画布 MCP 对外服务连进来的是哪个 agent：后端把客户端在 MCP initialize 里自报的名字
 * （clientInfo.title，没有就 name；OAuth 授权兜底 DCR 注册名）写进运行锁的 label，这里按名字认品牌。
 *
 * 已核实的上报名：Claude Code = "Claude Code"（name: claude-code），Cursor = "Cursor"。
 * 其余按名字里的品牌词匹配。simple-icons 已不收录 OpenAI，Codex 只能用通用图标 + 名字。
 *
 * 图标按文件引用 simple-icons/icons/*.svg（每个约 2KB），不要从包入口按名导入：入口是 5MB 的
 * 全量图标表，开发模式下会被整个编进每个用到它的页面。
 */
/** .svg 导入：Next 的图片导入给 { src }，Turbopack 处理 node_modules 里的文件时直接给 URL 字符串，两种都认 */
type IconAsset = StaticImageData | string;
const srcOf = (icon: IconAsset) => (typeof icon === "string" ? icon : icon.src);

interface AgentBrand {
  test: RegExp;
  /** 上报的是 claude-code 这种标识符时，改用这个名字显示 */
  name: string;
  icon: IconAsset | null;
  /** 品牌色（彩色标识，取自 simple-icons）；不给则跟随文字色——近黑的单色标识在暗色模式下才看得见 */
  color?: string;
}

const BRANDS: AgentBrand[] = [
  { test: /claude|anthropic/i, name: "Claude", icon: claudeSvg, color: "#D97757" },
  { test: /codex|openai|chatgpt/i, name: "Codex", icon: null },
  { test: /cursor/i, name: "Cursor", icon: cursorSvg },
  { test: /gemini/i, name: "Gemini", icon: geminiSvg, color: "#8E75B2" },
  { test: /copilot|visual studio code|vscode/i, name: "GitHub Copilot", icon: copilotSvg },
  { test: /windsurf|codeium/i, name: "Windsurf", icon: windsurfSvg },
  { test: /opencode/i, name: "OpenCode", icon: opencodeSvg },
  { test: /qwen/i, name: "Qwen Code", icon: qwenSvg, color: "#6950EF" },
  { test: /kimi/i, name: "Kimi", icon: kimiSvg },
  { test: /trae/i, name: "TRAE", icon: traeSvg },
];

function brandOf(agent: string): AgentBrand | null {
  return BRANDS.find((b) => b.test.test(agent)) ?? null;
}

/** 给人看的 agent 名：上报的是 claude-code 这种标识符就换成品牌名，否则原样（如 “Claude Code”） */
export function agentDisplayName(agent: string): string {
  const brand = brandOf(agent);
  return brand && /^[a-z0-9._/-]+$/.test(agent) ? brand.name : agent;
}

/** agent 的品牌 logo；认不出的用通用机器人图标 */
export function AgentLogo({
  agent,
  className,
}: {
  agent: string | null;
  className?: string;
}) {
  const brand = agent ? brandOf(agent) : null;
  if (!brand?.icon) {
    return <Bot className={cn("shrink-0", className)} aria-hidden />;
  }
  // SVG 当遮罩、底色填形状：单色标识用 bg-current 跟随文字色，彩色标识用品牌官方固定色
  // （不走主题 token，同登录页的 Google 图标）
  const mask = `url(${srcOf(brand.icon)}) center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0", !brand.color && "bg-current", className)}
      style={{ backgroundColor: brand.color, mask, WebkitMask: mask }}
    />
  );
}
