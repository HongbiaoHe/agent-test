"use client";

import { CurrentSandboxCard } from "./_components/current-sandbox-card";
import { LifecycleCard } from "./_components/lifecycle-card";
import { NetworkCard } from "./_components/network-card";
import { ProviderCard } from "./_components/provider-card";

// /settings/sandbox：沙箱提供方切换 + 生命周期 + 网络访问 + 当前沙箱状态。
export default function SandboxSettingsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Sandbox</h2>
        <p className="text-sm text-muted-foreground">
          Where the agent runs code, how long the sandbox stays up, and what it can reach.
        </p>
      </header>
      <ProviderCard />
      <LifecycleCard />
      <NetworkCard />
      <CurrentSandboxCard />
    </div>
  );
}
