import { Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export interface ToolCall {
  name: string;
  args?: unknown;
  result?: string;
  done: boolean;
}

export function ToolCard({ tool }: { tool: ToolCall }) {
  return (
    <Card className="space-y-1 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={tool.done ? "default" : "secondary"}>
          <Wrench />
          {tool.name}
        </Badge>
        {!tool.done && (
          <span className="text-xs text-muted-foreground">cooking…</span>
        )}
      </div>
      {tool.args != null && (
        <pre className="text-xs text-muted-foreground">
          args: {JSON.stringify(tool.args)}
        </pre>
      )}
      {tool.result && (
        <pre className="overflow-auto rounded bg-muted p-2 text-xs">
          {tool.result}
        </pre>
      )}
    </Card>
  );
}
