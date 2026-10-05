# Docker deployment

The production stack separates static React assets, the NestJS API, and the mediasoup SFU:

```text
Browser ── HTTPS / WebSocket ── Caddy ── React assets
                                  ├──── NestJS API ── room-list API ── SFU
                                  └──── Socket.IO ─────────────────── SFU
```

The NestJS API serves the room list through the internal SFU endpoint. Socket.IO signaling and WebRTC media remain in the dedicated Node.js mediasoup SFU service. The API and SFU use distroless Node.js runtime images. Caddy includes its Cloudflare DNS provider module.

## Multiple sites with one package

Distribute the same repository/Compose package and the same `latest` images to all sites. Use a different `.env` on each host. The existing three services (`web`, `api`, `sfu`) run at every site; only the SFU's runtime role differs. Exactly one site uses `ROLE=master` (room coordinator plus local SFU), and the others use `ROLE=sfu`. The default `ROLE=standalone` needs no other site.

Example master site settings, in addition to your TLS settings:

```dotenv
ROLE=master
SITE_ID=tokyo
SITE_ADDRESS=tokyo.example.com
SFU_PUBLIC_URL=https://tokyo.example.com
MEDIASOUP_ANNOUNCED_IP=203.0.113.10
PIPE_ANNOUNCED_IP=10.20.0.10
CLUSTER_SECRET=<same-long-random-secret-at-all-sites>
RTC_MIN_PORT=40000
RTC_MAX_PORT=40999
```

Example second site, using the same images and Compose file:

```dotenv
ROLE=sfu
SITE_ID=osaka
SITE_ADDRESS=osaka.example.com
SFU_PUBLIC_URL=https://osaka.example.com
MASTER_URL=https://tokyo.example.com
MEDIASOUP_ANNOUNCED_IP=203.0.113.20
PIPE_ANNOUNCED_IP=10.20.0.20
CLUSTER_SECRET=<same-long-random-secret-at-all-sites>
RTC_MIN_PORT=40000
RTC_MAX_PORT=40999
```

The addresses above are examples; substitute reachable addresses. Generate the cluster secret once, for example with `openssl rand -hex 32`, and copy it securely to each host. It must be at least 32 characters. The secret authenticates the server-only Socket.IO `/cluster` namespace and is never sent to browsers. A duplicate connected `SITE_ID` is rejected. Keep all sites on the same release; cluster protocol version 1 is checked on registration.

Run `docker compose up --build -d` at each site, or pull the published release images and run `docker compose up -d`. The master may start first; other sites retry their configured `MASTER_URL` until it is available. Add the existing Cloudflare Compose override when using DNS validation. Ordinary HTTP reverse proxies carry web pages and signaling, not the SFU UDP media ports.

Network requirements:

- Every browser must reach the individual `SFU_PUBLIC_URL` origins over HTTPS. These must route to the named site, not to a CDN-cached ping response or an arbitrary SFU. Caddy exposes `/sfu/sites`, `/sfu/ping` and `/socket.io/`; probe responses disable caching and allow cross-origin reads.
- `MEDIASOUP_ANNOUNCED_IP` is the address reachable by browsers for WebRTC. For a private installation this can be a routed LAN/VPN address. HTTPS reachability alone does not establish UDP reachability.
- Each edge must reach `MASTER_URL` over HTTPS/WSS. The master relays control messages over this persistent authenticated connection; edges do not need a separate inter-site HTTP API exposed.
- `PIPE_ANNOUNCED_IP` is a numeric IP reachable by the other SFUs, typically on a site-to-site VPN. Allow UDP in the configured RTC port range between all participating SFUs and preserve port numbers through NAT. Pipe media uses SRTP encryption and RTX/NACK retransmission on both ends. WebRTC also uses UDP/TCP in this range. The two announced addresses may differ.
- Allocate enough ports: a WebRTC transport currently occupies a UDP and a TCP port; each exported or imported stream variant occupies one additional UDP port. This implementation shares a pipe across viewers at a site, but uses separate pipes for separate source streams, audio and compatibility variants.

