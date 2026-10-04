// Browser implementations expose different subsets of WebRTC diagnostics.
export interface MediaStatsSample {
  id: string;
  timestamp: number;
  type?: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mediaSourceId?: string;
  remoteId?: string;
  transportId?: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  mimeType?: string;
  sdpFmtpLine?: string;
  protocol?: string;
  currentRoundTripTime?: number;
  availableOutgoingBitrate?: number;
  bytesSent?: number;
  bytesReceived?: number;
  framesEncoded?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  totalEncodeTime?: number;
  totalDecodeTime?: number;
  packetsSent?: number;
  packetsReceived?: number;
  packetsLost?: number;
  totalPacketSendDelay?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  freezeCount?: number;
  fractionLost?: number;
  encoderImplementation?: string;
  decoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  powerEfficientDecoder?: boolean;
  qualityLimitationReason?: string;
  targetBitrate?: number;
}
export interface MediaStatsReport {
  values(): IterableIterator<MediaStatsSample>;
  get(id: string | undefined): MediaStatsSample | undefined;
}
export interface ScreenStats {
  sample: MediaStatsSample;
  bitrateMbps?: number | null;
  width?: number;
  height?: number;
  fps?: number | null;
  sourceFps?: number;
  receivedFps?: number | null;
  playbackFps?: number | null;
  playbackDropped?: number | null;
  encodeMs?: number | null;
  decodeMs?: number | null;
  encoder?: string;
  decoder?: string;
  powerEfficient?: boolean;
  sendQueueMs?: number | null;
  remoteLossPercent?: number | null;
  lossPercent?: number | null;
  bufferMs?: number | null;
  dropped?: number | null;
  freezes?: number | null;
  limitation?: string;
  codec?: string;
  codecProfile?: string;
  targetBitrateMbps?: number | null;
  protocol?: string;
  rttMs?: number | null;
  availableOutgoingMbps?: number | null;
}
export interface PlaybackSample {
  id: HTMLVideoElement;
  timestamp: number;
  total: number;
  dropped: number;
}
