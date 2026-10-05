import type { QualityPreset } from './quality-presets.ts';
import type { AudioGain, CreateSendTransport, ShareAppData, Transport } from './types.ts';

interface ScreenCaptureOptions {
  systemAudio: 'include';
  video: {
    width: { ideal: number; max?: number };
    height: { ideal: number; max?: number };
    frameRate: { ideal: number; max: number };
  };
  audio: {
    echoCancellation: false;
    noiseSuppression: false;
    autoGainControl: false;
    channelCount: { ideal: number };
    sampleRate: { ideal: number };
    suppressLocalAudioPlayback: false;
  };
}

export function screenShareCaptureOptions(preset: QualityPreset): ScreenCaptureOptions {
  return {
    video: {
      // Let the browser capture the display at its native size. The sender
      // applies the preset's downscale after capture; max constraints here can
      // cause some capture implementations to return a much smaller track.
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48_000 },
      suppressLocalAudioPlayback: false,
    },
    systemAudio: 'include',
  };
}

export function sharedAudioCodecOptions() {
  return {
    opusStereo: true,
    opusMaxAverageBitrate: 256_000,
    opusMaxPlaybackRate: 48_000,
    opusDtx: false,
    opusFec: true,
  };
}

export async function produceScreenShareAudio(
  createSendTransport: CreateSendTransport,
  track: MediaStreamTrack,
  appData: ShareAppData,
) {
  let context: AudioContext | undefined;
  let transport: Transport | undefined;
  let outputTrack: MediaStreamTrack | undefined;
  try {
    track.contentHint = 'music';
    try {
      context = new AudioContext({ sampleRate: 48_000 });
    } catch {
      context = new AudioContext();
    }
    await context.resume();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    destination.channelCountMode = 'explicit';
    // Only a user-controlled gain: preserve the source's dynamics and stereo.
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
    outputTrack = destination.stream.getAudioTracks()[0];
    // Web Audio creates a new track, so the capture track's hint is not inherited.
    outputTrack.contentHint = 'music';
    transport = await createSendTransport();
    const producer = await transport.produce({
      track: outputTrack,
      appData,
      codecOptions: sharedAudioCodecOptions(),
    });
    return { producer, transport, audioGain: { gain: gain.gain, context } };
  } catch (error) {
    transport?.close();
    outputTrack?.stop();
    if (context) await context.close();
    throw error;
  }
}

export function setSharedAudioGain(audioGain: AudioGain, volume: number, muted = false) {
  const level = Math.max(0, Math.min(1, Number(volume)));
  if (!Number.isFinite(level)) return;
  audioGain.gain.setTargetAtTime(muted ? 0 : level, audioGain.context.currentTime, 0.015);
}
