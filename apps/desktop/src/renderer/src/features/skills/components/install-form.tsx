import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FolderInput, Loader2 } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [source, setSource] = useState("");

  const onInstalled = (names: string[]) => {
    void qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["commands"] });
    toast.success(t("extensions.skills.install.installed", { names: names.join(", ") }));
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
        <CardTitle className="text-base">{t("extensions.skills.install.title")}</CardTitle>
        <CardDescription>
          <Trans
            i18nKey="extensions.skills.install.description"
            components={{ code: <code className="font-mono" /> }}
          />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label={t("extensions.skills.install.sourceLabel")}
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
                <Loader2 className="size-4 animate-spin" /> {t("extensions.skills.install.installing")}
              </>
            ) : (
              <>
                <Download className="size-4" /> {t("extensions.skills.install.install")}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => folderMut.mutate()}
            disabled={folderMut.isPending}
          >
            <FolderInput className="size-4" /> {t("extensions.skills.install.importFolder")}
          </Button>
        </div>

        {installMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {installMut.error instanceof Error
              ? installMut.error.message
              : t("extensions.skills.install.failed")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
