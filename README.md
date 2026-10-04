# Eigetsu 映月

Eigetsu is a browser screen-sharing room app. The frontend uses Vite and React, the room-list API uses NestJS, and the media/signaling service uses Socket.IO with mediasoup.

## Local development

Requirements: Node.js 24 or newer, npm, and the native build tools required by mediasoup if a prebuilt worker is unavailable.

```sh
npm install
cd api && npm install && cd ..
cd sfu && npm install && cd ..
npm run dev
```

Open `https://localhost:5173` and trust the local development certificate. Vite serves the frontend and proxies `/api` to NestJS and `/socket.io` to the SFU.

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

## Screen-sharing quality

Screen shares explicitly select H.264 from `device.sendRtpCapabilities`, preserving the negotiated payload type and profile/level, as described in the [mediasoup codec-selection API](https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions). Negotiated Main is preferred, followed by High, then the remaining compatible H.264 profiles. Chromium's [Constrained Baseline acceleration feature](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/webrtc_util.cc) is disabled by default on Windows; selecting the first H.264 capability previously chose that software encoding path even when Main could use the GPU. The SFU advertises Constrained Baseline, Main, and High profiles with packetization mode 1 and level asymmetry allowed. Its advertised level ceiling is 5.2; browser negotiation can select a lower supported level. A sender without compatible H.264 gets an error before the capture dialog opens. The diagnostics panel below each share card shows the actual codec and profile. Hardware encoding depends on the browser, operating system, and GPU; choosing H.264 alone does not guarantee it. When a viewer cannot consume the primary profile but supports Constrained Baseline, the SFU requests a separate compatible stream from the sender. Rebuild both `web` and `sfu`, refresh senders and viewers, and restart existing shares to enable this fallback.

