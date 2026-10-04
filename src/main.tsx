import type { types as Media } from 'mediasoup-client';
import type { Socket } from 'socket.io-client';
import type {
  Connection,
  Consumer,
  ListedRoom,
  LocalShare,
  ProducerAnnouncement,
  RemoteShare,
  Room,
  RpcRequests,
  RpcResponses,
  Share,
  ShareAppData,
  Transport,
} from './types.ts';
import type { MediaStatsSample, PlaybackSample, ScreenStats } from './media-stats.ts';
import type { LobbyProps, PopoutProps, RoomViewProps } from './ui-types.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isTrackEnded(track: MediaStreamTrack): boolean {
  return track.readyState === 'ended';
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { produceScreenShareVideo, readScreenShareStats, selectScreenShareCodec } from './screen-share-quality.ts';
import { produceScreenShareAudio, screenShareCaptureOptions, setSharedAudioGain } from './screen-share-audio.ts';
import { qualityPresets as presets, defaultQualityPreset } from './quality-presets.ts';
import { usePlayerControls } from './player-controls.ts';
import { createCompatibleVideoSender } from './compatible-video.ts';
import {
  configureScreenShareReceiver,
  readScreenConnectionStats,
  readScreenReceiveStats,
  readVideoPlaybackStats,
} from './screen-share-receive.ts';
import './style.css';

const params = new URLSearchParams(location.search);
const inviteRoom = params.get('room');
const focusProducer = params.get('focus');
const clientId =
  localStorage.getItem('eigetsu-client-id') ||
  (() => {
    const id = crypto.randomUUID();
    localStorage.setItem('eigetsu-client-id', id);
    return id;
  })();

function Video({
  stream,
  muted = false,
  enabled = true,
  share,
}: {
  stream: MediaStream;
  muted?: boolean;
  enabled?: boolean;
  share: Share;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (share) share.videoElement = video;
    return () => {
      if (share?.videoElement === video) share.videoElement = null;
      if (video) video.srcObject = null;
    };
  }, [share]);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = enabled ? stream : null;
      if (enabled)
        ref.current
          .play()
          .then(() => setPlayBlocked(false))
          .catch(() => setPlayBlocked(true));
      else setPlayBlocked(false);
    }
  }, [stream, enabled]);
  return (
    <>
      <video ref={ref} autoPlay playsInline muted={muted} />
      {playBlocked && (
        <button
          className="video-play-button"
          onClick={(event) => {
            event.stopPropagation();
            ref.current
              ?.play()
              .then(() => setPlayBlocked(false))
              .catch(() => setPlayBlocked(true));
          }}
        >
          再生
        </button>
      )}
    </>
  );
}

function AudioOutput({
  track,
  volume = 1,
  muted = false,
}: {
  track?: MediaStreamTrack | null;
  volume?: number;
  muted?: boolean;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const audio = ref.current;
    if (!audio || !track) return;
    audio.srcObject = new MediaStream([track]);
    audio.muted = muted;
    if (muted) setBlocked(false);
    else
      audio
        .play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    return () => {
      audio.srcObject = null;
    };
  }, [track, muted]);
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);
  return (
    <>
      {track && <audio ref={ref} autoPlay playsInline />}
      {blocked && (
        <button
          className="audio-play-button"
          onClick={(event) => {
            event.stopPropagation();
            ref.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => setBlocked(true));
          }}
        >
          音声を再生
        </button>
      )}
    </>
  );
}

