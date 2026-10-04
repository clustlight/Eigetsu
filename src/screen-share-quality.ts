import type { types as Media } from 'mediasoup-client';
import type { QualityPreset } from './quality-presets.ts';
import type { CreateSendTransport, Producer, ShareAppData } from './types.ts';
import type { MediaStatsReport, MediaStatsSample, ScreenStats } from './media-stats.ts';

// RTP encodings use bps; the libwebrtc SDP codec hints use kbps.
export function screenShareEncodingOptions(preset: QualityPreset, source: MediaTrackSettings = {}) {
  const maxKbps = Math.round(preset.bitrate / 1000);
  const scaleResolutionDownBy = Math.max(
    1,
    source.width && preset.width ? source.width / preset.width : 1,
    source.height && preset.height ? source.height / preset.height : 1,
  );
  return {
    encodings: [{ maxBitrate: preset.bitrate, maxFramerate: preset.fps, scaleResolutionDownBy }],
    codecOptions: {
      // A forced minimum equal to the ceiling defeats congestion control.
      // Start conservatively, then let WebRTC adapt within the selected budget.
      videoGoogleStartBitrate: Math.min(maxKbps, 3000),
      videoGoogleMaxBitrate: maxKbps,
    },
  };
}

export function selectScreenShareCodec(sendRtpCapabilities: Media.RtpCapabilities) {
  const h264 =
    sendRtpCapabilities?.codecs?.filter(
      (codec) =>
        codec.mimeType?.toLowerCase() === 'video/h264' && Number(codec.parameters?.['packetization-mode']) === 1,
    ) || [];
  // Chromium's accelerated Constrained Baseline encoder is disabled by default
  // on Windows. Prefer negotiated Main/High before the software-compatible CBP.
  // Capability order alone otherwise selects CBP even when GPU encoding exists.
  const codec =
    h264.find((codec) => /^4d00/i.test(String(codec.parameters?.['profile-level-id'] || ''))) ||
    h264.find((codec) => /^6400/i.test(String(codec.parameters?.['profile-level-id'] || ''))) ||
    h264[0];
  if (!codec) throw new Error('このブラウザーとサーバーの組み合わせではH.264の画面共有に対応していません。');
  // Use the negotiated capability, including its payload type and profile/level.
  return codec;
}

export async function produceScreenShareVideo(
  createSendTransport: CreateSendTransport,
  track: MediaStreamTrack,
  preset: QualityPreset,
  appData: ShareAppData,
  sendRtpCapabilities: Media.RtpCapabilities,
) {
  const codec = selectScreenShareCodec(sendRtpCapabilities);
  // Audio and other screens must not renegotiate this PeerConnection's bitrate hints.
  const transport = await createSendTransport();
  try {
    track.contentHint = 'motion';
    const producer = await transport.produce({
      track,
      appData,
      codec,
      ...screenShareEncodingOptions(preset, track.getSettings?.()),
    });
    await preferScreenShareResolution(producer);
    return { producer, transport };
  } catch (error) {
    transport.close();
    throw error;
  }
}

export async function preferScreenShareResolution(producer: Producer) {
  const sender = producer.rtpSender;
  if (!sender) {
    if (producer.track) producer.track.contentHint = 'detail';
    return false;
  }
  try {
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-resolution';
    // Preserve the negotiated encodings and transactionId from getParameters().
    await sender.setParameters(parameters);
    return true;
  } catch (error) {
    // Without an explicit preference, "motion" permits resolution reductions.
    // Use the resolution-oriented hint if the sender API is unsupported.
    if (producer.track) producer.track.contentHint = 'detail';
    console.warn('[screen-share] unable to set resolution preference', error);
    return false;
  }
}

export function readScreenShareStats(report: MediaStatsReport, previous?: MediaStatsSample): ScreenStats | null {
  const outbound = [...report.values()].find((stat) => {
    const codec = report.get(stat.codecId);
    return (
      stat.type === 'outbound-rtp' &&
      (stat.kind || stat.mediaType) === 'video' &&
      !/\/(rtx|red|ulpfec|flexfec-03)$/i.test(codec?.mimeType || '')
    );
  });
  if (!outbound) return null;
  const elapsed = outbound.timestamp - (previous?.timestamp ?? outbound.timestamp);
  const bytes = (outbound.bytesSent ?? NaN) - (previous?.bytesSent ?? outbound.bytesSent ?? NaN);
  const frames = (outbound.framesEncoded ?? NaN) - (previous?.framesEncoded ?? outbound.framesEncoded ?? NaN);
  const comparable = previous?.id === outbound.id && elapsed > 0 && bytes >= 0;
  const source = report.get(outbound.mediaSourceId);
  const encodeTime = (outbound.totalEncodeTime ?? NaN) - (previous?.totalEncodeTime ?? NaN);
  const packets = (outbound.packetsSent ?? NaN) - (previous?.packetsSent ?? NaN);
  const queueTime = (outbound.totalPacketSendDelay ?? NaN) - (previous?.totalPacketSendDelay ?? NaN);
  const remote = report.get(outbound.remoteId);
  const codec = report.get(outbound.codecId);
  return {
    sample: outbound,
    bitrateMbps: comparable ? (bytes * 8) / elapsed / 1000 : null,
    width: outbound.frameWidth,
    height: outbound.frameHeight,
    fps: outbound.framesPerSecond ?? (comparable && frames >= 0 ? (frames * 1000) / elapsed : null),
    sourceFps: source?.framesPerSecond,
    encodeMs: comparable && frames > 0 && encodeTime >= 0 ? (encodeTime * 1000) / frames : null,
    encoder: outbound.encoderImplementation,
    powerEfficient: outbound.powerEfficientEncoder,
    sendQueueMs: comparable && packets > 0 && queueTime >= 0 ? (queueTime * 1000) / packets : null,
    remoteLossPercent: remote?.fractionLost == null ? null : remote.fractionLost * 100,
    limitation: outbound.qualityLimitationReason,
    codec: codec?.mimeType,
    codecProfile: /(?:^|;)\s*profile-level-id=([a-f\d]{6})(?:;|$)/i.exec(codec?.sdpFmtpLine || '')?.[1],
    targetBitrateMbps: outbound.targetBitrate == null ? null : outbound.targetBitrate / 1_000_000,
  };
}