Some iOS/WebKit receivers advertise H.264 Constrained Baseline (`42e0`) and Constrained High (`640c`), but not Main (`4d00`) or ordinary High (`6400`); see this [WebKit SDP report](https://bugs.webkit.org/show_bug.cgi?id=292858). The SFU matches actual profiles and does not relabel a Main stream as Baseline. Compatible video uses a cloned capture track, Constrained Baseline, a 60 FPS / 9 Mbps ceiling, and a scale factor targeting at most 1920x1080 at startup. It may use CPU encoding on Windows and adds sender upload/encoding load only while needed. Compatible viewers share one extra encoder per screen; it closes ten seconds after the last compatible consumer closes, or immediately when the source ends. Normal viewers retain the primary stream, and audio stays linked to the original screen. The fallback is hidden from room listings, so it does not create duplicate cards. A receive failure now shows an error message instead of silently omitting the screen.

For GPU encoding in Chrome, enable graphics acceleration in `chrome://settings/system` and restart the browser. Check `chrome://gpu` for Video Encode hardware acceleration and supported H.264 encoding sizes/frame rates; this describes availability, not proof that the current share uses that encoder. The sender card displays the actual encoder implementation and the browser's power-efficiency report, or an explicit unavailable value when the browser does not expose them. Per the [WebRTC stats specification](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-powerefficientencoder), power efficiency is a hardware-acceleration indicator rather than a guarantee that a particular GPU is in use. `OpenH264` indicates the software implementation. Use `chrome://webrtc-internals` to inspect the current outbound video stream when needed. Standard WebRTC does not offer an application setting to force a GPU or choose NVENC/QSV/AMF. Encoding runs on the sender's browser; this SFU forwards encoded media, so adding a GPU to its Docker container does not enable client GPU encoding. If measured capture FPS is already low, hardware encoding cannot recreate the missing source frames.

Sharing keeps the motion content hint but explicitly sets `degradationPreference: maintain-resolution` for both primary and compatible video. This overrides the hint's default frame-rate preference, following the [W3C content-hint specification](https://www.w3.org/TR/mst-content-hint/#behavior-of-an-rtcpeerconnection). CPU or bandwidth adaptation should preserve resolution, allowing frame rate or image quality to fall instead. If the sender API rejects the preference or is unavailable, the track uses the resolution-oriented `detail` hint as a fallback. Capture requests use the selected width and height as ideal and maximum bounds; a fixed sender scale factor also fits an oversized input within those bounds. The source's aspect ratio is preserved, smaller sources are not upscaled, and resizing the captured window can still change its dimensions. This is a request to prevent adaptive resolution reductions, not a promise of exact preset dimensions on every source or browser.

Bitrate adapts to the connection within the selected preset's ceiling; a high minimum bitrate is not forced. On libwebrtc browsers, the initial codec hint is at most 3 Mbps and the maximum is the preset's ceiling. The RTP ceiling remains in bps; the codec hints are in kbps. These hints are browser dependent and do not guarantee a constant bitrate: static screens can require much less data, and actual throughput depends on the connection and encoder. The encoder can take several seconds to ramp up after sharing starts. These are per-video budgets; audio, retransmissions, transport overhead, additional screens, and any compatible stream add traffic.

Preset bitrate budgets: 4K60 45 Mbps, 4K30 24 Mbps, 1440p60 18 Mbps, 1440p30 12 Mbps, 1080p60 9 Mbps, 1080p30 6 Mbps, 720p60 4.5 Mbps, and 720p30 3 Mbps. These ceilings are 20–25% lower than the previous budgets; actual traffic reduction depends on content and available bandwidth. The preset definitions are shared with the compatible sender and browser bitrate checks.

Each screen has its own video send transport, and shared audio uses a separate send transport. Separate connections keep codec hints independent and prevent another screen's preset from changing them. Send transports are created when sharing starts and closed on stop, failure, or room exit, including on the SFU. With the current UDP/TCP listen configuration, each active send transport uses two SFU ports, plus two ports for each participant's receive transport.

Diagnostic panels show measured bitrate and FPS every two seconds. Normal share cards display them below the card; expanded, fullscreen, and popout players use an optional floating panel. The panel displays sender capture FPS, encoded FPS, average encode time and CPU/bandwidth limitations, or viewer received/decoded/playback FPS, average decode time, packet loss, actual jitter buffer delay, dropped frames and freezes. The panel wraps on narrow screens. Expanded/fullscreen/popout players hide diagnostics initially; use the top diagnostics button to show or hide them. The floating panel can move between the right and left sides, has a close button and scrollable contents, and follows control visibility without reducing the video area. Timing/drop measurements cover the latest sample interval; optional browser fields remain unknown when unsupported. Playback FPS excludes video element drops and is separate from decoder FPS. A static screen can legitimately produce few frames. The preset label describes requested quality, not measured output: 40 Mbps does not establish that 60 frames are being sent or displayed per second. Select a preset before starting a share; restart existing shares to apply a different preset or updated sender settings.

Audio and video receivers request a 100 ms [`jitterBufferTarget`](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget) to give playback some tolerance for uneven packet arrival. This trades some latency for playback stability; the actual buffer is browser-controlled and shown below the viewer card. Browsers without this API keep their default buffering. It cannot restore frames missing from the source or eliminate decoder overload. Expanded/popout views pause other video consumers at the SFU, reducing competing traffic and decoding load. Rebuild `web`, refresh both sender and viewers, and restart the share to apply these client changes.

When sending from a distant network drops FPS, compare the sender's capture FPS, encoded FPS, quality limitation, selected UDP/TCP connection, RTT, estimated upload bandwidth, send queue delay, and SFU-reported loss from the most recent RTCP report. These network details are also below the share card; the viewer's outgoing bandwidth estimate is not shown as a download estimate. A fast sender-to-SFU path does not establish that a different remote path has enough capacity. If TCP is selected, check UDP forwarding/firewall rules first. Raising a preset's bitrate can increase congestion without increasing FPS. The 100 ms viewer buffer addresses viewer-side arrival jitter; it does not repair sender-to-SFU loss or force a source to capture faster.

If Windows 23H2 window sharing gives about 10 FPS while monitor sharing gives about 56 FPS on the same setup, investigate window capture rather than assuming network distance is the cause. The diagnostics panel shows the capture surface (window/monitor/browser tab) alongside measured capture and encoded FPS when available. Chromium's Windows window capture uses WGC, and [WebRTC implemented WGC improvements for Windows 24H2 onward](https://webrtc.googlesource.com/src/+/aaf8f8b89241508585ba4fed256e77fafb465844%5E%21/). That change does not establish the precise cause of this 10 FPS symptom. The web capture API does not expose a WGC/DXGI backend selector. Use the monitor-sharing path that already performs well on that machine, or try browser-tab sharing for browser video; compare again on an updated OS/browser/graphics driver. Network and viewer buffering changes cannot restore frames that the window-capture path never provides.

The SFU's `initialAvailableOutgoingBitrate: 30_000_000` initializes its estimate for the SFU-to-viewer connection. It is neither a browser upload setting nor a fixed bitrate ceiling. The SFU does not configure maximum incoming/outgoing bitrate limits.

Expanded and popout players fit the video within the available area using its original aspect ratio, including in fullscreen. Wide and portrait sources use letterboxing as needed, without stretching or cropping. In expanded views, navigation/fullscreen controls stay above the video and audio/share controls below it; their space stays reserved while hidden. Fullscreen targets the shared-screen player and lets its video fill the entire display. The controls overlay the top and bottom edges in fullscreen, so they leave no reserved space around the video. Both bars appear on entry, hide after two seconds of inactivity, and reappear when the mouse moves. Toggling controls does not resize the video. The cursor also hides while idle and returns on interaction. Tapping the video toggles both bars: one tap reveals them temporarily, a second tap hides them immediately. Control buttons and sliders keep the bars usable during interaction, and keyboard focus keeps them visible. A mouse double-click toggles fullscreen; touch double-taps only toggle the controls.

Run `npm run test:controls` for real-browser checks of expanded/fullscreen/popout layouts, wide/portrait/4:3 sources, mobile widths, floating diagnostic toggles and side placement without video resizing, touch toggling, idle cursor hiding, slider interactions, and keyboard focus. It uses the same ports as the media checks and must run separately. Screenshots are saved in `tmp/player-controls`.

Run `npm test` for sender/receiver configuration and interval stats regression tests. Run `npm run test:bitrate` for a Chromium-to-SFU regression check with synthetic 1080p30, 4K60, and 1440p60 video, concurrent audio, and a second screen with a lower bitrate preset. It verifies H.264 sending, selected bitrate ceilings, motion/resolution settings, unchanged send/receive dimensions at every sample, and browser decoding/playback plus receiver buffer/stats for all three presets. Encoder targets may adapt below the preset ceiling; the check does not force constant payload throughput or guarantee smooth playback on other hardware. Install the root and SFU dependencies first and set `BROWSER_BIN` if Chromium is not in a standard location. The check uses local ports 13000, 15173, and 19222, and SFU media ports 41000-41100.

Run `npm run test:compatibility` for a local browser/SFU check with a Main sender and receivers restricted to the compatible H.264 profile. It verifies actual decoding, concurrent fallback reuse, room listings, idle cleanup, reconnecting viewers, and source closure. Add `-- --gpu` to inspect the primary hardware encoder at the same time. This emulates profile negotiation in Chromium; it is not an iOS-device test.

Run `npm run check:gpu` separately to diagnose the actual sender encoder with GPU-enabled Chromium. It uses synthetic video and a fake camera solely to expose optional hardware stats; it does not access a physical camera. It reports encoder implementations, power-efficiency signals, negotiated profiles, and browser GPU capabilities. A successful command verifies the media path, not hardware use: inspect the actual encoder results. To compare a particular negotiated profile at 1080p30, use `npm run check:gpu -- --gpu-profile=42e0` (Constrained Baseline), `4d00` (Main), or `6400` (High). These profile overrides affect only the test. The regular media tests disable GPU for reproducibility.

## Shared video and music audio

Screen capture explicitly requests no automatic gain control, noise suppression, or echo cancellation, and prefers stereo at 48 kHz. Both the captured track and the new Web Audio output track use `contentHint: music`. Voice processing can alter music; the [W3C content-hint specification](https://www.w3.org/TR/mst-content-hint/) describes these music-specific settings. Unsupported capture constraints and hints remain browser dependent.

The sender uses a stereo Web Audio path with a gain of 1 by default and no compressor or automatic volume normalization. Its Opus configuration requests stereo, a 48 kHz maximum playback rate, and a 256 kbps maximum average bitrate, with discontinuous transmission explicitly disabled and FEC retained. These are [mediasoup codec options](https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions), not guarantees of fixed throughput or lossless audio. The original video's intentional loudness changes are preserved.

The local share's volume slider adjusts the audio sent to everyone. Its mute button silences that outgoing audio, retains the selected volume, and restores it on unmute. Remote viewers' volume and mute controls apply only to their own playback. Local previews do not play the shared audio back to the sender.

For browser video, select its browser tab and enable the capture dialog's audio-sharing checkbox. System/window audio availability depends on the browser and operating system. Restart an existing share after updating to apply these settings.

Run `npm run test:audio` for a Chromium-to-SFU-to-listener check using independent left/right test tones. It verifies received loudness stability, stereo separation, negotiated Opus settings, sender volume changes, and mute/unmute. It shares the bitrate check's ports and must run separately. Synthetic audio verifies the transmission path; actual tab/system capture and listening to music still require a manual browser check.