function StreamQuality({ share }: { share: Share }) {
  const [stats, setStats] = useState<ScreenStats | null>(null);
  useEffect(() => {
    const media = share.producer || share.videoConsumer;
    if (!media) return;
    setStats(null);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: MediaStatsSample | undefined;
    let previousPlayback: PlaybackSample | undefined;
    const refresh = async () => {
      try {
        const transport = share.videoTransport || share.recvTransport;
        const [report, connectionReport] = await Promise.all([media.getStats(), transport?.getStats()]);
        const next = share.local ? readScreenShareStats(report, previous) : readScreenReceiveStats(report, previous);
        if (disposed || media.closed) return;
        if (next) {
          previous = next.sample;
          if (connectionReport) Object.assign(next, readScreenConnectionStats(connectionReport, next.sample));
          const video = share.videoElement;
          const playback = video?.srcObject && video.getVideoPlaybackQuality?.();
          if (playback) {
            const measured = readVideoPlaybackStats(
              {
                id: video,
                timestamp: performance.now(),
                total: playback.totalVideoFrames,
                dropped: playback.droppedVideoFrames,
              },
              previousPlayback,
            );
            previousPlayback = measured.sample;
            next.playbackFps = measured.fps;
            next.playbackDropped = measured.dropped;
          } else previousPlayback = undefined;
          setStats(next);
        }
      } catch (error) {
        if (!disposed && !media.closed) console.warn('[screen-share] unable to read media stats', error);
      }
      if (!disposed && !media.closed) timer = setTimeout(refresh, 2000);
    };
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [share]);
  const limitation =
    ({ none: '制限なし', cpu: 'CPU負荷', bandwidth: '回線帯域', other: 'その他' } as Record<string, string>)[
      stats?.limitation || ''
    ] || '不明';
  const captureSurface = share.local
    ? share.stream.getVideoTracks()[0]?.getSettings().displaySurface
    : share.captureSurface;
  const surfaceLabel = (
    { window: 'ウィンドウ', monitor: '画面全体', browser: 'ブラウザータブ' } as Record<string, string>
  )[captureSurface || ''];
  const details = stats
    ? [
        share.local ? `送信上限: ${share.maxBitrate / 1_000_000} Mbps` : null,
        stats.codec ? `コーデック: ${stats.codec}` : null,
        stats.codecProfile ? `H.264プロファイル: ${stats.codecProfile}` : null,
        share.local && share.compatibilityActive ? '互換配信: 1080p / 60 FPS設定（追加エンコード）' : null,
        surfaceLabel ? `取り込み種別: ${surfaceLabel}` : null,
        stats.width && stats.height ? `${share.local ? '実送信' : '実受信'}: ${stats.width} × ${stats.height}` : null,
        stats.sourceFps != null ? `取り込み実測: ${stats.sourceFps.toFixed(1)} FPS` : null,
        stats.receivedFps != null ? `受信: ${stats.receivedFps.toFixed(1)} FPS` : null,
        stats.fps != null ? `${share.local ? '送信' : 'デコード'}: ${stats.fps.toFixed(1)} FPS` : null,
        stats.playbackFps != null
          ? `${share.local ? 'プレビュー' : '再生'}: ${stats.playbackFps.toFixed(1)} FPS`
          : null,
        stats.encodeMs != null ? `エンコード: ${stats.encodeMs.toFixed(1)} ms/フレーム` : null,
        stats.decodeMs != null ? `デコード: ${stats.decodeMs.toFixed(1)} ms/フレーム` : null,
        `${share.local ? 'エンコーダー実装' : 'デコーダー実装'}: ${(share.local ? stats.encoder : stats.decoder) || '取得不可'}`,
        `${share.local ? '省電力エンコード' : '省電力デコード'}: ${stats.powerEfficient == null ? '取得不可' : stats.powerEfficient ? '有効' : '無効'}`,
        stats.protocol ? `接続: ${stats.protocol.toUpperCase()}` : null,
        stats.rttMs != null ? `RTT: ${stats.rttMs.toFixed(1)} ms` : null,
        share.local && stats.availableOutgoingMbps != null
          ? `送信帯域推定: ${stats.availableOutgoingMbps.toFixed(1)} Mbps`
          : null,
        stats.remoteLossPercent != null ? `SFU受信損失（直近RTCP）: ${stats.remoteLossPercent.toFixed(2)}%` : null,
        stats.sendQueueMs != null ? `送信待ち: ${stats.sendQueueMs.toFixed(1)} ms/パケット` : null,
        stats.lossPercent != null ? `パケット損失: ${stats.lossPercent.toFixed(2)}%` : null,
        stats.bufferMs != null ? `受信バッファ実測: ${stats.bufferMs.toFixed(1)} ms` : null,
        stats.dropped != null ? `受信破棄: ${stats.dropped} フレーム/直近2秒` : null,
        stats.playbackDropped != null ? `再生破棄: ${stats.playbackDropped} フレーム/直近2秒` : null,
        stats.freezes != null ? `再生停止: ${stats.freezes} 回/直近2秒` : null,
        stats.targetBitrateMbps != null ? `エンコーダー目標: ${stats.targetBitrateMbps.toFixed(1)} Mbps` : null,
        share.local ? `画質制限: ${limitation}` : null,
      ].filter((detail): detail is string => Boolean(detail))
    : [];
  const fps = !share.local && stats?.playbackFps != null ? stats.playbackFps : stats?.fps;
  const fpsLabel = share.local ? '送信' : stats?.playbackFps != null ? '再生' : 'デコード';
  return (
    <section className="stream-diagnostics" aria-label="配信の診断情報" tabIndex={0} data-player-controls>
      <div className="stream-quality">
        {share.profile || '画質自動'}
        {stats?.bitrateMbps != null && ` · ${stats.bitrateMbps.toFixed(1)} Mbps`}
        {fps != null && ` · ${fpsLabel} ${fps.toFixed(0)} FPS`}
      </div>
      {details.length ? (
        <div className="diagnostic-metrics">
          {details.map((detail) => (
            <span key={detail.split(':')[0]}>{detail}</span>
          ))}
        </div>
      ) : (
        <p className="diagnostic-wait">診断情報を取得しています…</p>
      )}
    </section>
  );
}

function App() {
  const [rooms, setRooms] = useState<ListedRoom[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(Boolean(inviteRoom || focusProducer));
  const [connectionError, setConnectionError] = useState('');
  const [displayName, setDisplayName] = useState('ゲスト');
  const [presetId, setPresetId] = useState(() => {
    const storageKey = 'eigetsu-quality-preset';
    const saved = localStorage.getItem(storageKey);
    if (!localStorage.getItem('eigetsu-quality-preset-v2')) {
      if (!saved || saved === '4k30') localStorage.setItem(storageKey, '1440p60');
      localStorage.setItem('eigetsu-quality-preset-v2', '1');
    }
    const selected = localStorage.getItem(storageKey) || '1440p60';
    return presets.some((preset) => preset.id === selected) ? selected : '1440p60';
  });
  const connection = useRef<Connection | null>(null);
  const shareMap = useRef(new Map<string, Share>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showNotice = useCallback((message: string, error = false) => {
    setNotice(message);
    setNoticeError(error);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4500);
  }, []);

  const updateShares = useCallback(() => {
    setShares([...shareMap.current.values()]);
  }, []);

  const rpc = <E extends keyof RpcResponses>(socket: Socket, event: E, payload: RpcRequests[E]) =>
    new Promise<RpcResponses[E]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`サーバーから応答がありません (${event})`)), 15000);
      socket.emit(event, payload, (result: ({ ok: true } & RpcResponses[E]) | { ok: false; error?: string }) => {
        clearTimeout(timeout);
        return result?.ok ? resolve(result) : reject(new Error(result?.error || '通信に失敗しました'));
      });
    });

  const connectRoom = useCallback(
    async (roomId: string | null, displayName: string, create = false) => {
      if (connection.current) return;
      setConnecting(true);
      const socket = io({ transports: ['websocket', 'polling'] });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
        });
        const pendingProducerEvents: ProducerAnnouncement[] = [];
        let handleProducerNew: ((data: ProducerAnnouncement) => void) | null = null;
        socket.on('producer:new', (data: ProducerAnnouncement) => {
          if (handleProducerNew) handleProducerNew(data);
          else pendingProducerEvents.push(data);
        });
        const response = await rpc(
          socket,
          create ? 'room:create' : 'room:join',
          create
            ? { name: displayName.trim() || 'ゲスト' }
            : { roomId: roomId || '', name: displayName.trim() || 'ゲスト' },
        );
        const device = new Device();
        await device.load({ routerRtpCapabilities: response.rtpCapabilities });
        const createTransport = async (direction: 'send' | 'recv'): Promise<Transport> => {
          const info = await rpc(socket, 'transport:create', { direction });
          const transport =
            device[direction === 'send' ? 'createSendTransport' : 'createRecvTransport']<ShareAppData>(info);
          transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            rpc(socket, 'transport:connect', { transportId: transport.id, dtlsParameters })
              .then(() => callback())
              .catch(errback);
          });
          transport.on('connectionstatechange', (state) => {
            console.info(`[mediasoup:${direction}] connection state: ${state}`);
            if (direction === 'recv' && state === 'failed') {
              setConnectionError('受信トランスポートに接続できません。SFU の ICE ポート設定を確認してください。');
            }
          });
          if (direction === 'send') {
            transport.observer.once('close', () => socket.emit('transport:close', { transportId: transport.id }));
            transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
              rpc(socket, 'produce', { transportId: transport.id, kind, rtpParameters, appData })
                .then((result) => callback({ id: result.id }))
                .catch(errback);
            });
          }
          return transport;
        };
        const recvTransport = await createTransport('recv');
        connection.current = {
          socket,
          device,
          createSendTransport: () => createTransport('send'),
          recvTransport,
          displayName: displayName.trim() || 'ゲスト',
          peerIds: new Set([socket.id!]),
        };
        const compatibleSender = createCompatibleVideoSender({
          getProducer: (id) => shareMap.current.get(id)?.producer,
          createTransport: () => createTransport('send'),
          capabilities: device.sendRtpCapabilities,
          onStatus: (id, active) => {
            const share = shareMap.current.get(id);
            if (share) {
              share.compatibilityActive = active;
              updateShares();
            }
          },
        });
        connection.current.compatibleSender = compatibleSender;
        socket.on('producer:compatibility-request', compatibleSender.request);
        socket.on('producer:compatibility-stop', ({ producerId }) => compatibleSender.stop(producerId));
        socket.on('disconnect', () => compatibleSender.close());

        const subscribing = new Set<string>();
        const pendingAudio = new Map<string, { consumer: Consumer; track: MediaStreamTrack }[]>();
        const subscribe = async (
          producerId: string,
          peerId: string,
          peerName: string,
          label: string | undefined,
          profile: string | undefined,
          kind: Media.MediaKind = 'video',
          appData: ShareAppData = {},
        ) => {
          if (shareMap.current.has(producerId) || subscribing.has(producerId)) return;
          subscribing.add(producerId);
          let consumer: Consumer | undefined;
          try {
            const info = await rpc(socket, 'consume', {
              transportId: recvTransport.id,
              producerId,
              rtpCapabilities: device.recvRtpCapabilities,
            });
            consumer = await recvTransport.consume<ShareAppData>(info);
            configureScreenShareReceiver(consumer);
            if (kind === 'video' && producerId === focusProducer) {
              consumer.track.addEventListener('unmute', () => console.info('[popout] received the first video frame'), {
                once: true,
              });
            }
            const initiallyPaused = Boolean(kind === 'video' && focusProducer && producerId !== focusProducer);
            if (initiallyPaused) {
              consumer.pause();
              await rpc(socket, 'consumer:pause', { consumerId: consumer.id });
            } else {
              await rpc(socket, 'consumer:resume', { consumerId: consumer.id });
            }
            if (kind === 'video' && producerId === focusProducer) {
              setTimeout(async () => {
                if (!consumer || consumer.closed) return;
                try {
                  const receiverStats = [...(await consumer.getStats()).values()];
                  const transportStats = [...(await recvTransport.getStats()).values()];
                  console.info('[popout] recv transport state', {
                    connection: recvTransport.connectionState,
                    iceGathering: recvTransport.iceGatheringState,
                  });
                  console.info(
                    '[popout] ICE stats',
                    transportStats
                      .filter((stat) =>
                        ['candidate-pair', 'local-candidate', 'remote-candidate', 'transport'].includes(stat.type),
                      )
                      .map(
                        ({
                          type,
                          state,
                          nominated,
                          selectedCandidatePairId,
                          localCandidateId,
                          remoteCandidateId,
                          bytesReceived,
                          bytesSent,
                          packetsReceived,
                          packetsSent,
                          candidateType,
                          protocol,
                          address,
                          port,
                        }) => ({
                          type,
                          state,
                          nominated,
                          selectedCandidatePairId,
                          localCandidateId,
                          remoteCandidateId,
                          bytesReceived,
                          bytesSent,
                          packetsReceived,
                          packetsSent,
                          candidateType,
                          protocol,
                          address,
                          port,
                        }),
                      ),
                  );
                  console.info('[popout] receiver stats', receiverStats);
                } catch (error) {
                  console.warn('[popout] unable to read media stats', error);
                }
              }, 3000);
            }
            if (kind === 'audio') {
              const parentId = appData.videoProducerId;
              if (!parentId) throw new Error('Audio producer has no video source');
              const share = shareMap.current.get(parentId);
              if (share) {
                share.audioTrack = consumer.track;
                share.audioProducerId = producerId;
                share.audioConsumer = consumer;
                share.consumers.push(consumer);
              } else {
                const waiting = pendingAudio.get(parentId) || [];
                waiting.push({ consumer, track: consumer.track });
                pendingAudio.set(parentId, waiting);
              }
            } else {
              const share: RemoteShare = {
                producerId,
                peerId,
                peerName,
                label,
                profile,
                captureSurface: appData.captureSurface,
                stream: new MediaStream([consumer.track]),
                consumers: [consumer],
                videoConsumer: consumer,
                recvTransport,
                videoPaused: initiallyPaused,
                videoPauseTarget: initiallyPaused,
                videoPauseSyncing: false,
                local: false,
                ownSource: appData.clientId === clientId,
                audioMuted: true,
                audioVolume: Math.max(
                  0,
                  Math.min(1, Number(localStorage.getItem(`eigetsu-volume-${producerId}`)) || 0),
                ),
              };
              if (info.appData?.compatibilityFor) share.profile = info.appData.profile;
              if (localStorage.getItem(`eigetsu-volume-${producerId}`) === null) share.audioVolume = 1;
              const waiting = pendingAudio.get(producerId) || [];
              if (waiting.length) {
                share.audioTrack = waiting[0].track;
                share.audioConsumer = waiting[0].consumer;
                share.audioProducerId = waiting[0].consumer.producerId;
                share.consumers.push(...waiting.map((item) => item.consumer));
                pendingAudio.delete(producerId);
              }
              shareMap.current.set(producerId, share);
              if (producerId === focusProducer) setConnectionError('');
            }
            updateShares();
          } catch (error) {
            if (consumer) socket.emit('consumer:close', { consumerId: consumer.id });
            consumer?.close();
            console.warn('Unable to consume producer', error);
            if (producerId === focusProducer) setConnectionError(`配信を受信できません: ${errorMessage(error)}`);
            else if (kind === 'video')
              showNotice(`${peerName || '参加者'}の画面を受信できません: ${errorMessage(error)}`, true);
          } finally {
            subscribing.delete(producerId);
          }
        };
        const removeShare = (producerId: string, peerId?: string) => {
          const share = shareMap.current.get(producerId);
          if (!share) {
            for (const parent of shareMap.current.values()) {
              if (parent.audioProducerId !== producerId || (peerId && parent.peerId !== peerId)) continue;
              parent.audioConsumer?.close();
              parent.audioTrack = null;
              parent.audioProducerId = null;
              updateShares();
              return;
            }
            return;
          }
          if (peerId && share.peerId !== peerId) return;
          for (const item of pendingAudio.get(producerId) || []) item.consumer.close();
          pendingAudio.delete(producerId);
          share.consumers?.forEach((consumer) => consumer.close());
          shareMap.current.delete(producerId);
          updateShares();
        };

        socket.on('peer:joined', ({ id }) => {
          connection.current?.peerIds.add(id);
          setRoom((current) => (current ? { ...current, people: connection.current?.peerIds.size || 0 } : current));
        });
        handleProducerNew = (data) =>
          subscribe(data.producerId, data.peerId, data.peerName, data.label, data.profile, data.kind, data.appData);
        for (const data of pendingProducerEvents.splice(0)) handleProducerNew(data);
        socket.on('producer:closed', ({ producerId, peerId }) => removeShare(producerId, peerId));
        socket.on('peer:left', ({ peerId }) => {
          connection.current?.peerIds.delete(peerId);
          setRoom((current) => (current ? { ...current, people: connection.current?.peerIds.size || 0 } : current));
          for (const [producerId, share] of shareMap.current)
            if (share.peerId === peerId) removeShare(producerId, peerId);
        });
        socket.on('connect_error', (error) => showNotice(`接続エラー: ${errorMessage(error)}`, true));
        for (const peer of response.peers) {
          connection.current.peerIds.add(peer.id);
          for (const share of peer.shares)
            await subscribe(share.id, peer.id, peer.name, share.label, share.profile, share.kind, share.appData);
        }
        setRoom({
          id: response.roomId,
          name: response.roomName || '配信ルーム',
          people: connection.current?.peerIds.size || 0,
        });
        setConnectionError('');
        setFocusedId(focusProducer || null);
        setConnecting(false);
      } catch (error) {
        socket.disconnect();
        connection.current = null;
        setConnecting(false);
        setConnectionError(errorMessage(error));
        showNotice(errorMessage(error), true);
      }
    },
    [showNotice, updateShares],
  );

  useEffect(() => {
    if (inviteRoom) connectRoom(inviteRoom, 'ゲスト');
    else if (focusProducer) showNotice('部屋情報がありません', true);
  }, [connectRoom, showNotice]);

  useEffect(() => {
    if (room || inviteRoom) return undefined;
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/rooms', { cache: 'no-store' });
        if (!response.ok) throw new Error('部屋一覧を取得できませんでした');
        const data: ListedRoom[] = await response.json();
        if (!disposed) setRooms(data.sort((a, b) => b.peopleCount - a.peopleCount));
      } catch (error) {
        if (!disposed) showNotice(errorMessage(error), true);
      }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [room, showNotice]);

  useEffect(() => {
    const current = connection.current;
    if (!current) return;
    for (const share of shares) {
      if (share.local || !share.videoConsumer || share.videoConsumer.closed) continue;
      share.videoPauseTarget = Boolean(focusedId && share.producerId !== focusedId);
      if (share.videoPauseTarget === share.videoPaused || share.videoPauseSyncing) continue;
      share.videoPauseSyncing = true;
      (async () => {
        try {
          while (
            connection.current === current &&
            !share.videoConsumer.closed &&
            share.videoPaused !== share.videoPauseTarget
          ) {
            const pause = share.videoPauseTarget;
            await rpc(current.socket, pause ? 'consumer:pause' : 'consumer:resume', {
              consumerId: share.videoConsumer.id,
            });
            if (share.videoConsumer.closed) break;
            if (pause) share.videoConsumer.pause();
            else share.videoConsumer.resume();
            share.videoPaused = pause;
          }
        } catch (error) {
          share.videoPauseTarget = share.videoPaused;
          showNotice(`映像受信を切り替えられません: ${errorMessage(error)}`, true);
        } finally {
          share.videoPauseSyncing = false;
        }
      })();
    }
  }, [focusedId, shares, showNotice]);

  useEffect(
    () => () => {
      const current = connection.current;
      if (!current) return;
      for (const share of shareMap.current.values()) {
        share.producer?.close();
        share.audioProducer?.close();
        share.videoTransport?.close();
        share.audioTransport?.close();
        share.audioGain?.context.close();
        share.consumers?.forEach((consumer) => consumer.close());
        share.stream?.getTracks().forEach((track) => track.stop());
      }
      current.socket.disconnect();
    },
    [],
  );

  const createRoom = () => connectRoom('', displayName, true);
  const joinListedRoom = (id: string) => connectRoom(id, displayName);
  const selectPreset = (id: string) => {
    setPresetId(id);
    localStorage.setItem('eigetsu-quality-preset', id);
  };

  const setShareVolume = (producerId: string, value: number) => {
    const share = shareMap.current.get(producerId);
    if (!share) return;
    const volume = Math.max(0, Math.min(1, Number(value)));
    share.audioVolume = volume;
    if (share.local && share.audioGain) setSharedAudioGain(share.audioGain, volume, share.audioMuted);
    else localStorage.setItem(`eigetsu-volume-${producerId}`, String(volume));
    updateShares();
  };

  const toggleShareMute = (producerId: string) => {
    const share = shareMap.current.get(producerId);
    if (!share) return;
    share.audioMuted = !share.audioMuted;
    if (share.local && share.audioGain) setSharedAudioGain(share.audioGain, share.audioVolume, share.audioMuted);
    updateShares();
  };

  const togglePreview = (producerId: string) => {
    const share = shareMap.current.get(producerId);
    if (!share?.local) return;
    share.previewEnabled = !share.previewEnabled;
    updateShares();
  };

  const startShare = async () => {
    let stream: MediaStream | undefined;
    let videoTransport: Transport | undefined;
    try {
      const current = connection.current;
      if (!current) return;
      const preset = presets.find((item) => item.id === presetId) || defaultQualityPreset;
      selectScreenShareCodec(current.device.sendRtpCapabilities);
      stream = await navigator.mediaDevices.getDisplayMedia(screenShareCaptureOptions(preset));
      if (connection.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      const label = track.label || '画面共有';
      const captureSurface = track.getSettings().displaySurface;
      const video = await produceScreenShareVideo(
        current.createSendTransport,
        track,
        preset,
        { label, profile: preset.label, clientId, captureSurface, compatibilitySupported: true },
        current.device.sendRtpCapabilities,
      );
      const producer = video.producer;
      videoTransport = video.transport;
      if (connection.current !== current || isTrackEnded(track)) {
        videoTransport.close();
        stream.getTracks().forEach((item) => item.stop());
        return;
      }
      const share: LocalShare = {
        producerId: producer.id,
        peerId: current.socket.id!,
        peerName: current.displayName,
        label,
        profile: preset.label,
        maxBitrate: preset.bitrate,
        stream,
        consumers: [],
        local: true,
        producer,
        videoTransport,
        audioVolume: 1,
        audioMuted: false,
        previewEnabled: true,
      };
      // Make the source available to a compatibility request while audio is
      // still negotiating. The SFU has already announced the video producer.
      shareMap.current.set(producer.id, share);
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        try {
          const audio = await produceScreenShareAudio(current.createSendTransport, audioTrack, {
            label,
            profile: preset.label,
            videoProducerId: producer.id,
            clientId,
          });
          share.audioProducer = audio.producer;
          share.audioTransport = audio.transport;
          share.audioGain = audio.audioGain;
        } catch (error) {
          showNotice(`共有音声を開始できませんでした: ${errorMessage(error)}`, true);
        }
      }
      if (connection.current !== current || isTrackEnded(track)) {
        share.producer.close();
        share.audioProducer?.close();
        share.videoTransport.close();
        share.audioTransport?.close();
        share.audioGain?.context.close();
        stream.getTracks().forEach((item) => item.stop());
        shareMap.current.delete(producer.id);
        updateShares();
        return;
      }
      track.addEventListener('ended', () => stopShare(producer.id), { once: true });
      updateShares();
      showNotice('画面を共有しています');
    } catch (error) {
      videoTransport?.close();
      stream?.getTracks().forEach((track) => track.stop());
      if (!(error instanceof Error && error.name === 'NotAllowedError'))
        showNotice(`画面共有を開始できません: ${errorMessage(error)}`, true);
    }
  };

  const stopShare = (producerId: string) => {
    const share = shareMap.current.get(producerId);
    if (!share) return;
    connection.current?.socket.emit('producer:close', { producerId });
    if (share.audioProducer) connection.current?.socket.emit('producer:close', { producerId: share.audioProducer.id });
    share.producer?.close();
    share.audioProducer?.close();
    share.videoTransport?.close();
    share.audioTransport?.close();
    share.audioGain?.context.close();
    share.stream.getTracks().forEach((track) => track.stop());
    shareMap.current.delete(producerId);
    updateShares();
  };

  const leaveRoom = () => {
    const current = connection.current;
    for (const [producerId, share] of shareMap.current) {
      if (share.local) {
        current?.socket.emit('producer:close', { producerId });
        if (share.audioProducer) current?.socket.emit('producer:close', { producerId: share.audioProducer.id });
        share.producer?.close();
        share.audioProducer?.close();
        share.videoTransport?.close();
        share.audioTransport?.close();
        share.audioGain?.context.close();
        share.stream.getTracks().forEach((track) => track.stop());
      } else {
        share.consumers?.forEach((consumer) => consumer.close());
      }
    }
    current?.socket.disconnect();
    connection.current = null;
    shareMap.current.clear();
    setShares([]);
    setRoom(null);
    setConnecting(false);
    history.replaceState(null, '', location.pathname);
  };

  const openPopout = (producerId: string | undefined) => {
    if (!room || !producerId) return;
    const url = new URL(location.href);
    url.search = new URLSearchParams({ room: room.id, focus: producerId }).toString();
    const popup = window.open(
      url.toString(),
      `eigetsu-${producerId}`,
      `popup=yes,width=${screen.availWidth},height=${screen.availHeight}`,
    );
    if (!popup) showNotice('別ウィンドウを開けません。ポップアップを許可してください。', true);
    else popup.focus();
  };

  const toggleFullscreen = async (element: HTMLElement | null) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element?.requestFullscreen();
    } catch (error) {
      showNotice(`全画面表示にできません: ${errorMessage(error)}`, true);
    }
  };

  const copyInvite = async () => {
    if (!room) return;
    await navigator.clipboard.writeText(`${location.origin}?room=${room.id}`);
    showNotice('招待リンクをコピーしました');
  };

  if (connecting && !room) return <div className="boot-screen">ルームに接続しています…</div>;
  if (focusProducer && !room && !connecting)
    return (
      <div className="boot-screen">
        <div>{connectionError || notice || '画面ルームに接続できません'}</div>
        <button onClick={() => connectRoom(inviteRoom, 'ゲスト')}>再接続</button>
      </div>
    );
  if (!room)
    return (
      <Lobby
        rooms={rooms}
        displayName={displayName}
        setDisplayName={setDisplayName}
        onCreate={createRoom}
        onJoin={joinListedRoom}
        notice={notice}
        noticeError={noticeError}
      />
    );

  const focusShare = shares.find((share) => share.producerId === (focusProducer || focusedId));
  if (focusProducer)
    return (
      <Popout
        share={focusShare}
        errorMessage={connectionError}
        onVolume={setShareVolume}
        onToggleMute={toggleShareMute}
        onFullscreen={toggleFullscreen}
        onClose={() => window.close()}
      />
    );
  const visibleShares = focusedId ? shares.filter((share) => share.producerId === focusedId) : shares;

  return (
    <RoomView
      room={room}
      shares={visibleShares}
      allShareCount={shares.length}
      presetId={presetId}
      onPreset={selectPreset}
      focused={Boolean(focusedId)}
      onFocus={setFocusedId}
      onStartShare={startShare}
      onVolume={setShareVolume}
      onToggleMute={toggleShareMute}
      onTogglePreview={togglePreview}
      onStopShare={stopShare}
      onPopout={openPopout}
      onFullscreen={toggleFullscreen}
      onCopy={copyInvite}
      onLeave={leaveRoom}
      notice={notice}
      noticeError={noticeError}
    />
  );
}

