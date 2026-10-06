/** Retry a missing initial keyframe; stop after presentation or a bounded wait. */
export function recoverVideoFrame(video: HTMLVideoElement, requestKeyFrame: () => Promise<void>) {
  let attempts = 0;
  let presented = false;
  const frameCallback = video.requestVideoFrameCallback?.(() => {
    presented = true;
  });
  const timer = setInterval(() => {
    const quality = video.getVideoPlaybackQuality?.();
    if (
      presented ||
      (frameCallback === undefined &&
        video.readyState >= 2 &&
        quality &&
        quality.totalVideoFrames > quality.droppedVideoFrames)
    ) {
      clearInterval(timer);
      return;
    }
    void requestKeyFrame().catch(() => {});
    if (++attempts >= 5) clearInterval(timer);
  }, 1200);
  return () => {
    clearInterval(timer);
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
  };
}
