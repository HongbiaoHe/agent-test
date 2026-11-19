import type { ProviderPreset } from '@agent-test/agent-core/providers/presets';
import { useTranslation } from 'react-i18next';
import { translatedPresetKey } from '../model-options';

/** 预设的显示名：中文名的几个按界面语言翻译，其余是品牌名原样显示 */
export function usePresetName(): (preset: Pick<ProviderPreset, 'id' | 'name'>) => string {
  const { t } = useTranslation();
  return (preset) => {
    const key = translatedPresetKey(preset.id);
    return key ? t(`settings.models.presetNames.${key}`) : preset.name;
  };
}