function Lobby({ rooms, displayName, setDisplayName, onCreate, onJoin, notice, noticeError }: LobbyProps) {
  return (
    <main className="shell">
      <section className="workspace">
        <div className="section-heading">
          <div>
            <div className="eyebrow">画面共有</div>
            <h1>共有をはじめる</h1>
          </div>
        </div>
        <div className="lobby-name">
          <label className="field-label" htmlFor="display-name">
            表示名
          </label>
          <input
            id="display-name"
            className="text-input"
            maxLength={40}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="entry-grid">
          <article className="entry-card create-card">
            <h2>部屋を作成</h2>
            <p>新しい部屋を作ります。</p>
            <button className="primary-btn" onClick={onCreate}>
              部屋を作成 <span>→</span>
            </button>
          </article>
          <article className="entry-card join-card">
            <h2>部屋に参加</h2>
            <p>公開中の部屋</p>
            <div className="public-room-list" aria-live="polite">
              {rooms.length ? (
                rooms.map((room) => (
                  <article className="public-room-item" key={room.id}>
                    <div className="public-room-info">
                      <b>{room.name || '配信ルーム'}</b>
                      <small>
                        {room.peopleCount
                          ? `${room.peopleCount} 人が参加中`
                          : `空室 · ${formatRemaining(room.remainingMs)} 後に削除`}
                      </small>
                    </div>
                    <button className="room-join-button" onClick={() => onJoin(room.id)}>
                      参加
                    </button>
                  </article>
                ))
              ) : (
                <div className="room-list-message">参加できる部屋はありません。</div>
              )}
            </div>
          </article>
        </div>
        {notice && (
          <div className={`notice visible${noticeError ? ' error' : ''}`} role="status">
            {notice}
          </div>
        )}
      </section>
    </main>
  );
}

