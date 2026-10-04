import type { Consumer } from './types.ts';
import type { MediaStatsReport, MediaStatsSample, PlaybackSample, ScreenStats } from './media-stats.ts';

// Target a small playout buffer for movies/music rather than minimum latency.
// Request the same target for audio and video; the browser manages A/V sync.
export const SCREEN_SHARE_BUFFER_MS = 100;

export function configureScreenShareReceiver(consumer: Pick<Consumer, 'rtpReceiver'>) {
  const receiver = consumer.rtpReceiver;
  if (!receiver || !('jitterBufferTarget' in receiver)) return false;
  try {
    receiver.jitterBufferTarget = SCREEN_SHARE_BUFFER_MS;
    return true;
  } catch (error) {
    console.warn('[screen-share] unable to set receive buffer', error);
    return false;
  }
}

function delta<T extends { id: unknown; timestamp: number }>(sample: T, previous: T | undefined, field: keyof T) {
  if (!previous || sample.id !== previous.id || sample.timestamp <= previous.timestamp) return null;
  const current = sample[field];
  const last = previous[field];
  if (typeof current !== 'number' || typeof last !== 'number' || !Number.isFinite(current) || !Number.isFinite(last))
    return null;
  const value = current - last;
  return value >= 0 ? value : null;
}

export function readScreenConnectionStats(report: MediaStatsReport, media: MediaStatsSample) {
  const transport = report.get(media.transportId);
  const pair = report.get(transport?.selectedCandidatePairId);
  const local = report.get(pair?.localCandidateId);
  const remote = report.get(pair?.remoteCandidateId);
  return {
    // The remote SFU candidate describes the actual connection even when a
    // local relay is used. Never infer the protocol from configured candidates.
    protocol: remote?.protocol || local?.protocol,
    rttMs: pair?.currentRoundTripTime == null ? null : pair.currentRoundTripTime * 1000,
    availableOutgoingMbps: pair?.availableOutgoingBitrate == null ? null : pair.availableOutgoingBitrate / 1_000_000,
  };
}

export function readScreenReceiveStats(report: MediaStatsReport, previous?: MediaStatsSample): ScreenStats | null {
  const inbound = [...report.values()].find((stat) => {
    const codec = report.get(stat.codecId);
    return (
      stat.type === 'inbound-rtp' &&
      (stat.kind || stat.mediaType) === 'video' &&
      codec &&
      !/\/(rtx|red|ulpfec|flexfec-03)$/i.test(codec.mimeType || '')
    );
  });
  if (!inbound) return null;
  const elapsed = inbound.timestamp - (previous?.timestamp ?? NaN);
  const change = (field: keyof MediaStatsSample) => delta(inbound, previous, field);
  const bytes = change('bytesReceived');
  const received = change('framesReceived');
  const decoded = change('framesDecoded');
  const decodeTime = change('totalDecodeTime');
  const lost = change('packetsLost');
  const packets = change('packetsReceived');
  const delay = change('jitterBufferDelay');
  const emitted = change('jitterBufferEmittedCount');
  return {
    sample: inbound,
    codec: report.get(inbound.codecId)?.mimeType,
    width: inbound.frameWidth,
    height: inbound.frameHeight,
    bitrateMbps: bytes == null ? null : (bytes * 8) / elapsed / 1000,
    receivedFps: received == null ? null : (received * 1000) / elapsed,
    fps: decoded == null ? null : (decoded * 1000) / elapsed,
    decodeMs: decodeTime != null && decoded != null && decoded > 0 ? (decodeTime * 1000) / decoded : null,
    dropped: change('framesDropped'),
    lossPercent: lost != null && packets != null && lost + packets > 0 ? (lost * 100) / (lost + packets) : null,
    bufferMs: delay != null && emitted != null && emitted > 0 ? (delay * 1000) / emitted : null,
    freezes: change('freezeCount'),
    decoder: inbound.decoderImplementation,
    powerEfficient: inbound.powerEfficientDecoder,
  };
}

// Count video element playback separately from decoding. A decoded frame can
// still be dropped before presentation. Reset when the element is remounted.
export function readVideoPlaybackStats(sample: PlaybackSample, previous?: PlaybackSample) {
  const elapsed = sample.timestamp - (previous?.timestamp ?? NaN);
  const total = delta(sample, previous, 'total');
  const dropped = delta(sample, previous, 'dropped');
  return {
    sample,
    fps: total != null && dropped != null && total >= dropped ? ((total - dropped) * 1000) / elapsed : null,
    dropped,
  };
}
