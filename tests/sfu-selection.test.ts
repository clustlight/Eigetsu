import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSfu } from '../src/sfu-selection.ts';
import { readClusterConfig } from '../sfu/cluster-config.ts';

test('SFU selection chooses the lowest media RTT even when the master is listed first and responds first', async () => {
  const sites = ['a', 'b', 'offline'].map((id) => ({ id, url: `https://${id}.example.com` }));
  const selected = await selectSfu(sites, async ({ id }) => {
    if (id === 'a') return 80;
    if (id === 'offline') throw new Error('No ICE connection');
    // Slower signaling/negotiation at B must not affect its measured media RTT.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return 8;
  });
  assert.equal(selected.id, 'b');
  assert.equal(selected.rttMs, 8);
});

test('SFU selection reports failure when media is unreachable instead of falling back to the master', async () => {
  const sites = [{ id: 'a', url: 'https://a.example.com' }];
  let attempts = 0;
  await assert.rejects(
    selectSfu(sites, async () => {
      attempts++;
      throw new Error('Unavailable');
    }),
    /接続できる/,
  );
  assert.equal(attempts, 1);
});

test('SFU selection rejects invalid RTTs and resolves ties deterministically', async () => {
  const sites = ['b', 'a', 'invalid', 'negative'].map((id) => ({ id, url: `https://${id}.example.com` }));
  assert.equal(
    (await selectSfu(sites, async ({ id }) => (id === 'invalid' ? NaN : id === 'negative' ? -1 : 0))).id,
    'a',
  );
  await assert.rejects(
    selectSfu([], async () => 0),
    /接続できる/,
  );
});

test('the same package supports standalone, master and SFU roles with validated cluster configuration', () => {
  assert.equal(readClusterConfig({}).role, 'standalone');
  const common = {
    SITE_ID: 'tokyo',
    SFU_PUBLIC_URL: 'https://tokyo.example.com',
    CLUSTER_SECRET: 'x'.repeat(32),
    PIPE_ANNOUNCED_IP: '10.0.0.1',
  };
  assert.equal(readClusterConfig({ ...common, ROLE: 'master' }).masterUrl, 'http://127.0.0.1:3000');
  assert.equal(
    readClusterConfig({ ...common, ROLE: 'sfu', MASTER_URL: 'https://master.example.com' }).site.id,
    'tokyo',
  );
  assert.throws(() => readClusterConfig({ ...common, ROLE: 'sfu' }), /MASTER_URL/);
  assert.throws(() => readClusterConfig({ ...common, ROLE: 'master', CLUSTER_SECRET: 'short' }), /CLUSTER_SECRET/);
  assert.throws(
    () => readClusterConfig({ ...common, ROLE: 'master', SFU_PUBLIC_URL: 'https://example.com/path' }),
    /origins/,
  );
});
