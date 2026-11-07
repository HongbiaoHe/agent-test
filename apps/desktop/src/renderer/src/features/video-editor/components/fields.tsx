/** 检查器的字段原语：数字输入（可带滑块）、文本输入；输入中保留草稿，合法时才提交，失焦后回显规范值 */
import { type ReactNode, useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export function NumberField({
  label,
  value,
  min,
  max,
  step = 0.1,
  slider = false,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 数字输入下方再加一个滑块 */
  slider?: boolean;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        className="h-8 font-mono tabular-nums"
        min={min}
        max={max}
        step={step}
        value={draft ?? fmt(value)}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const n = Number(text);
          if (text.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
      {slider && (
        <Slider
          aria-label={label}
          min={min}
          max={Math.max(max, min + step)}
          step={step}
          value={Math.min(Math.max(value, min), max)}
          onValueChange={(v) => onChange(v)}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Field>
  );
}

/** 文本字段：空白不提交（schema 要求非空），失焦后回显已提交的值 */
export function TextField({
  label,
  value,
  multiline = false,
  onChange,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const props = {
    id,
    value: draft ?? value,
    onChange: (e: { target: { value: string } }) => {
      const text = e.target.value;
      setDraft(text);
      if (text.trim() !== '') onChange(text);
    },
    onBlur: () => setDraft(null),
  };
  return (
    <Field label={label} htmlFor={id}>
      {multiline ? <Textarea rows={3} className="min-h-0 resize-none" {...props} /> : <Input className="h-8" {...props} />}
    </Field>
  );
}
