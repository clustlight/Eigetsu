export interface QualityPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export const qualityPresets: QualityPreset[] = [
  { id: '4k60', label: '4K · 60 FPS', width: 3840, height: 2160, fps: 60, bitrate: 45_000_000 },
  { id: '4k30', label: '4K · 30 FPS', width: 3840, height: 2160, fps: 30, bitrate: 24_000_000 },
  { id: '1440p60', label: '1440p · 60 FPS', width: 2560, height: 1440, fps: 60, bitrate: 18_000_000 },
  { id: '1440p30', label: '1440p · 30 FPS', width: 2560, height: 1440, fps: 30, bitrate: 12_000_000 },
  { id: '1080p60', label: '1080p · 60 FPS', width: 1920, height: 1080, fps: 60, bitrate: 9_000_000 },
  { id: '1080p30', label: '1080p · 30 FPS', width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  { id: '720p60', label: '720p · 60 FPS', width: 1280, height: 720, fps: 60, bitrate: 4_500_000 },
  { id: '720p30', label: '720p · 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
];

export const defaultQualityPreset = qualityPresets.find((preset) => preset.id === '1440p60')!;
