import type { types as Media } from 'mediasoup';
import type { ShareRouting } from './share-routing.ts';

export interface ShareAppData extends Record<string, unknown> {
  voiceChat?: boolean;
  ownerId?: string;
  label?: string;
  profile?: string;
  clientId?: string;
  captureSurface?: string;
  compatibilitySupported?: boolean;
  compatibilityFor?: string;
  videoProducerId?: string;
}
export type Producer = Media.Producer<ShareAppData>;
export interface Peer {
  id: string;
  name: string;
  producers: Map<string, Producer>;
}
export interface CompatibilityStream {
  producer: Producer;
  consumers: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  scheduleClose(): void;
}
export interface Room {
  id: string;
  name: string;
  router: Media.Router;
  routing: ShareRouting;
  peers: Map<string, Peer>;
  compatibilityRequests: Map<string, Promise<Producer>>;
  compatibilityStreams: Map<string, CompatibilityStream>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  emptySince: number | null;
}
type Ack = (value: { ok: boolean; error?: string; [key: string]: unknown }) => void;
export interface ClientEvents {
  'room:voice': (data: { enabled: boolean }, reply: Ack) => void;
  'connection:ping': (reply: (value: { ready: boolean }) => void) => void;
  'room:create': (data: { name: string }, reply: Ack) => void;
  'room:join': (data: { roomId: string; name: string }, reply: Ack) => void;
  'room:sync': (reply: Ack) => void;
  'transport:create': (
    data: { direction: 'send' | 'recv'; producerId?: string; newShare?: boolean },
    reply: Ack,
  ) => void;
  'transport:connect': (data: { transportId: string; dtlsParameters: Media.DtlsParameters }, reply: Ack) => void;
  'transport:close': (data: { transportId: string }) => void;
  produce: (
    data: { transportId: string; kind: Media.MediaKind; rtpParameters: Media.RtpParameters; appData: ShareAppData },
    reply: Ack,
  ) => void;
  consume: (
    data: { transportId: string; producerId: string; rtpCapabilities: Media.RtpCapabilities },
    reply: Ack,
  ) => void;
  'consumer:resume': (data: { consumerId: string }, reply: Ack) => void;
  'consumer:keyframe': (data: { consumerId: string }, reply: Ack) => void;
  'consumer:pause': (data: { consumerId: string }, reply: Ack) => void;
  'consumer:close': (data: { consumerId: string }) => void;
  'producer:close': (data: { producerId: string }) => void;
}

export interface PeerInfo {
  id: string;
  name: string;
  shares: { id: string; kind: Media.MediaKind; profile?: string; label: string; appData: ShareAppData }[];
}
export interface ServerEvents {
  'room:voice': (data: { voiceChatEnabled: boolean }) => void;
  'peer:joined': (peer: PeerInfo) => void;
  'peer:left': (data: { peerId: string }) => void;
  'producer:new': (data: {
    producerId: string;
    peerId: string;
    peerName: string;
    kind: Media.MediaKind;
    profile?: string;
    label: string;
    appData: ShareAppData;
  }) => void;
  'producer:closed': (data: { producerId: string; peerId?: string }) => void;
  'producer:compatibility-stop': (data: { producerId: string }) => void;
  'producer:compatibility-request': (
    data: { producerId: string },
    reply: (result: { ok: true; producerId: string } | { ok: false; error: string }) => void,
  ) => void;
}
