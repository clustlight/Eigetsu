import type { Device, types as Media } from 'mediasoup-client';
import type { Socket } from 'socket.io-client';
import type { createCompatibleVideoSender } from './compatible-video.ts';

export interface ShareAppData extends Record<string, unknown> {
  voiceChat?: boolean;
  label?: string;
  profile?: string;
  clientId?: string;
  captureSurface?: string;
  compatibilitySupported?: boolean;
  compatibilityFor?: string;
  videoProducerId?: string;
}

export type Producer = Media.Producer<ShareAppData>;
export type Consumer = Media.Consumer<ShareAppData>;
export type Transport = Media.Transport<ShareAppData>;
export type CreateSendTransport = (producerId?: string) => Promise<Transport>;
export interface AudioGain {
  gain: { setTargetAtTime(value: number, startTime: number, timeConstant: number): unknown };
  context: AudioContext;
}

interface ShareBase {
  producerId: string;
  peerId: string;
  peerName: string;
  label?: string;
  profile?: string;
  stream: MediaStream;
  consumers: Consumer[];
  audioVolume: number;
  audioMuted: boolean;
  ownSource?: boolean;
  previewEnabled?: boolean;
  captureSurface?: string;
  videoElement?: HTMLVideoElement | null;
  requestKeyFrame?: () => Promise<void>;
  producer?: Producer;
  videoConsumer?: Consumer;
  videoTransport?: Transport;
  recvTransport?: Transport;
  audioProducer?: Producer;
  audioConsumer?: Consumer;
  audioTransport?: Transport;
  audioProducerId?: string | null;
  audioTrack?: MediaStreamTrack | null;
  audioGain?: AudioGain;
  maxBitrate?: number;
  compatibilityActive?: boolean;
  videoPaused?: boolean;
  videoPauseTarget?: boolean;
  videoPauseSyncing?: boolean;
}
export interface LocalShare extends ShareBase {
  local: true;
  producer: Producer;
  videoTransport: Transport;
  maxBitrate: number;
}
export interface RemoteShare extends ShareBase {
  local: false;
  videoConsumer: Consumer;
  recvTransport: Transport;
}
export type Share = LocalShare | RemoteShare;
export interface Room {
  voiceChatEnabled: boolean;
  id: string;
  name: string;
  people: number;
}
export interface ListedRoom {
  id: string;
  name: string;
  peopleCount: number;
  remainingMs: number | null;
  expiresAt: number | null;
}
export interface PeerShare {
  id: string;
  kind: Media.MediaKind;
  label?: string;
  profile?: string;
  appData: ShareAppData;
}
export interface Peer {
  id: string;
  name: string;
  shares: PeerShare[];
}
export interface ProducerAnnouncement {
  producerId: string;
  peerId: string;
  peerName: string;
  kind: Media.MediaKind;
  label?: string;
  profile?: string;
  appData: ShareAppData;
}
export interface Connection {
  voiceChat?: import('./voice-chat.ts').VoiceChatSession;
  transports: Set<Transport>;
  socket: Socket;
  device: Device;
  createSendTransport: CreateSendTransport;
  displayName: string;
  peerIds: Set<string>;
  compatibleSender?: ReturnType<typeof createCompatibleVideoSender>;
}

type RoomResponse = {
  roomId: string;
  roomName: string;
  voiceChatEnabled: boolean;
  rtpCapabilities: Media.RtpCapabilities;
  peers: Peer[];
};
export interface RpcResponses {
  'room:create': RoomResponse;
  'room:join': RoomResponse;
  'room:sync': { peers: Peer[]; voiceChatEnabled: boolean };
  'room:voice': { voiceChatEnabled: boolean };
  'transport:create': Media.TransportOptions<ShareAppData>;
  'transport:connect': object;
  produce: { id: string };
  consume: Media.ConsumerOptions<ShareAppData>;
  'consumer:pause': object;
  'consumer:resume': object;
  'consumer:keyframe': object;
}
export interface RpcRequests {
  'room:voice': { enabled: boolean };
  'room:create': { name: string };
  'room:join': { roomId: string; name: string };
  'room:sync': Record<string, never>;
  'transport:create': { direction: 'send' | 'recv'; producerId?: string; newShare?: boolean };
  'transport:connect': { transportId: string; dtlsParameters: Media.DtlsParameters };
  produce: { transportId: string; kind: Media.MediaKind; rtpParameters: Media.RtpParameters; appData: ShareAppData };
  consume: { transportId: string; producerId: string; rtpCapabilities: Media.RtpCapabilities };
  'consumer:pause': { consumerId: string };
  'consumer:resume': { consumerId: string };
  'consumer:keyframe': { consumerId: string };
}
