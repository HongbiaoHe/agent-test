"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { installSkill } from "@/lib/api";

import { SKILLS_QUERY_KEY } from "./skill-list";

/**
 * 把粘贴的完整 GitHub URL 解析为 {repo, ref?, path?}；非 URL 输入返回 null。
 * 支持：https://github.com/owner/repo(.git)、github.com/owner/repo、
 * git@github.com:owner/repo.git、…/tree/<ref>/<子目录路径>。
 * 后端只收 owner/repo 格式（/^[\w.-]+\/[\w.-]+$/），直接贴 URL 会被校验拒绝，
 * 故在输入层规范化，省得用户手动拆。
 */
function parseGithubUrl(
  input: string,
): { repo: string; ref?: string; path?: string } | null {
  const m =
    /^(?:https?:\/\/)?(?:www\.)?(?:git@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(\S*))?)?\/?$/.exec(
      input.trim(),
    );
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, ref: m[3], path: m[4] };
}

/** 从 GitHub 安装技能的表单卡片：repo / path / ref 三栏 + 安装按钮，含 pending 与错误展示。 */
export function InstallForm() {
  const qc = useQueryClient();
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [ref, setRef] = useState("");

  // repo / path 任一栏粘进完整 GitHub URL 时自动拆解到对应字段
  function applyInput(value: string, field: "repo" | "path") {
    const parsed = parseGithubUrl(value);
    if (parsed) {
      setRepo(parsed.repo);
      if (parsed.path) setPath(parsed.path);
      else if (field === "path") setPath("");
      if (parsed.ref) setRef(parsed.ref);
      return;
    }
    if (field === "repo") setRepo(value);
    else setPath(value);
  }

  const installMut = useMutation({
    mutationFn: () =>
      installSkill({
        repo: repo.trim(),
        path: path.trim(),
        // ref 为空则不传，让后端用默认分支
        ref: ref.trim() || undefined,
      }),
    onSuccess: () => {
      // 安装成功后刷新列表并清空表单
      void qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
      setRepo("");
      setPath("");
      setRef("");
    },
  });

  // repo 与 path 是后端必填项，缺一不可提交
  const canSubmit = repo.trim() !== "" && path.trim() !== "";

  function submit() {
    if (!canSubmit || installMut.isPending) return;
    installMut.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Install a skill from GitHub</CardTitle>
        <CardDescription>
          Enter the repository (owner/repo) and the subdirectory path containing SKILL.md, or paste a full GitHub URL — it will be split automatically. A branch/tag is optional.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label
              htmlFor="skill-repo"
              className="text-sm font-medium text-foreground"
            >
              Repository
            </label>
            <Input
              id="skill-repo"
              placeholder="anthropics/skills or GitHub URL"
              value={repo}
              onChange={(e) => applyInput(e.target.value, "repo")}
              disabled={installMut.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="skill-path"
              className="text-sm font-medium text-foreground"
            >
              Path
            </label>
            <Input
              id="skill-path"
              placeholder="document-skills/docx"
              value={path}
              onChange={(e) => applyInput(e.target.value, "path")}
              disabled={installMut.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="skill-ref"
              className="text-sm font-medium text-foreground"
            >
              Branch/tag (optional)
            </label>
            <Input
              id="skill-ref"
              placeholder="main"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              disabled={installMut.isPending}
            />
          </div>
        </div>

        {installMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {installMut.error instanceof Error
              ? installMut.error.message
              : "Install failed, please try again"}
          </p>
        )}

        <div className="flex justify-end">
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
        </div>
      </CardContent>
    </Card>
  );
}
