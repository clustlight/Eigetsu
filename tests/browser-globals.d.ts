export {};

declare global {
  interface Window {
    runAudioCheck: typeof import('./audio-browser-page.ts').runAudioCheck;
    runBitrateCheck: typeof import('./bitrate-browser-page.ts').runBitrateCheck;
    runCompatibilityCheck: typeof import('./compatibility-browser-page.ts').runCompatibilityCheck;
    runClusterCheck: typeof import('./cluster-browser-page.ts').runClusterCheck;
    clusterRecovery: { frames(): Promise<number>; cleanup(): void };
  }
}
