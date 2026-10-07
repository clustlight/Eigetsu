# Eigetsu 映月

Eigetsu is a browser screen-sharing room app. The frontend uses Vite and React, the room-list API uses NestJS, and the media/signaling service uses Socket.IO with mediasoup.

## Local development

Requirements: Node.js 24 or newer and npm.

```sh
npm install
cd api && npm install && cd ..
cd sfu && npm install && cd ..
npm run dev
```

Vite serves the frontend and proxies API and signaling requests to the local services.

Application sources, Vite configuration, and test scripts use TypeScript. React components use `.tsx`. Development and Node test scripts run `.ts` files directly with Node.js 24; the frontend and SFU build commands also check their types.

```sh
npm run typecheck
npm test
npm run build
npm --prefix sfu run build
```

To run the compiled SFU separately, use `npm --prefix sfu start` after building it. Its entry point is `sfu/dist/index.js`.

## Production

Use Docker Compose to build and start the static frontend, NestJS API, mediasoup SFU, and Caddy reverse proxy:

```sh
docker compose up --build -d
```

For Cloudflare DNS validation with Let's Encrypt, configure `.env` and add `docker-compose.cloudflare.yml`. See [DEPLOYMENT.md](DEPLOYMENT.md) for network, TLS, and Cloudflare token setup.

## Multiple sites

The same web, API and SFU images run at every site. Set `ROLE=master` at one site and `ROLE=sfu` at the others; the master site also serves local WebRTC clients. `ROLE=standalone` remains the default for a single installation. Site IDs, public HTTPS origins, master URL, shared cluster secret and inter-site media addresses are runtime configuration, with no site-specific builds. See [the multi-site deployment instructions](DEPLOYMENT.md#multiple-sites-with-one-package).

The master owns room IDs, names, participants, stream announcements and each participant's assigned site. Before joining, browsers open a temporary WebRTC data channel to each available SFU and choose the lowest selected ICE candidate-pair RTT. Probes use the same addresses and UDP/TCP preference as room media, without capture permissions or room membership. HTTPS setup time and the master's role do not affect ranking. Unreachable media endpoints are excluded; a failed probe does not fall back to HTTP ranking. The selected endpoint is fixed for the room session: no automatic migration and no Anycast are used. A signaling disconnect retries the same site, recreates the room's transports and stops existing screen captures; the user must start sharing again. Leaving and joining a new session runs selection again.

Browsers send and receive media through their selected SFU. A destination SFU requests a stream only when one of its local clients consumes it. All clients at that site share one SRTP/RTX PipeTransport stream for each source/codec variant; each subscribed site receives its own copy. Audio and compatible H.264 video are separate streams. When every local video consumer pauses, the origin pauses that inter-site stream. When the last consumer closes, both sides release the pipe. Room metadata and pipe setup travel through the master; RTP travels directly between SFUs and does not require the master site as a relay.

## Deployment diagrams

### Standalone

One site runs the web frontend, API and SFU. The SFU also manages rooms locally; no cluster connection or inter-site media pipe is used.

```
 Browser
   | HTTPS: load UI and signaling
   v
+--------------------------- Single site -----------------------------+
|                                                                     |
|  +-------------+  /api  +-------------+  room queries  +---------+  |
|  | web / Caddy |------->| API         |--------------->| SFU     |  |
|  | UI + proxy  |        | room list   |                | room    |  |
|  +------+------+        +-------------+                | manager |  |
|         | /socket.io and /sfu                          | + media |  |
|         +--------------------------------------------->|         |  |
|                                                        +----+----+  |
+---------------------------------------------------------------------+

 Browser <=============== WebRTC media: UDP / TCP ===============> SFU
```

### Cluster

Each site runs the same web, API and SFU services. The master role is on one site's SFU; other SFUs keep an authenticated control connection to it. Clients probe the registered SFUs and signal the selected site directly. Media for a remote participant crosses between the relevant SFUs; the master does not relay media.

```
                          Browser
                            |
                       load UI (any site)
                            v
+------------------------ Site A: ROLE=master ------------------------+
|  +-------------+  /api  +------+  room queries  +----------------+  |
|  | web / Caddy |------->| API  |--------------->| SFU + master   |  |
|  | UI + proxy  |        +------+                | room manager   |  |
|  +------+------+                                | + media        |  |
|         | /socket.io and /sfu                   +--------+-------+  |
+---------|-------------------------------------------------|---------+
          |                                                 |
          |                           authenticated control |
          |                           room and stream state |
          |                                                 v
+-------- |--------------- Site B: ROLE=sfu ----------------|---------+
|  +------v------+  /api  +------+  room queries  +--------+-------+  |
|  | web / Caddy |------->| API  |--------------->| SFU            |  |
|  | UI + proxy  |        +------+                | media          |  |
|  +-------------+                                +----------------+  |
+---------------------------------------------------------------------+

 RTT probes: Browser -------------------------------> each site's SFU
 Signaling:  Browser -------------------------------> selected SFU
 WebRTC:     Browser <==============================> selected SFU
 Media pipe: Site A SFU <===========================> Site B SFU
             SRTP / RTX only while a remote site has subscribers
```

Run `npm run test:cluster` for the multi-site integration check and `npm run test:cluster-ui` for initial playback, expansion and switching between shares from another site. `npm test` covers SFU selection, probe cleanup, first-frame recovery and coordinator behavior.

## Screen sharing and audio

Screen sharing negotiates a compatible H.264 profile and adapts video quality to the selected preset and available connection. Each share has independent transport and quality settings. The UI reports measured capture, encoding, playback, and connection information where the browser provides it. Actual image quality and performance vary with the source and connection.

Within each SFU, each screen has its own mediasoup router. Its audio and compatibility video use the same router and worker, including local viewers. New screens go to the worker with the fewest assigned screen groups across all rooms; simultaneous allocations are counted before router creation completes. Receiving sites also group a remote screen and its audio on one worker, sharing the inter-site stream among viewers. Idle screen routers are released after their transports close. The room router is retained for capability negotiation and legacy clients.

Set `MEDIASOUP_WORKERS=2` (or another count up to the available CPU cores) to enable distribution. The default remains `1`. This balances screen counts, not measured CPU or bitrate, and does not migrate active screens or split one screen's viewers across workers. Browser receive transports are now separate per track, so connections and ports grow with viewed tracks. Deploy the frontend and SFU together and reload existing browser sessions to use screen routing.

Shared audio uses a separate stereo audio track. The sender can adjust or mute the audio for everyone; each viewer controls their own playback volume and mute state.

Run `npm run test:bitrate` to check video sending and playback, `npm run test:audio` for audio, and `npm run test:controls` for room and player controls.
