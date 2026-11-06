
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Markdown } from "@/features/chat/components/markdown";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  createCustomSkill,
  getSkillDetail,
  updateCustomSkill,
} from "@/lib/api";
import { currentLocale } from "@/lib/i18n";

import { skillDetailKey } from "./skill-detail-sheet";
import { SKILLS_QUERY_KEY } from "./skill-list";

/** 同后端 CreateCustomSkillDto：名字也是 /命令 名与目录名。 */
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BODY_MAX = 100_000;

/** 编辑器打开方式：新建，或编辑某个手写技能（按名字拉详情回填）。 */
export type CustomSkillEditorTarget = { mode: "create" } | { mode: "edit"; name: string };

/**
 * 手写技能编辑器：名字 + 说明两个输入框，正文是 Markdown 文本框（写 / 预览切换）。
 * 保存时由后端拼 frontmatter 生成 SKILL.md；名字只在新建时可填（它是 /命令 名，建后不改）。
 */
export function CustomSkillEditor({
  target,
  onClose,
}: {
  target: CustomSkillEditorTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(48rem,90vh)] flex-col gap-0 p-0 sm:max-w-2xl">
        {target?.mode === "edit" ? (
          <EditLoader key={target.name} name={target.name} onClose={onClose} />
        ) : target ? (
          <EditorForm onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 编辑模式：先拉详情，拿到说明与正文再挂表单（表单的初始值只取一次）。 */
function EditLoader({ name, onClose }: { name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: skillDetailKey(name),
    queryFn: () => getSkillDetail(name),
  });
  if (query.data) {
    return (
      <EditorForm
        onClose={onClose}
        initial={{
          name,
          description: query.data.description,
          body: query.data.body,
        }}
      />
    );
  }
  return (
    <div className="space-y-3 p-5">
      {query.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {query.error instanceof Error ? query.error.message : t("extensions.skills.detail.loadFailed")}
        </p>
      ) : (
        [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)
      )}
    </div>
  );
}

function EditorForm({
  initial,
  onClose,
}: {
  /** 有值 = 编辑已有技能（名字锁定） */
  initial?: { name: string; description: string; body: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const editing = initial !== undefined;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tab, setTab] = useState<"write" | "preview">("write");

  const nameError =
    !editing && name.trim() !== "" && !NAME_RE.test(name.trim())
      ? t("extensions.skills.editor.nameError")
      : null;
  const canSave =
    (editing || NAME_RE.test(name.trim())) &&
    description.trim() !== "" &&
    body.trim() !== "" &&
    body.length <= BODY_MAX;

  const saveMut = useMutation({
    mutationFn: () =>
      editing
        ? updateCustomSkill(initial.name, { description, body })
        : createCustomSkill({ name: name.trim(), description, body }),
    onSuccess: (skill) => {
      void qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: skillDetailKey(skill.name) });
      // 斜杠命令补全的数据源也是技能表
      void qc.invalidateQueries({ queryKey: ["commands"] });
      onClose();
    },
  });

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>
          {editing
            ? t("extensions.skills.editor.editTitle", { name: initial.name })
            : t("extensions.skills.editor.createTitle")}
        </DialogTitle>
        <DialogDescription>
          <Trans
            i18nKey="extensions.skills.editor.description"
            values={{ command: name.trim() || t("extensions.skills.editor.commandFallback") }}
            components={{ cmd: <span className="font-mono" /> }}
          />
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor="custom-skill-name" className="text-sm font-medium">
            {t("extensions.skills.editor.nameLabel")}
          </label>
          <Input
            id="custom-skill-name"
            placeholder="weekly-report"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={editing || saveMut.isPending}
            aria-invalid={nameError !== null}
            className="font-mono"
          />
          {nameError ? (
            <p className="text-xs text-destructive">{nameError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("extensions.skills.editor.nameHint")}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="custom-skill-description" className="text-sm font-medium">
            {t("extensions.skills.editor.descriptionLabel")}
          </label>
          <Textarea
            id="custom-skill-description"
            rows={2}
            maxLength={1024}
            placeholder={t("extensions.skills.editor.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={saveMut.isPending}
            className="resize-none"
          />
          <p className="text-xs text-muted-foreground">
            {t("extensions.skills.editor.descriptionHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t("extensions.skills.editor.instructionsLabel")}</span>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "write" | "preview")}>
              <TabsList>
                <TabsTrigger value="write">{t("extensions.skills.editor.write")}</TabsTrigger>
                <TabsTrigger value="preview">{t("extensions.skills.editor.preview")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {tab === "write" ? (
            <Textarea
              aria-label={t("extensions.skills.editor.instructionsAria")}
              rows={14}
              placeholder={t("extensions.skills.editor.bodyPlaceholder")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={saveMut.isPending}
              className="min-h-64 font-mono text-xs leading-relaxed"
            />
          ) : (
            <div className="min-h-64 rounded-lg border bg-card px-4 py-3">
              {body.trim() ? (
                <Markdown>{body}</Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">{t("extensions.skills.editor.nothingToPreview")}</p>
              )}
            </div>
          )}
          {body.length > BODY_MAX && (
            <p className="text-xs text-destructive">
              {t("extensions.skills.editor.tooLong", {
                length: body.length.toLocaleString(currentLocale()),
                max: BODY_MAX.toLocaleString(currentLocale()),
              })}
            </p>
          )}
        </div>

        {saveMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {saveMut.error instanceof Error ? saveMut.error.message : t("extensions.skills.editor.saveFailed")}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4 */}
      <DialogFooter className="mx-0 mb-0 px-5 py-3">
        <Button variant="ghost" onClick={onClose} disabled={saveMut.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          onClick={() => saveMut.mutate()}
          disabled={!canSave || saveMut.isPending}
        >
          {saveMut.isPending && <Loader2 className="animate-spin" />}
          {editing ? t("common.save") : t("extensions.skills.editor.create")}
        </Button>
      </DialogFooter>
    </>
  );
}
