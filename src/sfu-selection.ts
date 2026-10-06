export interface SfuSite {
  id: string;
  url: string;
}
export interface SfuSelection extends SfuSite {
  rttMs: number;
}

/** Probe only before joining. Callers keep the returned endpoint for the whole room session. */
export async function selectSfu(sites: SfuSite[], probe: (site: SfuSite) => Promise<number>): Promise<SfuSelection> {
  const measured = await Promise.all(
    sites.map(async (site) => {
      const rttMs = await probe(site).catch(() => NaN);
      return Number.isFinite(rttMs) && rttMs >= 0 ? { ...site, rttMs } : null;
    }),
  );
  const available = measured.filter((site): site is SfuSelection => site !== null);
  available.sort((a, b) => a.rttMs - b.rttMs || a.id.localeCompare(b.id));
  if (!available.length) throw new Error('接続できる配信サーバーがありません');
  return available[0];
}

export async function discoverSfu(): Promise<SfuSelection> {
  const response = await fetch('/sfu/sites', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('配信サーバー一覧を取得できません');
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error('配信サーバー一覧が不正です');
  const sites = data.map((site: SfuSite) => {
    if (!site || typeof site.id !== 'string' || typeof site.url !== 'string')
      throw new Error('配信サーバー情報が不正です');
    const url = new URL(site.url || location.origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('配信サーバーの接続先が不正です');
    return { id: site.id, url: url.origin };
  });
  const { probeSfuMedia } = await import('./sfu-probe.ts');
  return selectSfu(sites, probeSfuMedia);
}
