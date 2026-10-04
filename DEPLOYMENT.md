# Docker deployment

The production stack separates static React assets, the NestJS API, and the mediasoup SFU:

```text
Browser ── HTTPS / WebSocket ── Caddy ── React assets
                                  ├──── NestJS API ── room-list API ── SFU
                                  └──── Socket.IO ─────────────────── SFU
```

The NestJS API serves the room list through the internal SFU endpoint. Socket.IO signaling and WebRTC media remain in the dedicated Node.js mediasoup SFU service. The API and SFU use distroless Node.js runtime images. Caddy includes its Cloudflare DNS provider module.

## Image builds

The Dockerfiles use BuildKit cache mounts for npm and the Caddy Go build. Base image tags are pinned to current patch versions: Node `26.9.0` and Caddy `2.11.6` on Alpine for the web runtime. The API runtime contains production dependencies and compiled JavaScript. The SFU runtime contains production dependencies and the mediasoup worker binary; Python, compilers, worker sources, and build artifacts stay in the build stage. Local `node_modules`, build outputs, and temporary files are excluded from the build context.

Rebuild with `--pull` periodically to fetch refreshed base-image layers, then scan the resulting images with Docker Scout or another image scanner. Patch-version tags make the selected upstream release clear, but they do not guarantee that an image has no reported vulnerabilities.

Frontend and SFU sources are TypeScript. The Web build checks types before Vite bundles `src/main.tsx`. The SFU build compiles `sfu/index.ts` to `dist/index.js`, then removes development dependencies before copying production dependencies to the distroless runtime. Neither the TypeScript compiler nor the TypeScript source files are included in the SFU runtime.

mediasoup first attempts to download a prebuilt worker. If it is unavailable or incompatible, it builds from source. The SFU build stage installs `python3`, `python3-pip`, `build-essential`, and CA certificates for this fallback, as described in the [mediasoup installation requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/). Meson and Ninja are installed by mediasoup through pip; no system-wide pip upgrade is needed.

To explicitly compile the worker from source:

```sh
docker compose build --build-arg MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true sfu
```

To apply rebuilt images, run `docker compose up -d` (with the Cloudflare override if used).

## Publish and run images from GHCR

In GitHub, open **Actions → Publish container images → Run workflow** and enter a SemVer such as `1.2.3` or `1.2.3-rc.1` without a leading `v`. The workflow publishes `ghcr.io/<owner>/eigetsu-web`, `eigetsu-api`, and `eigetsu-sfu` with that version tag. Stable versions also update `latest`; prereleases do not. Images are built for `linux/amd64`.

On the deployment host, set `GHCR_OWNER` to the lowercase GitHub owner and `IMAGE_TAG` to the version in `.env`. Authenticate with GHCR if the packages are private, then pull and start the images:

```sh
docker login ghcr.io -u YOUR_GITHUB_USERNAME
docker compose pull
docker compose up -d
```

The publish workflow uses the repository-provided `GITHUB_TOKEN`; no registry password or application environment values are needed during image builds. Set runtime values such as `SITE_ADDRESS`, `MEDIASOUP_ANNOUNCED_IP`, and `CF_API_TOKEN` only in the deployment host's `.env`.

## Start with automatic HTTPS

1. Copy `.env.example` to `.env`.
2. Set `SITE_ADDRESS` to a hostname that resolves to this server.
3. Set `MEDIASOUP_ANNOUNCED_IP` to the server's public IPv4 address.
4. Build from refreshed base images and start the stack:

```sh
docker compose build --pull
docker compose up -d
```

Caddy obtains and renews a certificate using the regular ACME HTTP/TLS challenge. For local evaluation, use `SITE_ADDRESS=localhost`; Caddy uses its local certificate authority.

## Use Cloudflare DNS for Let's Encrypt

Create a Cloudflare API token restricted to the zone with `DNS:Edit`. Set `SITE_ADDRESS` and `CF_API_TOKEN` in `.env`, then start with the Cloudflare Caddyfile:

```sh
docker compose -f docker-compose.yml -f docker-compose.cloudflare.yml build --pull
docker compose -f docker-compose.yml -f docker-compose.cloudflare.yml up -d
```

Caddy uses the ACME DNS-01 challenge and renews the certificate automatically. The API token is supplied through the environment, not stored in the Caddyfile.

## Network requirements

- Allow inbound TCP ports 80 and 443 to Caddy.
- Allow and forward the configured mediasoup UDP and TCP port range, `40000-40100` by default. Increase `RTC_MAX_PORT` for larger rooms or more concurrent transports.
- Set `MEDIASOUP_ANNOUNCED_IP` to the public address reachable by remote browsers. WebRTC media connects directly to mediasoup; the ordinary Cloudflare DNS proxy does not carry these ports.

If a remote sender has low FPS despite high bitrate, read the diagnostics below the sender's card to inspect the selected UDP/TCP connection, RTT, estimated upload bandwidth, SFU-reported packet loss, capture/encoded FPS, and CPU/bandwidth limitation. Compare these on the affected network. A TCP connection can indicate UDP is blocked along that path; verify the entire configured UDP range reaches the SFU. Caddy/Cloudflare TLS configuration controls the page and signaling, so changing it does not tune the direct media path. After client quality/buffering changes, rebuild `web`, refresh the sender and viewers, and restart sharing.

For local development, `npm run dev` starts Vite, NestJS, and the SFU. The frontend uses Vite proxies for `/api` and `/socket.io`.

For iOS-compatible H.264 viewing, rebuild both `web` and `sfu`, then refresh all browsers and restart existing screen shares. Updated senders advertise on-demand Constrained Baseline fallback support; existing Main-only shares must be restarted. Use your usual Compose file combination, including `docker-compose.cloudflare.yml` if deployed with Cloudflare DNS. The fallback targets 1080p at 60 FPS (up to 9 Mbps) and adds one shared encoder/upload per screen only when a viewer cannot consume the primary profile.
