import type { SettingItem } from './types';

export const inlayImageSettingsItems: SettingItem[] = [
    { id: 'inlay.lossless', type: 'check', labelKey: 'inlayImageLossless', bindKey: 'inlayImageLossless', helpKey: 'inlayImageLossless', classes: 'mt-4' },
    { id: 'inlay.priority', type: 'check', labelKey: 'inlayImagePriority', bindKey: 'inlayImagePriority', helpKey: 'inlayImagePriority', classes: 'mt-4' },
    { id: 'inlay.compress', type: 'custom', componentId: 'InlayCompressButton' },
];
