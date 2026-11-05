import type {
  McpUiHostContext,
  McpUiHostStyles,
  McpUiStyles,
  McpUiStyleVariableKey,
  McpUiTheme,
} from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * 宿主设计 token → MCP Apps 标准主题变量（规范 §Theming）。
 * App 在 iframe 里读不到我们的 CSS 变量，所以把 :root / .dark 上**当前生效**的值算出来传过去；
 * 切换亮暗时重新计算并经 host-context-changed 推送（见 McpAppFrame）。
 */
const TOKEN_MAP: [McpUiStyleVariableKey, string][] = [
  ["--color-background-primary", "--card"],
  ["--color-background-secondary", "--muted"],
  ["--color-background-tertiary", "--accent"],
  ["--color-background-inverse", "--primary"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-text-inverse", "--primary-foreground"],
  ["--color-text-danger", "--destructive"],
  ["--color-text-success", "--success"],
  ["--color-text-warning", "--warning"],
  ["--color-border-primary", "--border"],
  ["--color-border-secondary", "--input"],
  ["--color-ring-primary", "--ring"],
  ["--border-radius-md", "--radius"],
];

export function currentTheme(): McpUiTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function hostStyles(): McpUiHostStyles {
  const root = getComputedStyle(document.documentElement);
  const variables: Partial<McpUiStyles> = {};
  for (const [key, token] of TOKEN_MAP) {
    const value = root.getPropertyValue(token).trim();
    if (value) variables[key] = value;
  }
  const sans = getComputedStyle(document.body).fontFamily;
  if (sans) variables["--font-sans"] = sans;
  // 规范允许宿主只给任意子集（§Theming Host Behavior），但 SDK 把 McpUiStyles 声明成了全键 Record；
  // 缺的键 App 会用自身默认值兜底，这里按子集传是安全的
  return { variables: variables as McpUiStyles };
}

export function hostContext(
  displayMode: "inline" | "fullscreen",
  width: number | undefined,
): McpUiHostContext {
  return {
    theme: currentTheme(),
    styles: hostStyles(),
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions:
      displayMode === "fullscreen"
        ? { height: window.innerHeight, width: window.innerWidth }
        : { maxHeight: INLINE_MAX_HEIGHT, ...(width ? { width } : {}) },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: "desktop",
  };
}

/** 内联卡片的最大高度：超过由 App 自己内部滚动（设计 Q9）。 */
export const INLINE_MAX_HEIGHT = 600;
