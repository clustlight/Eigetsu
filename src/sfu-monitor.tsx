import { useEffect, useState } from 'react';
import type { Connection } from './types.ts';
import type { SfuSelection } from './sfu-selection.ts';
import type { ClusterStatistics, TrafficStats } from '../sfu/statistics-types.ts';

const mbps = (value: number) => `${(value / 1_000_000).toFixed(2)} Mbps`;
const mib = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
const milliseconds = (value: number | null | undefined) => (value == null ? '—' : `${value.toFixed(1)} ms`);

interface TransportSample {
  id: string;
  direction: string;
  state: string;
  protocol?: string;
  rttMs?: number;
}
interface CandidateStat {
  id: string;
  type: string;
  selectedCandidatePairId?: string;
  nominated?: boolean;
  state?: string;
  currentRoundTripTime?: number;
  localCandidateId?: string;
  protocol?: string;
}

export function SfuConnectionInfo({
  site,
  getConnection,
}: {
  site: SfuSelection | null;
  getConnection: () => Connection | null;
}) {
  const [sample, setSample] = useState<{
    connected: boolean;
    signalingRtt: number | null;
    masterReady: boolean | null;
    transports: TransportSample[];
  }>({ connected: false, signalingRtt: null, masterReady: null, transports: [] });
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      const connection = getConnection();
      const start = performance.now();
      const [ping, transports] = await Promise.all([
        connection?.socket.connected
          ? connection.socket
              .timeout(2000)
              .emitWithAck('connection:ping')
              .then((reply: { ready: boolean }) => ({
                rtt: performance.now() - start,
                ready: reply.ready,
              }))
              .catch(() => null)
          : Promise.resolve(null),
        Promise.all(
          [...(connection?.transports || [])].map(async (transport): Promise<TransportSample> => {
            const result: TransportSample = {
              id: transport.id,
              direction: transport.direction,
              state: transport.connectionState,
            };
            try {
              const report = await transport.getStats();
              const stats: CandidateStat[] = [...report.values()];
              const selected = stats.find((stat) => stat.type === 'transport')?.selectedCandidatePairId;
              const pair = selected
                ? stats.find((stat) => stat.id === selected)
                : stats.find((stat) => stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded');
              result.rttMs = pair?.currentRoundTripTime == null ? undefined : pair.currentRoundTripTime * 1000;
              result.protocol = stats.find((stat) => stat.id === pair?.localCandidateId)?.protocol;
            } catch {
              /* A transport can close while sampling. */
            }
            return result;
          }),
        ),
      ]);
      if (disposed) return;
      if (getConnection() === connection)
        setSample({
          connected: Boolean(connection?.socket.connected),
          signalingRtt: ping?.rtt ?? null,
          masterReady: ping?.ready ?? null,
          transports,
        });
      timer = setTimeout(() => void update(), 3000);
    };
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [getConnection]);
  if (!site) return null;
  return (
    <details className="sfu-connection" open>
      <summary>
        接続先SFU：{site.id} <span className="metric-muted">{sample.connected ? '接続中' : '再接続待ち'}</span>
      </summary>
      <div className="connection-metrics">
        <span>
          接続先 <b>{site.url}</b>
        </span>
        <span>
          選定時RTT <b>{milliseconds(site.rttMs)}</b>
        </span>
        <span>
          現在の制御通信RTT <b>{milliseconds(sample.signalingRtt)}</b>
        </span>
        <span>
          マスター連携 <b>{sample.masterReady == null ? '確認できません' : sample.masterReady ? '接続中' : '切断中'}</b>
        </span>
        <a href="/cluster" target="_blank" rel="noopener noreferrer">
          クラスタ統計 ↗
        </a>
      </div>
      <div className="transport-list">
        {sample.transports.map((transport, index) => (
          <span key={transport.id}>
            {transport.direction === 'send' ? '送信' : '受信'} {index + 1}：
            {transport.state === 'new' ? 'メディア開始待ち' : transport.state}
            {transport.protocol && ` / ${transport.protocol.toUpperCase()}`} / WebRTC RTT{' '}
            {milliseconds(transport.rttMs)}
          </span>
        ))}
      </div>
    </details>
  );
}

function Traffic({ title, stats }: { title: string; stats: TrafficStats }) {
  return (
    <div className="traffic-stat">
      <h3>{title}</h3>
      <dl className="metric-grid">
        <div>
          <dt>受信</dt>
          <dd>{mbps(stats.receiveBps)}</dd>
        </div>
        <div>
          <dt>送信</dt>
          <dd>{mbps(stats.sendBps)}</dd>
        </div>
        <div>
          <dt>受信量</dt>
          <dd>{mib(stats.bytesReceived)}</dd>
        </div>
        <div>
          <dt>送信量</dt>
          <dd>{mib(stats.bytesSent)}</dd>
        </div>
        <div>
          <dt>接続数</dt>
          <dd>{stats.transports}</dd>
        </div>
      </dl>
      {stats.unavailable > 0 && (
        <p className="metric-warning">{stats.unavailable} 接続の統計を取得できません（一部の値のみ表示）</p>
      )}
    </div>
  );
}

