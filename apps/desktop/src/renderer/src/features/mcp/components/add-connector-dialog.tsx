
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { createMcpServer, useMcpConnect } from "@/components/mcp";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * 添加自定义连接器：填名称（可选）+ URL。提交即探测连接——
 * server 要求登录（401）会弹出授权窗口，无需鉴权的直接连上（设计 Q2 / Q11）。
 */
export function AddConnectorDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const { connect, pendingId } = useMcpConnect();
  const pending = pendingId === "custom";

  const canSubmit = /^https?:\/\/\S+$/.test(url.trim()) && !pending;

  async function submit() {
    if (!canSubmit) return;
    await connect("custom", () =>
      createMcpServer({ url: url.trim(), name: name.trim() || undefined }),
    );
    setName("");
    setUrl("");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add custom connector</DialogTitle>
          <DialogDescription>
            Paste the URL of a remote MCP server (Streamable HTTP). If it
            requires sign-in, a window opens to authorize Spark.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              placeholder="Optional — defaults to the server's own name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Server URL</span>
            <Input
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending && <Loader2 className="animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
