/**
 * 已启用模型的下拉（按连接分组）：设置里的账号默认模型、模式编辑器的默认模型共用。
 * 当前值不在已启用模型里（停用 / 连接已删）时仍显示出来，并标「不可用」。
 */
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelOption } from '../../../../../shared/llm';
import { groupByConnection, modelIdOfRef } from '../model-options';

/** base-ui Select 的值是字符串：空串代表「不选」（跟随会话 / 未设置） */
const NONE = '';

export function ModelSelect({
  value,
  onChange,
  options,
  noneLabel,
  ariaLabel,
  disabled,
  className,
}: {
  value: string | null;
  onChange: (ref: string | null) => void;
  options: readonly ModelOption[];
  /** 「不选」一项的文案；不给就没有这一项 */
  noneLabel?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const known = value !== null && options.some((o) => o.ref === value);
  const unavailableLabel = value && !known ? `${modelIdOfRef(value)} · ${t('chat.modelSwitcher.unavailable')}` : null;
  const items: Record<string, string> = {
    ...(noneLabel !== undefined ? { [NONE]: noneLabel } : {}),
    ...(value && unavailableLabel ? { [value]: unavailableLabel } : {}),
    ...Object.fromEntries(options.map((o) => [o.ref, o.modelId])),
  };
  return (
    <Select
      items={items}
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(v) => {
        if (typeof v === 'string') onChange(v === NONE ? null : v);
      }}
    >
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {noneLabel !== undefined && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {value && unavailableLabel && (
          <SelectItem value={value} disabled>
            <span className="text-destructive">{unavailableLabel}</span>
          </SelectItem>
        )}
        {groupByConnection(options).map((g) => (
          <SelectGroup key={g.connectionId}>
            <SelectLabel>{g.connectionName}</SelectLabel>
            {g.models.map((m) => (
              <SelectItem key={m.ref} value={m.ref}>
                <span className="font-mono">{m.modelId}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
