import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FolderInput, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { installSkill, installSkillFromFolder } from "@/lib/api";

import { SKILLS_QUERY_KEY } from "./skill-list";

/**
 * 安装技能（桌面端版 Web InstallForm）：一栏输入，写法兼容开放技能生态的 `npx skills add`——
 * `owner/repo`、`owner/repo@skill`、`--skill name`、GitHub 链接（含 /tree/<分支>/<子目录>）都认；
 * 整条 `npx skills add …` 命令直接粘进来也行。另可从本机文件夹导入。
 */
export function InstallForm() {
  const qc = useQueryClient();
  const [source, setSource] = useState("");

  const onInstalled = (names: string[]) => {
    void qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["commands"] });
    toast.success(`Installed ${names.join(", ")}`);
  };

  const installMut = useMutation({
    mutationFn: () => installSkill(source.trim()),
    onSuccess: (installed) => {
      onInstalled(installed.map((s) => s.name));
      setSource("");
    },
  });
  const folderMut = useMutation({
    mutationFn: async () => {
      const folder = await window.desktop.pickFolder();
      return folder ? installSkillFromFolder(folder) : null;
    },
    onSuccess: (info) => {
      if (info) onInstalled([info.name]);
    },
    onError: (e) => toast.error(e.message),
  });

  const canSubmit = source.trim() !== "";

  function submit() {
    if (!canSubmit || installMut.isPending) return;
    installMut.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Install a skill</CardTitle>
        <CardDescription>
          Same syntax as <code className="font-mono">npx skills add</code>: a GitHub repository
          (owner/repo), optionally <code className="font-mono">@skill</code> or{" "}
          <code className="font-mono">--skill name</code>, or a full GitHub URL. You can also type{" "}
          <code className="font-mono">/skills add …</code> in any chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Skill source"
            placeholder="anthropics/skills --skill skill-creator"
            className="font-mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={installMut.isPending}
          />
          <Button onClick={submit} disabled={!canSubmit || installMut.isPending}>
            {installMut.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Installing…
              </>
            ) : (
              <>
                <Download className="size-4" /> Install
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => folderMut.mutate()}
            disabled={folderMut.isPending}
          >
            <FolderInput className="size-4" /> Import folder
          </Button>
        </div>

        {installMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {installMut.error instanceof Error
              ? installMut.error.message
              : "Install failed, please try again"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
