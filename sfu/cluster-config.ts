import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Site } from './cluster-types.js';

export function readClusterConfig(env: NodeJS.ProcessEnv = process.env) {
  const role = env.ROLE || 'standalone';
  if (role !== 'standalone' && role !== 'master' && role !== 'sfu')
    throw new Error('ROLE must be standalone, master or sfu');
  const clustered = role !== 'standalone';
  const siteId = env.SITE_ID || 'local';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(siteId)) throw new Error('Invalid SITE_ID');
  const publicUrl = env.SFU_PUBLIC_URL?.replace(/\/$/, '') || '';
  if (clustered && !publicUrl) throw new Error('SFU_PUBLIC_URL is required for a cluster');
  if (publicUrl) validateOrigin(publicUrl);
  const secret = env.CLUSTER_SECRET || (clustered ? '' : randomUUID());
  if (secret.length < 32) throw new Error('CLUSTER_SECRET must contain at least 32 characters');
  const pipeAddress = env.PIPE_ANNOUNCED_IP || (clustered ? '' : '127.0.0.1');
  if (!isIP(pipeAddress)) throw new Error('PIPE_ANNOUNCED_IP must be a reachable IPv4 or IPv6 address');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const siteGraceMs = Number(env.CLUSTER_SITE_GRACE_MS || 30000);
  if (!Number.isFinite(siteGraceMs) || siteGraceMs < 1) throw new Error('Invalid CLUSTER_SITE_GRACE_MS');
  const masterUrl = role === 'sfu' ? env.MASTER_URL : `http://127.0.0.1:${port}`;
  if (!masterUrl) throw new Error('MASTER_URL is required for ROLE=sfu');
  validateOrigin(masterUrl);
  const site: Site = { id: siteId, url: publicUrl, pipeAddress, instanceId: randomUUID() };
  return {
    role: role as 'standalone' | 'master' | 'sfu',
    site,
    secret,
    masterUrl,
    port,
    pipeListenIp: env.PIPE_LISTEN_IP || '0.0.0.0',
    stateFile: env.MASTER_STATE_FILE || '',
    siteGraceMs,
  };
}

export function validateOrigin(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Server URLs must be HTTP(S) origins without credentials, paths or queries');
}
