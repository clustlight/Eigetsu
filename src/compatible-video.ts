import type { types as Media } from 'mediasoup-client';
import type { CreateSendTransport, Producer, Transport } from './types.ts';

interface CompatibleSenderOptions {
  getProducer(id: string): Producer | undefined;
  createTransport: CreateSendTransport;
  capabilities: Media.RtpCapabilities;
  onStatus?(id: string, active: boolean): void;
}
interface CompatibleEntry {
  source: Producer;
  track: MediaStreamTrack;
  closed: boolean;
  onSourceClose(): void;
  producer?: Producer;
  transport?: Transport;
  promise?: Promise<string>;
}

import { screenShareEncodingOptions, preferScreenShareResolution } from './screen-share-quality.ts';
import { qualityPresets } from './quality-presets.ts';

const compatiblePreset = qualityPresets.find((preset) => preset.id === '1080p60')!;

// A second, bounded stream is created only for viewers that cannot receive the
// primary profile. Never rewrite Main/High SDP to claim it is Baseline video.
export function createCompatibleVideoSender({
  getProducer,
  createTransport,
  capabilities,
  onStatus = () => {},
}: CompatibleSenderOptions) {
  const entries = new Map<string, CompatibleEntry>();
  let disposed = false;
  const stop = (producerId: string) => {
    const entry = entries.get(producerId);
    if (!entry) return;
    entries.delete(producerId);
    entry.closed = true;
    entry.source.observer.removeListener('close', entry.onSourceClose);
    entry.producer?.close();
    entry.transport?.close();
    entry.track.stop();
    onStatus(producerId, false);
  };
  const ensure = async (producerId: string) => {
    // The SFU announces a new producer before produce() resolves on its owner.
    let source: Producer | undefined;
    for (let attempt = 0; attempt < 40 && !disposed; attempt++) {
      source = getProducer(producerId);
      if (source) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (disposed || !source || source.closed || source.track?.readyState !== 'live')
      throw new Error('共有が終了しています');
    if (entries.has(producerId)) return entries.get(producerId)!.promise!;
    const codec = capabilities.codecs?.find(
      (codec) =>
        codec.mimeType.toLowerCase() === 'video/h264' &&
        Number(codec.parameters?.['packetization-mode']) === 1 &&
        /^42e0/i.test(String(codec.parameters?.['profile-level-id'] || '')),
    );
    if (!codec) throw new Error('送信側が互換用H.264に対応していません');
    const track = source.track.clone();
    const entry: CompatibleEntry = { source, track, closed: false, onSourceClose: () => stop(producerId) };
    entries.set(producerId, entry);
    source.observer.once('close', entry.onSourceClose);
    entry.promise = (async () => {
      try {
        entry.transport = await createTransport(producerId);
        if (entry.closed) throw new Error('共有が終了しています');
        track.contentHint = 'motion';
        const options = screenShareEncodingOptions(compatiblePreset, track.getSettings());
        entry.producer = await entry.transport.produce({
          track,
          codec,
          ...options,
          appData: {
            ...source.appData,
            compatibilitySupported: false,
            compatibilityFor: producerId,
            profile: '互換 · 1080p / 60 FPS',
          },
        });
        if (entry.closed || source.closed) throw new Error('共有が終了しています');
        await preferScreenShareResolution(entry.producer);
        onStatus(producerId, true);
        return entry.producer.id;
      } catch (error) {
        // A transport can finish being created after stop() has run.
        entry.producer?.close();
        entry.transport?.close();
        stop(producerId);
        throw error;
      }
    })();
    return entry.promise;
  };
  return {
    async request(
      { producerId }: { producerId: string },
      reply: (result: { ok: true; producerId: string } | { ok: false; error: string }) => void,
    ) {
      try {
        reply({ ok: true, producerId: await ensure(producerId) });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    stop,
    close() {
      disposed = true;
      for (const id of [...entries.keys()]) stop(id);
    },
  };
}