export function ClusterStatisticsPage() {
  const [data, setData] = useState<ClusterStatistics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const update = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20000);
      try {
        const response = await fetch('/sfu/statistics', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('統計を取得できません。マスターへの接続を確認してください。');
        const next: ClusterStatistics = await response.json();
        if (!disposed) {
          setData(next);
          setError('');
        }
      } catch {
        if (!disposed) setError('統計を取得できません。表示済みの値は最新ではありません。5秒後に再試行します。');
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(() => void update(), 5000);
      }
    };
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);
  return (
    <main className="shell cluster-page">
      <a href="/">← ルーム一覧</a>
      <div className="section-heading">
        <div>
          <div className="eyebrow">SFU CLUSTER</div>
          <h1>クラスタ統計</h1>
        </div>
      </div>
      <p className="metric-muted">
        5秒ごとに自動更新 · {data ? `最終取得 ${new Date(data.sampledAt).toLocaleTimeString()}` : '取得中…'}
      </p>
      {error && (
        <p role="alert" className="metric-warning">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="cluster-summary">
            <span>
              登録済みSFU <b>{data.sites.length}</b>
            </span>
            <span>
              応答あり <b>{data.sites.filter((site) => site.status === 'online').length}</b>
            </span>
            <span>
              使用中ルーム <b>{data.rooms}</b>
            </span>
            <span>
              参加接続 <b>{data.peers}</b>
            </span>
          </div>
          <div className="cluster-sites">
            {data.sites.map((site) => (
              <article className="sfu-card" key={site.id}>
                <header>
                  <h2>{site.id}</h2>
                  <span className={site.status === 'online' ? 'metric-online' : 'metric-warning'}>
                    {site.status === 'online' ? '接続中' : site.status === 'offline' ? '切断中' : '統計応答なし'}
                  </span>
                </header>
                <p className="metric-muted">{site.url || 'この拠点（単独構成）'}</p>
                {site.metrics ? (
                  <>
                    <dl className="metric-grid">
                      <div>
                        <dt>役割</dt>
                        <dd>{site.metrics.role}</dd>
                      </div>
                      <div>
                        <dt>稼働時間</dt>
                        <dd>{Math.floor(site.metrics.uptimeSeconds / 60)} 分</dd>
                      </div>
                      <div>
                        <dt>使用中ルーム</dt>
                        <dd>{site.metrics.rooms}</dd>
                      </div>
                      <div>
                        <dt>参加接続</dt>
                        <dd>{site.metrics.peers}</dd>
                      </div>
                      <div>
                        <dt>送信トラック</dt>
                        <dd>{site.metrics.producers}</dd>
                      </div>
                      <div>
                        <dt>Node.js メモリ（RSS）</dt>
                        <dd>{mib(site.metrics.nodeRssBytes)}</dd>
                      </div>
                    </dl>
                    <Traffic title="端末との通信（SFU基準）" stats={site.metrics.clients} />
                    <Traffic title="拠点間通信（SFU基準）" stats={site.metrics.pipes} />
                    <p className="metric-muted">
                      拠点間の受信経路 {site.metrics.incomingPipes} / 送信経路 {site.metrics.outgoingPipes}
                    </p>
                    <h3>mediasoup workers</h3>
                    <div className="worker-list">
                      {site.metrics.workers.map((worker, index) => (
                        <p key={worker.pid}>
                          Worker {index + 1}：CPU{' '}
                          {worker.cpuPercent == null ? '計測中' : `${worker.cpuPercent.toFixed(1)}%`}
                          {' / '}最大RSS {mib(worker.maxRssBytes)}
                        </p>
                      ))}
                    </div>
                    {site.metrics.workerErrors > 0 && (
                      <p className="metric-warning">{site.metrics.workerErrors} workerの統計を取得できません</p>
                    )}
                    <small className="metric-muted">
                      サンプル時刻 {new Date(site.metrics.sampledAt).toLocaleTimeString()}
                    </small>
                  </>
                ) : (
                  <p>この拠点の最新統計はありません。</p>
                )}
              </article>
            ))}
          </div>
          {!data.sites.length && <p>登録済みのSFUはありません。</p>}
        </>
      )}
      <p className="metric-muted statistics-notes">
        通信量は現在存在する接続の累計で、接続終了時に減少します。CPUはworkerごとに1コアを100%として表示します。RSSはプロセスのメモリです。参加接続数には別ウィンドウでの参加も含みます。
      </p>
    </main>
  );
}
