export interface SfuSite {
  id: string;
  url: string;
}
export interface SfuSelection extends SfuSite {
  rttMs: number;
}

export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Probe only before joining. Callers keep the returned endpoint for the whole room session. */
export async function selectSfu(sites: SfuSite[], probe: (site: SfuSite) => Promise<number>): Promise<SfuSelection> {
  const measured = await Promise.all(
    sites.map(async (site) => {
      // DNS, TLS and connection setup should not dominate the comparison.
      await probe(site).catch(() => {});
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const elapsed = await probe(site).catch(() => NaN);
        if (Number.isFinite(elapsed) && elapsed >= 0) samples.push(elapsed);
      }
      return samples.length >= 2 ? { ...site, rttMs: median(samples) } : null;
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
  return selectSfu(sites, async (site) => {
    const start = performance.now();
    const result = await fetch(`${site.url}/sfu/ping?nonce=${crypto.randomUUID()}`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(1500),
    });
    if (!result.ok || (await result.json()).siteId !== site.id) throw new Error('SFU probe failed');
    return performance.now() - start;
  });
}
