"use client";

import { CircleAlert, CircleCheck, Clock, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type SandboxEgressMode, type SandboxSettings } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSandboxSettings } from "../_hooks/use-sandbox-settings";

const EGRESS_OPTIONS: { value: SandboxEgressMode; label: string; detail: string }[] = [
  {
    value: "open",
    label: "Open internet",
    detail: "The agent can install packages and call any external API.",
  },
  {
    value: "allowlist",
    label: "Allowlist only",
    detail: "Only the hosts listed below are reachable; everything else is blocked.",
  },
  {
    value: "blocked",
    label: "No internet",
    detail: "All outbound traffic is blocked. Package installs and API calls will fail.",
  },
];

/** 常用软件源（pip / npm / GitHub），一键填入白名单。 */
const COMMON_SOURCES = [
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
];

const ALLOW_LIST_MAX = 50;
// 与后端 network.ts ALLOW_ENTRY_RE 同一套规则：IPv4 / IPv4 CIDR / 域名（可 *. 前缀）
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_CIDR_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}(\\/(3[0-2]|[12]?\\d))?$`);
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
const isValidEntry = (e: string) => IPV4_CIDR_RE.test(e) || DOMAIN_RE.test(e);

function parseLines(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean))];
}

type EgressSync = NonNullable<SandboxSettings["egressSync"]>;

const SYNC_COPY: Record<EgressSync, { Icon: typeof CircleCheck; text: string; tone: string }> = {
  applied: {
    Icon: CircleCheck,
    text: "Applied to your current sandbox.",
    tone: "text-muted-foreground",
  },
  pending: {
    Icon: Clock,
    text: "Your sandbox isn't running; this applies the next time the agent uses it.",
    tone: "text-muted-foreground",
  },
  failed: {
    Icon: CircleAlert,
    text: "Couldn't apply to the running sandbox. It retries on the next run; if that fails too, the run goes without the sandbox.",
    tone: "text-destructive",
  },
};

/**
 * 沙箱网络：出站（开放 / 白名单 / 禁止）+ 入站（端口公网地址是否免鉴权）。
 * 出站保存后立即作用到运行中的沙箱；入站只能在创建沙箱时设定（E2B 限制），对之后新建的沙箱生效。
 */
export function NetworkCard() {
  const { query, mutation } = useSandboxSettings();
  const [lastSync, setLastSync] = useState<EgressSync | null>(null);

  const data = query.data;
  const provider = data?.providers.find((p) => p.name === data.current);
  const saveEgress = (patch: { egressMode?: SandboxEgressMode; allowList?: string[] }) =>
    mutation.mutate(patch, { onSuccess: (res) => setLastSync(res.egressSync ?? null) });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Network</CardTitle>
        <CardDescription>
          Control what the sandbox can reach on the internet, and who can reach services the agent
          starts inside it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isLoading ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : query.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {query.error instanceof Error ? query.error.message : "Failed to load"}
          </p>
        ) : data && provider ? (
          <>
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Outbound access</h3>
              {!provider.supportsEgressControl && (
                <p className="text-xs text-muted-foreground">
                  {`On this ${provider.name === "daytona" ? "Daytona" : "provider"} account, `}outbound
                  access is managed by the provider (common services such as PyPI, npm and GitHub
                  only) and can&apos;t be changed per sandbox. Your choice below applies when you use
                  E2B.
                </p>
              )}
              <RadioGroup
                aria-label="Outbound access"
                value={data.network.egress}
                onValueChange={(v) => {
                  const mode = EGRESS_OPTIONS.find((o) => o.value === v)?.value;
                  if (mode && mode !== data.network.egress) saveEgress({ egressMode: mode });
                }}
                disabled={mutation.isPending || !provider.supportsEgressControl}
              >
                {EGRESS_OPTIONS.map((o) => (
                  <label
                    key={o.value}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors",
                      provider.supportsEgressControl
                        ? "cursor-pointer hover:bg-accent"
                        : "cursor-not-allowed opacity-60",
                      data.network.egress === o.value && "border-primary/40 bg-accent/60",
                    )}
                  >
                    <RadioGroupItem value={o.value} className="mt-0.5" />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm font-medium">{o.label}</span>
                      <span className="block text-xs text-muted-foreground">{o.detail}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>

              {data.network.egress === "allowlist" && provider.supportsEgressControl && (
                <AllowListEditor
                  // 以已保存内容为 key：保存成功 / 重新加载后重建编辑框，草稿回到最新值（不在 effect 里 setState）
                  key={data.network.allowList.join("\n")}
                  saved={data.network.allowList}
                  domainsSupported={provider.supportsDomainAllowList}
                  pending={mutation.isPending}
                  onSave={(allowList) => saveEgress({ allowList })}
                />
              )}

              {mutation.isPending && mutation.variables?.publicTraffic === undefined ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Saving…
                </p>
              ) : lastSync ? (
                <SyncNote sync={lastSync} />
              ) : null}
            </section>

            <section className="flex items-start justify-between gap-6 border-t border-border pt-5">
              <div className="min-w-0 space-y-0.5">
                <h3 className="text-sm font-medium">Public port URLs</h3>
                <p className="text-xs text-muted-foreground">
                  {provider.supportsPublicTrafficToggle
                    ? "Let anyone with the link open services the agent starts in the sandbox. Off means the link requires the sandbox access token. Applies to sandboxes created after the change."
                    : "Daytona preview links always require an access token."}
                </p>
                {provider.supportsPublicTrafficToggle && data.currentPublicTraffic !== null && (
                  <p className="text-xs text-muted-foreground">
                    Current sandbox:{" "}
                    <span className="font-medium text-foreground">
                      {data.currentPublicTraffic ? "public" : "token required"}
                    </span>
                  </p>
                )}
              </div>
              <Switch
                aria-label="Public port URLs"
                checked={provider.supportsPublicTrafficToggle && data.network.publicTraffic}
                disabled={!provider.supportsPublicTrafficToggle || mutation.isPending}
                onCheckedChange={(checked) => mutation.mutate({ publicTraffic: checked })}
                className="mt-0.5"
              />
            </section>
          </>
        ) : null}
        {mutation.isError && (
          <p className="text-sm text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to save"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SyncNote({ sync }: { sync: EgressSync }) {
  const { Icon, text, tone } = SYNC_COPY[sync];
  return (
    <p className={cn("flex items-start gap-1.5 text-xs", tone)}>
      <Icon className="mt-px size-3.5 shrink-0" />
      {text}
    </p>
  );
}

function AllowListEditor({
  saved,
  domainsSupported,
  pending,
  onSave,
}: {
  saved: string[];
  domainsSupported: boolean;
  pending: boolean;
  onSave: (allowList: string[]) => void;
}) {
  const [text, setText] = useState(saved.join("\n"));
  const entries = parseLines(text);
  const invalid = entries.filter((e) => !isValidEntry(e));
  const domainsIgnored = !domainsSupported && entries.some((e) => DOMAIN_RE.test(e));
  const tooMany = entries.length > ALLOW_LIST_MAX;
  const dirty = entries.join("\n") !== saved.join("\n");

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {domainsSupported
            ? "One per line: domain (wildcards like *.example.com), IP, or CIDR. Domain rules cover HTTP (80) and HTTPS (443) only."
            : "One per line: IP or CIDR (e.g. 10.0.0.0/8). Daytona doesn't support domains."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!domainsSupported}
          onClick={() => setText(parseLines(`${text}\n${COMMON_SOURCES.join("\n")}`).join("\n"))}
        >
          Add package sources
        </Button>
      </div>
      <Textarea
        aria-label="Allowed hosts"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder={domainsSupported ? "pypi.org\n*.github.com\n10.0.0.0/8" : "10.0.0.0/8\n1.1.1.1"}
        className="font-mono text-xs"
      />
      {invalid.length > 0 && (
        <p className="text-xs text-destructive">Not a valid host, IP or CIDR: {invalid.join(", ")}</p>
      )}
      {tooMany && (
        <p className="text-xs text-destructive">
          At most {ALLOW_LIST_MAX} entries ({entries.length} now).
        </p>
      )}
      {domainsIgnored && (
        <p className="text-xs text-warning">
          Domain entries are ignored on Daytona. Without any IP or CIDR entry, all outbound traffic
          is blocked.
        </p>
      )}
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">An empty allowlist blocks all outbound traffic.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!dirty || pending}
          onClick={() => setText(saved.join("\n"))}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || pending || invalid.length > 0 || tooMany}
          onClick={() => onSave(entries)}
        >
          Save allowlist
        </Button>
      </div>
    </div>
  );
}
