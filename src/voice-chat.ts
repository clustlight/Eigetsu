import { sharedAudioCodecOptions } from './screen-share-audio.ts';
import type { Consumer, CreateSendTransport, Producer, Transport } from './types.ts';

export function voiceCaptureOptions(): MediaStreamConstraints {
  return {
    video: false,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48_000 },
    },
  };
}

export interface VoiceStream {
  id: string;
  peerId: string;
  name: string;
  local: boolean;
  track: MediaStreamTrack;
  muted: boolean;
  volume: number;
  producer?: Producer;
  consumer?: Consumer;
  transport: Transport;
  capture?: MediaStream;
}

export interface VoiceState {
  enabled: boolean;
  starting: boolean;
  streams: VoiceStream[];
}

interface VoiceSessionOptions {
  peerId: string;
  name: string;
  clientId: string;
  createSendTransport: CreateSendTransport;
  closeProducer(id: string): void;
  onChange(state: VoiceState): void;
  capture?: (options: MediaStreamConstraints) => Promise<MediaStream>;
}

function ended(track: MediaStreamTrack) {
  return track.readyState === 'ended';
}

/** Each microphone owns one audio producer and its own routed transport. */
export class VoiceChatSession {
  private streams = new Map<string, VoiceStream>();
  private enabled = false;
  private starting = false;
  private closed = false;
  private generation = 0;
  private pendingCaptures = new Set<MediaStream>();
  private pendingTransports = new Set<Transport>();

  private options: VoiceSessionOptions;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
  }

  private update() {
    this.options.onChange({ enabled: this.enabled, starting: this.starting, streams: [...this.streams.values()] });
  }

  setEnabled(enabled: boolean) {
    if (this.closed) return;
    this.enabled = enabled;
    if (!enabled) {
      ++this.generation;
      this.starting = false;
      for (const capture of this.pendingCaptures) capture.getTracks().forEach((track) => track.stop());
      this.pendingCaptures.clear();
      for (const transport of this.pendingTransports) transport.close();
      this.pendingTransports.clear();
      for (const id of [...this.streams.keys()]) this.remove(id);
    }
    this.update();
  }

  has(id: string) {
    return this.streams.has(id);
  }

  async start() {
    if (this.closed || !this.enabled || this.starting || [...this.streams.values()].some((stream) => stream.local))
      return;
    const generation = ++this.generation;
    this.starting = true;
    this.update();
    let capture: MediaStream | undefined;
    let transport: Transport | undefined;
    let producer: Producer | undefined;
    const active = () => !this.closed && this.enabled && generation === this.generation;
    try {
      capture = await (this.options.capture ?? ((options) => navigator.mediaDevices.getUserMedia(options)))(
        voiceCaptureOptions(),
      );
      if (!active()) return;
      this.pendingCaptures.add(capture);
      const track = capture.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('マイク音声を取得できません');
      track.contentHint = 'music';
      transport = await this.options.createSendTransport();
      if (!active()) return;
      this.pendingTransports.add(transport);
      producer = await transport.produce({
        track,
        appData: { voiceChat: true, label: 'VC', clientId: this.options.clientId },
        codecOptions: sharedAudioCodecOptions(),
      });
      if (!active() || ended(track) || producer.closed) return;
      const id = producer.id;
      this.streams.set(id, {
        id,
        peerId: this.options.peerId,
        name: this.options.name,
        local: true,
        track,
        muted: false,
        volume: 1,
        producer,
        transport,
        capture,
      });
      producer.on('trackended', () => this.remove(id));
      producer.on('transportclose', () => this.remove(id));
      transport.on('connectionstatechange', (state) => {
        if (state === 'failed' || state === 'closed') this.remove(id);
      });
      this.pendingCaptures.delete(capture);
      this.pendingTransports.delete(transport);
      capture = undefined;
      transport = undefined;
      producer = undefined;
    } catch (error) {
      if (active()) throw error;
    } finally {
      if (producer) {
        this.options.closeProducer(producer.id);
        producer.close();
      }
      transport?.close();
      capture?.getTracks().forEach((track) => track.stop());
      if (transport) this.pendingTransports.delete(transport);
      if (capture) this.pendingCaptures.delete(capture);
      if (generation === this.generation) this.starting = false;
      this.update();
    }
  }

  addRemote(consumer: Consumer, transport: Transport, peerId: string, name: string) {
    if (this.closed || !this.enabled || this.streams.has(consumer.producerId)) {
      consumer.close();
      transport.close();
      return;
    }
    const id = consumer.producerId;
    this.streams.set(id, {
      id,
      peerId,
      name,
      local: false,
      track: consumer.track,
      muted: false,
      volume: 1,
      consumer,
      transport,
    });
    consumer.on('transportclose', () => this.remove(id));
    this.update();
  }

  remove(id: string) {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    if (stream.producer) {
      this.options.closeProducer(id);
      stream.producer.close();
    }
    stream.consumer?.close();
    stream.transport.close();
    stream.capture?.getTracks().forEach((track) => track.stop());
    stream.track.stop();
    this.update();
  }

  removePeer(peerId: string) {
    for (const stream of this.streams.values()) if (stream.peerId === peerId) this.remove(stream.id);
  }

  toggleMute(id: string) {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.muted = !stream.muted;
    if (stream.local) stream.track.enabled = !stream.muted;
    this.update();
  }

  setVolume(id: string, volume: number) {
    const stream = this.streams.get(id);
    if (!stream || !Number.isFinite(volume)) return;
    stream.volume = Math.max(0, Math.min(1, volume));
    this.update();
  }

  close() {
    this.setEnabled(false);
    this.closed = true;
  }
}