function FloatingDiagnostics({ share, onClose }: { share: Share; onClose(): void }) {
  const [side, setSide] = useState('right');
  return (
    <aside className={`player-diagnostics is-${side}`} aria-label="配信の診断パネル" data-player-controls>
      <div className="diagnostics-toolbar">
        <span>診断情報</span>
        <div>
          <button onClick={() => setSide(side === 'right' ? 'left' : 'right')}>
            {side === 'right' ? '左に移動' : '右に移動'}
          </button>
          <button onClick={onClose} aria-label="診断情報を閉じる">
            閉じる
          </button>
        </div>
      </div>
      <StreamQuality share={share} />
    </aside>
  );
}

function RoomView({
  room,
  shares,
  allShareCount,
  focused,
  presetId,
  onPreset,
  onFocus,
  onStartShare,
  onStopShare,
  onPopout,
  onFullscreen,
  onCopy,
  onLeave,
  onVolume,
  onToggleMute,
  onTogglePreview,
  notice,
  noticeError,
}: RoomViewProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const controls = usePlayerControls(focused);
  const [diagnosticsShown, setDiagnosticsShown] = useState(false);
  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="top-actions">
          <button className="leave-btn" onClick={onLeave}>
            退出
          </button>
        </div>
      </header>
      <div className="room-top">
        <div>
          <h1>{room.name}</h1>
          <div className="room-meta">
            <span className="room-code">{room.id}</span>
            <button className="copy-btn" onClick={onCopy}>
              招待リンクをコピー
            </button>
            <span className="divider">/</span>
            <span>{room.people} 人が参加中</span>
          </div>
        </div>
        <div className="share-controls">
          <label className="quality-control">
            <span>配信画質</span>
            <select value={presetId} onChange={(event) => onPreset(event.target.value)}>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <button className="share-screen-btn" onClick={onStartShare}>
            <span>＋</span>画面を共有
          </button>
        </div>
      </div>
      <div className="room-toolbar">
        <div className="toolbar-label">
          画面 <span className="count-pill">{focused ? allShareCount : shares.length}</span>
        </div>
      </div>
      <div
        ref={gridRef}
        className={`share-grid${focused ? ' is-focused' : ''}${controls.visible ? ' controls-visible' : ''}${controls.cursorHidden ? ' cursor-idle' : ''}`}
        {...controls.handlers}
      >
        {focused && (
          <div className="focus-toolbar" data-player-controls>
            <button
              onClick={() => {
                if (document.fullscreenElement) onFullscreen(gridRef.current);
                onFocus(null);
              }}
            >
              ← すべての画面
            </button>
            <div>
              <button
                className="diagnostics-toggle"
                aria-expanded={diagnosticsShown}
                onClick={() => setDiagnosticsShown(!diagnosticsShown)}
              >
                {diagnosticsShown ? '診断を非表示' : '診断を表示'}
              </button>
              <button onClick={() => onFullscreen(gridRef.current)}>全画面表示</button>
              <button onClick={() => onPopout(shares[0]?.producerId)}>別ウィンドウで開く</button>
            </div>
          </div>
        )}
        {shares.length ? (
          shares.map((share) => (
            <article
              className={`stream-card${focused ? ' is-focused' : ''}`}
              data-stream={share.producerId}
              key={share.producerId}
            >
              <div
                className="video-wrap"
                onClick={() => {
                  if (!focused) onFocus(share.producerId);
                }}
                onDoubleClick={(event) => {
                  if (focused && controls.canToggleFullscreen(event)) onFullscreen(gridRef.current);
                }}
              >
                <Video share={share} stream={share.stream} muted enabled={!share.local || share.previewEnabled} />
                {share.local && !share.previewEnabled && (
                  <div className="preview-off">プレビューを非表示にしています</div>
                )}
                <AudioOutput
                  track={share.audioTrack}
                  volume={share.audioVolume}
                  muted={share.ownSource || share.audioMuted}
                />
                <div className="video-overlay">
                  <span className="on-air">
                    <i />
                    LIVE
                  </span>
                  {share.local && (
                    <button
                      className="stop-share"
                      onClick={(event) => {
                        event.stopPropagation();
                        onStopShare(share.producerId);
                      }}
                    >
                      共有を停止
                    </button>
                  )}
                </div>
                {focused && diagnosticsShown && (
                  <FloatingDiagnostics share={share} onClose={() => setDiagnosticsShown(false)} />
                )}
              </div>
              <div className="stream-info" data-player-controls={focused ? '' : undefined}>
                <div className="stream-person">
                  <span className="person-avatar">{share.peerName?.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <b>{share.peerName}</b>
                    <small>{share.label}</small>
                  </div>
                </div>
                <div className="screen-actions">
                  {focused && share.local && (
                    <button className="stop-share" onClick={() => onStopShare(share.producerId)}>
                      共有を停止
                    </button>
                  )}
                  {share.local && (
                    <button className="preview-toggle" onClick={() => onTogglePreview(share.producerId)}>
                      {share.previewEnabled ? 'プレビューを隠す' : 'プレビューを表示'}
                    </button>
                  )}
                  {((share.audioTrack && !share.ownSource) || (share.local && share.audioProducer)) && (
                    <>
                      <button
                        className="mute-toggle"
                        aria-pressed={!share.audioMuted}
                        onClick={() => onToggleMute(share.producerId)}
                      >
                        {share.audioMuted ? 'ミュート解除' : 'ミュート'}
                      </button>
                      <label className="volume-control">
                        <span>音量</span>
                        <input
                          aria-label={`${share.label}の音量`}
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round((share.audioVolume ?? 1) * 100)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => onVolume(share.producerId, Number(event.target.value) / 100)}
                        />
                      </label>
                    </>
                  )}
                  {!focused && (
                    <button className="screen-expand" onClick={() => onFocus(share.producerId)}>
                      拡大
                    </button>
                  )}
                  <button className="screen-popout" onClick={() => onPopout(share.producerId)}>
                    別ウィンドウ
                  </button>
                </div>
              </div>
              {!focused && <StreamQuality share={share} />}
            </article>
          ))
        ) : (
          <div className="empty-state">
            <div className="empty-visual">
              <div className="empty-screen">
                <span>◈</span>
              </div>
              <i className="spark spark-one">✳</i>
              <i className="spark spark-two">✦</i>
            </div>
            <h2>まだ画面は共有されていません</h2>
            <p>最初の共有をはじめるか、ルームを仲間にシェアしましょう。</p>
            <button className="secondary-btn compact" onClick={onStartShare}>
              画面を共有する <span>→</span>
            </button>
          </div>
        )}
      </div>
      {notice && (
        <div className={`notice visible${noticeError ? ' error' : ''}`} role="status">
          {notice}
        </div>
      )}
    </main>
  );
}

