/** The CDP methods used by the browser checks. JSON enters at the protocol boundary. */
export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}
export interface CdpResults {
  'Runtime.evaluate': {
    result: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  'Target.createTarget': { targetId: string };
  'Target.attachToTarget': { sessionId: string };
  'Target.closeTarget': { success: boolean };
  'Target.getTargets': { targetInfos: TargetInfo[] };
  'Page.enable': object;
  'Page.navigate': { frameId: string };
  'Page.addScriptToEvaluateOnNewDocument': { identifier: string };
  'Page.captureScreenshot': { data: string };
  'Page.getLayoutMetrics': { cssContentSize: { x: number; y: number; width: number; height: number } };
  'Input.dispatchTouchEvent': object;
  'Input.dispatchKeyEvent': object;
  'Emulation.setDeviceMetricsOverride': object;
  'Emulation.clearDeviceMetricsOverride': object;
  'Emulation.setEmulatedMedia': object;
}
export interface CdpResponse {
  id: number;
  error?: { message: string; code: number };
  result: unknown;
}
export interface BrowserHarness {
  command<M extends keyof CdpResults>(
    method: M,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<CdpResults[M]>;
  evaluate<T = unknown>(expression: string, sessionId?: string): Promise<T>;
}
export interface BrowserHarnessWithRoot extends BrowserHarness {
  root: string;
}
