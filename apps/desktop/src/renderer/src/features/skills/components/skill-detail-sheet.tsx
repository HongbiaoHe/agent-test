
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { getSkillDetail } from "@/lib/api";

import { Markdown } from "@/features/chat/components/markdown";

/** 详情查询 key（与列表 mutation 的失效联动）。 */
export const skillDetailKey = (name: string) => ["skill-detail", name] as const;

/** 技能详情侧拉：SKILL.md 渲染 + 文件清单 + 元信息。name 为 null 时关闭。 */
export function SkillDetailSheet({
  name,
  onClose,
}: {
  name: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: skillDetailKey(name ?? ""),
    queryFn: () => getSkillDetail(name!),
    enabled: name !== null,
  });
  const d = query.data;

  return (
    <Sheet open={name !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Override default w-3/4 / sm:max-w-sm with wider sheet.
          Using data-[side=right] modifier so the classes win over the base variants. */}
      <SheetContent
        side="right"
        className="flex flex-col data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="truncate">{name}</span>
            {d && (
              <>
                <Badge variant={d.kind === "builtin" ? "secondary" : "outline"}>
                  {t(`extensions.skills.kinds.${d.kind}`)}
                </Badge>
                {!d.enabled && <Badge variant="destructive">{t("extensions.skills.detail.disabled")}</Badge>}
              </>
            )}
          </SheetTitle>
          {d && (
            <SheetDescription className="truncate text-left">
              {d.kind === "builtin"
                ? t("extensions.skills.detail.builtin")
                : d.kind === "custom"
                  ? t("extensions.skills.detail.custom")
                  : d.source}
            </SheetDescription>
          )}
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-4">
          {query.isLoading && (
            <div className="space-y-3 py-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          )}
          {query.isError && (
            <p className="py-4 text-sm text-destructive" role="alert">
              {query.error instanceof Error
                ? query.error.message
                : t("extensions.skills.detail.loadFailed")}
            </p>
          )}
          {d && (
            <div className="space-y-4 pb-6">
              {d.skillMd ? (
                <Markdown>{d.skillMd}</Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("extensions.skills.detail.noSkillMd")}
                </p>
              )}
              <Separator />
              <section className="space-y-2">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t("extensions.skills.detail.files", { total: d.files.length })}
                </h3>
                {d.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("extensions.skills.detail.noFiles")}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {d.files.map((f) => (
                      <li
                        key={f}
                        className="flex items-center gap-2 font-mono text-xs text-foreground/80"
                      >
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{f}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
