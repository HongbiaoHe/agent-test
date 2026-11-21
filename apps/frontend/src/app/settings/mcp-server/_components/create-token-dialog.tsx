"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import {
  ALL_SCOPES,
  createMcpToken,
  MCP_GRANTS_KEY,
  type McpScope,
  SCOPE_INFO,
} from "@/components/mcp-server/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { CopyBlock } from "./copy-button";
import { claudeCodeCommand, mcpJson } from "./snippets";

const EXPIRY_LABEL = {
  "30": "30 days",
  "90": "90 days",
  "365": "1 year",
  never: "Never",
} as const;
type Expiry = keyof typeof EXPIRY_LABEL;
const isExpiry = (v: unknown): v is Expiry =>
  typeof v === "string" && v in EXPIRY_LABEL;

/**
 * 新建个人访问令牌：名称 + 权限 + 有效期。建好后令牌明文只显示这一次，
 * 连同填好令牌的接入片段一起给出，关掉就再也看不到了。
 */
export function CreateTokenDialog({
  open,
  onClose,
  mcpUrl,
}: {
  open: boolean;
  onClose: () => void;
  mcpUrl: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<McpScope[]>(ALL_SCOPES);
  const [expiry, setExpiry] = useState<Expiry>("90");
  const create = useMutation({
    mutationFn: () =>
      createMcpToken({
        name: name.trim(),
        scopes,
        ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: MCP_GRANTS_KEY }),
  });
  const token = create.data?.token;

  // 关闭动画放完再清空：否则淡出那几帧会闪回空表单（令牌页先被重置掉）
  function reset() {
    setName("");
    setScopes(ALL_SCOPES);
    setExpiry("90");
    create.reset();
  }
  const close = onClose;

  const canSubmit = name.trim() !== "" && scopes.length > 0 && !create.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      onOpenChangeComplete={(o) => !o && reset()}
    >
      <DialogContent className="sm:max-w-lg">
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle>Token created</DialogTitle>
              <DialogDescription>
                Copy it now — it won&apos;t be shown again.
              </DialogDescription>
            </DialogHeader>
            {/* min-w-0：弹窗是 grid，子项默认 min-width:auto，长令牌会把弹窗横向撑破 */}
            <div className="min-w-0 space-y-3">
              <CopyBlock value={token} label="Copy token" />
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Anyone with this token can act on your canvases with the
                permissions you chose. Revoke it if it leaks.
              </div>
              <p className="text-sm font-medium">Claude Code</p>
              <CopyBlock value={claudeCodeCommand(mcpUrl, token)} />
              <p className="text-sm font-medium">mcp.json</p>
              <CopyBlock value={mcpJson(mcpUrl, token)} />
            </div>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create access token</DialogTitle>
              <DialogDescription>
                For MCP clients you configure by hand: paste the token into the
                client&apos;s config as a Bearer header.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit) create.mutate();
              }}
            >
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Name</span>
                <Input
                  placeholder="e.g. Cursor on my laptop"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={200}
                  autoFocus
                />
              </label>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Permissions</legend>
                {ALL_SCOPES.map((s) => (
                  <label key={s} className="flex items-start gap-3">
                    <Checkbox
                      className="mt-0.5"
                      checked={scopes.includes(s)}
                      onCheckedChange={(on) =>
                        setScopes((prev) =>
                          on
                            ? ALL_SCOPES.filter((x) => x === s || prev.includes(x))
                            : prev.filter((x) => x !== s),
                        )
                      }
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm">{SCOPE_INFO[s].label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {SCOPE_INFO[s].description}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Expires</span>
                <Select
                  items={EXPIRY_LABEL}
                  value={expiry}
                  onValueChange={(v) => {
                    if (isExpiry(v)) setExpiry(v);
                  }}
                >
                  <SelectTrigger aria-label="Expires" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(EXPIRY_LABEL) as Expiry[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {EXPIRY_LABEL[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {create.isError && (
                <p className="text-sm text-destructive">
                  {create.error instanceof Error
                    ? create.error.message
                    : "Failed to create token"}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {create.isPending && <Loader2 className="animate-spin" />}
                  Create token
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
