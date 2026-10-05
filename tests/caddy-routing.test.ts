import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const configurations = [
  ['standard', new URL('../docker/Caddyfile', import.meta.url)],
  ['Cloudflare', new URL('../docker/Caddyfile.cloudflare', import.meta.url)],
] as const;

for (const [name, url] of configurations) {
  test(`${name} Caddy config proxies API, signaling, and SFU routes before the SPA fallback`, () => {
    const config = readFileSync(url, 'utf8');
    const routes = [
      ['api', 'api:3001'],
      ['socket.io', 'sfu:3000'],
      ['sfu', 'sfu:3000'],
    ] as const;

    for (const [path, upstream] of routes) {
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const route = new RegExp(`handle\\s+/${escapedPath}/\\*\\s*\\{\\s*reverse_proxy\\s+${upstream}\\s*\\}`, 'm');
      assert.match(config, route, `/${path}/* must proxy to ${upstream}`);
      assert.ok(
        config.indexOf(`handle /${path}/*`) < config.indexOf('handle {'),
        `/${path}/* must precede the SPA fallback`,
      );
    }

    assert.match(config, /try_files\s+\{path\}\s+\/index\.html/);
  });
}