The browser selects its SFU once on joining, using one warmup and three timed HTTP requests per candidate. It compares the median of at least two successful samples. A slow or unreachable candidate is excluded. This measures application round-trip time, not available bandwidth or actual UDP RTT. Selection does not run again on a connected session or on automatic reconnection. If the selected SFU is unavailable, the browser retries that same site; it does not fail over to another site. After a signaling disconnect, existing local captures stop and must be started again. An explicit leave followed by a new join starts a new selection.

The `sfu_data` volume stores the master's room/participant/stream metadata at `/app/sfu/data/rooms.json`; media transport state remains in the SFU processes. Native deployments can set `MASTER_STATE_FILE` to a writable path. Metadata is written using a temporary file and rename; an unwritable path or invalid state file fails startup. Back up the master volume if room continuity matters. This is one coordinator, with no automatic master election or database replication.

On a control outage, established SFU-to-SFU media can continue while the relevant SFU processes and media routes stay alive. New room operations and new inter-site subscriptions require the master. After restart, the master reloads persisted metadata and each SFU confirms its current local participants/streams; unconfirmed sites expire after 30 seconds. Site disconnections also have a 30-second metadata grace period, while disconnected sites are immediately excluded from new RTT selections. Loss of the SFU process itself loses its transports, and clients reconnect to that same site. An empty logical room is retained for five minutes. `/health` reports HTTP 503 while a site is waiting for the coordinator; it is a readiness check, not proof that established media has failed.

Room listing and diagnostic endpoints under `/internal/` stay on the private SFU HTTP service and are not proxied by Caddy. `/internal/cluster` reports active incoming/outgoing pipe counts, consumer counts and transport statistics for operations and the local integration tests; do not expose the SFU HTTP port directly to the Internet. Room access retains the application's existing public room-code model; the cluster secret is not end-user authentication.

### Connection information and cluster statistics

While in a room, the connection panel shows the selected SFU ID and URL, the original selection RTT, current signaling RTT, master connection readiness, and each WebRTC transport's state, protocol and RTT. It refreshes approximately every three seconds. Selection RTT is an HTTP measurement taken only at entry; signaling RTT and WebRTC RTT are separate live measurements. A transport awaiting its first media exchange has no measured WebRTC RTT. The cluster statistics link opens a separate tab so the current room stays connected.

Open `/cluster` on any site's UI, or use the link in the room list, for cluster statistics. `/sfu/statistics` retrieves a snapshot through the existing authenticated coordinator connection. The coordinator queries all registered SFUs concurrently and shares a cached result for five seconds across viewers. No new environment variables, ports or direct inter-site HTTP access are required. Use the same release at all sites.

The page shows known SFUs (including disconnected ones), active room and participant connection counts, source track counts, client and inter-site traffic, Node.js RSS, and mediasoup worker CPU and peak RSS. Traffic directions are relative to the SFU. Byte counts sum currently existing transports and can decrease when transports close; they are not historical totals. Worker CPU is sampled between refreshes (one CPU core = 100%) and is unavailable on the first sample. These are SFU process metrics, not total host CPU or memory. Global room counts are deduplicated by the coordinator; per-site room counts must not be summed. Separate viewer windows count as separate participant connections.

The statistics page and its read-only endpoint have the same public access model as the existing UI. Responses contain aggregate measurements and public site URLs, without cluster secrets, pipe addresses, participant names or room IDs. Per-site timeouts appear as unavailable rather than zero load. If the master or the UI site's SFU cannot be reached, the page keeps the last snapshot, marks it stale, and retries; it does not interrupt an existing media session. There is no historical metrics storage.

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

The Compose file uses `ghcr.io/clustlight/eigetsu-{web,api,sfu}:latest` directly. Authenticate with GHCR if the packages are private, then pull and start the images:

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
