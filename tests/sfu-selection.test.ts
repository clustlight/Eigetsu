import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSfu } from '../src/sfu-selection.ts';
import { readClusterConfig } from '../sfu/cluster-config.ts';

test('SFU selection ignores connection setup and uses a median rather than an isolated fast response', async () => {
  const sites = ['a', 'b', 'offline'].map((id) => ({ id, url: `https://${id}.example.com` }));
  const timings = new Map([
    ['a', [900, 8, 9, 8]],
    ['b', [2, 1, 30, 32]],
    ['offline', []],
  ]);
  const selected = await selectSfu(sites, async ({ id }) => {
    const elapsed = timings.get(id)?.shift();
    if (elapsed === undefined) throw new Error('Unavailable');
    return elapsed;
  });
  assert.equal(selected.id, 'a');
  assert.equal(selected.rttMs, 8);
});

test('SFU selection excludes sites without two successful samples and reports total failure', async () => {
  const sites = [{ id: 'a', url: 'https://a.example.com' }];
  let attempts = 0;
  await assert.rejects(
    selectSfu(sites, async () => {
      if (++attempts === 2) return 1;
      throw new Error('Unavailable');
    }),
    /接続できる/,
  );
  assert.equal(attempts, 4);
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