function Popout({ share, errorMessage, onVolume, onToggleMute, onFullscreen, onClose }: PopoutProps) {
  const stage = useRef<HTMLElement | null>(null);
  const controls = usePlayerControls();
  const [diagnosticsShown, setDiagnosticsShown] = useState(false);
  return (
    <main
      ref={stage}
      className={`focus-window${controls.visible ? ' controls-visible' : ''}${controls.cursorHidden ? ' cursor-idle' : ''}`}
      {...controls.handlers}
    >
      <header data-player-controls>
        <span className="focus-title">{share ? `${share.peerName} · ${share.label}` : '画面に接続しています…'}</span>
        <div className="focus-window-actions">
          <button
            className="diagnostics-toggle"
            aria-expanded={diagnosticsShown}
            disabled={!share}
            onClick={() => setDiagnosticsShown(!diagnosticsShown)}
          >
            {diagnosticsShown ? '診断を非表示' : '診断を表示'}
          </button>
          <button onClick={() => onFullscreen(stage.current)}>全画面表示</button>
          <button onClick={onClose}>閉じる</button>
        </div>
      </header>
      <section className="focus-player">
        <div
          className="video-wrap"
          onDoubleClick={(event) => {
            if (controls.canToggleFullscreen(event)) onFullscreen(stage.current);
          }}
        >
          {share ? (
            <>
              <Video share={share} stream={share.stream} muted enabled={!share.local || share.previewEnabled} />
              {share.local && !share.previewEnabled && (
                <div className="preview-off">プレビューを非表示にしています</div>
              )}
              <AudioOutput
                track={share.audioTrack}
                volume={share.audioVolume}
                muted={share.ownSource || share.audioMuted}
              />
            </>
          ) : (
            <div className="focus-wait">{errorMessage || '配信に接続しています…'}</div>
          )}
          {share && diagnosticsShown && (
            <FloatingDiagnostics share={share} onClose={() => setDiagnosticsShown(false)} />
          )}
        </div>
        <div className="focus-audio-controls" data-player-controls>
          {share?.audioTrack && !share.ownSource && (
            <>
              <button
                className="mute-toggle"
                aria-pressed={!share.audioMuted}
                onClick={() => onToggleMute(share.producerId)}
              >
                {share.audioMuted ? 'ミュート解除' : 'ミュート'}
              </button>
              <label className="volume-control">
                <span>音量</span>
                <input
                  aria-label={`${share.label}の音量`}
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round((share.audioVolume ?? 1) * 100)}
                  onChange={(event) => onVolume(share.producerId, Number(event.target.value) / 100)}
                />
              </label>
            </>
          )}
          <button className="mute-toggle" onClick={onClose}>
            閉じる
          </button>
        </div>
      </section>
    </main>
  );
}

function formatRemaining(milliseconds: number | null = 0) {
  const seconds = Math.max(0, Math.ceil((milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

createRoot(document.getElementById('root')!).render(<App />);
