# dropcode

Send a file to anyone with a short code, peer to peer, with no accounts.

```
sender:    pick a file (or several)  ->  gets  7-guitar-ocean
receiver:  types 7-guitar-ocean  ->  gets the file
           (or scans the sender's QR code)
```

- **Peer to peer.** File bytes go over a WebRTC data channel, directly between the two
  devices when the networks allow it, otherwise through a TURN relay you control. The
  server only relays connection setup (SDP/ICE) and never sees file data.
- **Authenticated.** The code is the password for a SPAKE2 handshake, and the handshake's
  key confirmation is bound to both peers' DTLS certificate fingerprints. A malicious or
  compromised signaling server cannot read or alter a transfer without guessing the code,
  and it gets at most 3 online guesses before the code is burned.
- **Verified.** SHA-256 of the whole file is checked on arrival.
- **Resumable.** If the connection drops, the transfer picks up where it left off; the CLI
  receiver can even resume after being killed.
- **Browser and CLI.** A static web page, and a Go CLI that interoperates with it in both
  directions.

See [DECISIONS.md](DECISIONS.md) for the design and security reasoning.

## Repository layout

| Path | What |
| --- | --- |
| `server/` | Signaling server (Node 22 + TypeScript + `ws`): rooms, TTLs, rate limits, static files |
| `web/` | Web client (vanilla TypeScript, bundled with esbuild); `zip.ts` bundles multiple files, `qr.ts` renders the share link as a QR code |
| `cli/` | Go CLI (`pion/webrtc`) |
| `pake/` | SPAKE2 WebAssembly module (Rust, RustCrypto `spake2`) shared by web and CLI |
| `shared/` | Word list, built `pake.wasm`, key-confirmation test vectors |
| `e2e/` | Playwright end-to-end scenarios (two browsers, CLI interop, MITM, resume) |

## Local development

Requirements: Node 22+, and Go 1.24+ for the CLI. Rust is only needed to rebuild
`shared/pake.wasm`; the built module is committed.

```sh
npm install
npm run dev            # builds web + server, serves on http://localhost:8080
```

Open http://localhost:8080 in two browser windows (or two devices on your network): pick
a file in one, type the code in the other.

The CLI:

```sh
npm run build:cli                        # -> cli/bin/dropcode
cli/bin/dropcode send ./photo.jpg        # prints a code
cli/bin/dropcode receive 7-guitar-ocean  # saves into the current directory
```

`-server https://your.host` (or `DROPCODE_SERVER`) selects the server; the default is
`http://localhost:8080`. The CLI and the web page interoperate either way round. An
interrupted `receive` resumes when you run the same command again while the sender is
still waiting.

### Tests

```sh
npm test               # vitest: server rooms/TTL/pairing/rate limits/validation, protocol, SPAKE2 + confirmation
npm run test:cli       # go vet + go test -race (PAKE, confirmation vectors, protocol, partial files)
npm run test:pake      # Rust unit tests for the wasm wrapper
npm run build && npm run build:cli && npm run e2e   # end-to-end, headless Chromium
```

`npm run e2e` runs 21 scenarios against a real server. They include:
- a 50 MB browser-to-browser transfer with hash check, drag and drop;
- every error state, cancel from either side;
- wrong codes and burning after 3 attempts;
- a man-in-the-middle signaling server with a third browser relaying the data channel
  (it must be detected);
- resume after link loss or signaling loss;
- CLI ↔ browser in both directions, and a CLI receiver killed with `SIGKILL` and resumed.

Run a subset by name, e.g. `node e2e/run.mjs basic mitm`. `E2E_DEBUG=1` prints the
pages' console logs.

To rebuild the PAKE module (requires rustup; the toolchain is pinned in
`pake/rust-toolchain.toml`): `npm run build:pake`.

## Configuration

All configuration is through environment variables on the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address |
| `TRUST_PROXY` | (off) | `fly` = use `Fly-Client-IP`; `xff` = left-most `X-Forwarded-For`. Only set this behind a proxy that sets the header, otherwise clients can dodge the rate limits. |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs; empty to disable |
| `TURN_URL` | (unset) | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349` |
| `TURN_SECRET` | (unset) | coturn `static-auth-secret`: the server mints a short-lived username/password per client (recommended) |
| `TURN_CLOUDFLARE_KEY_ID`, `TURN_CLOUDFLARE_API_TOKEN` | (unset) | Cloudflare Realtime TURN. Set both and the server mints credentials from Cloudflare's REST API and appends their relays to `TURN_URL`'s; no `TURN_URL` needed. |
| `TURN_USER`, `TURN_PASS` | (unset) | Static TURN credentials, used if `TURN_SECRET` is not set |
| `TURN_CREDENTIAL_TTL` | `3600` | Lifetime in seconds of minted TURN credentials |
| `ICE_TRANSPORT_POLICY` | `all` | `relay` forces every transfer through TURN, so peers never learn each other's IP addresses |
| `ROOM_TTL_MS` | `600000` | How long a code waits for a receiver |

With TURN unset the app works with direct and STUN-assisted connections only. Peers
behind symmetric NATs or strict firewalls then fail with "Couldn't open a direct
connection… a TURN relay may be needed".

## Deploying

### Docker

```sh
docker build -t dropcode .
docker run -p 8080:8080 -e TURN_URL=... -e TURN_SECRET=... dropcode
```

The image runs as the unprivileged `node` user. It contains only the bundled server
(including `ws`) and the static web files, with no `node_modules`. Browsers only allow
WebRTC and clipboard access from secure origins, so serve it over HTTPS (any reverse
proxy) except on `localhost`.

### Docker Compose with coturn (single VPS)

```sh
cp .env.example .env      # set PUBLIC_IP and TURN_SECRET (openssl rand -hex 32)
docker compose up -d --build
```

This runs dropcode on `:8080` and coturn on `3478/udp+tcp` with relay ports
`49160-49200/udp`. Open those ports in your firewall. coturn:
- uses `use-auth-secret`, so credentials are minted per client by the server;
- refuses to relay to private, loopback and link-local addresses, so the relay can't be
  used to reach your internal network;
- caps allocations per user and in total.

Put TLS in front of `:8080` (Caddy, nginx, Traefik) and set `TRUST_PROXY=xff`.

### Fly.io

Rooms live in memory, so the server must run as **exactly one machine** that never
auto-stops. `fly.toml` is set up that way.

```sh
fly launch --no-deploy --copy-config      # pick an app name; keep the existing fly.toml
fly scale count 1
fly secrets set TURN_URL="turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp" \
                TURN_SECRET="$(openssl rand -hex 32)"   # same secret as your coturn
fly deploy
```

Fly terminates TLS and adds `Fly-Client-IP`, which `TRUST_PROXY=fly` (already in
`fly.toml`) uses for rate limiting. The server only relays a few kilobytes of signaling
per transfer, so a small machine goes a long way (not load-tested).

### Configuring TURN

TURN is what makes transfers work across symmetric NATs and corporate firewalls. It
relays the (still DTLS-encrypted) data, so it costs bandwidth. Options:

1. **coturn on a small VPS** (recommended with Fly.io, whose UDP support doesn't suit
   TURN's port ranges). Run only the TURN part of the compose file:
   `docker compose up -d coturn`, with `PUBLIC_IP` and `TURN_SECRET` in `.env`. Then
   point the server at it with `TURN_URL=turn:<PUBLIC_IP>:3478?transport=udp,turn:<PUBLIC_IP>:3478?transport=tcp`
   and the same `TURN_SECRET`.
2. **Cloudflare Realtime TURN** (no VPS, works from cellular). Create a TURN key at
   *dash.cloudflare.com -> Realtime -> TURN Keys* and set `TURN_CLOUDFLARE_KEY_ID` and
   `TURN_CLOUDFLARE_API_TOKEN`. Unlike coturn, it mints credentials through its own REST
   API, so the server fetches them at startup and re-mints shortly before they expire; one
   set is shared by all clients. If the API is unreachable the server logs
   `turn_mint_failed`, serves STUN only, and retries after 30s. The first 1,000 GB/month
   are free (shared with the Realtime SFU), then $0.05/GB.
3. **Another managed TURN service** (Twilio, Metered, …) issuing static credentials: set
   `TURN_URL`, `TURN_USER`, `TURN_PASS`.
4. **TLS on 443** for the most restrictive networks. Give coturn a certificate (`cert=`,
   `pkey=`, `tls-listening-port=443`) and add a `turns:turn.example.com:443?transport=tcp`
   URL.

To check that TURN works, set `ICE_TRANSPORT_POLICY=relay` temporarily: every transfer
must then succeed through the relay or fail. The e2e suite does exactly this against the
compose stack:

```sh
E2E_SERVER_URL=http://127.0.0.1:8080 E2E_EXPECT_RELAY=1 node e2e/run.mjs basic cli-to-web web-to-cli
```

## Limits and known gaps

- The browser receiver buffers the file in memory (2 GB cap); use the CLI for larger
  files. Browser resume survives connection loss but not a page reload.
- Several files can be sent at once: the browser bundles them into a stored (uncompressed)
  zip and the receiving browser expands it again, so the receiver saves the original files
  individually, all at once through the system share sheet where one is available, or keeps
  the `.zip`. One file is sent as itself, with no wrapper. The bundle is capped at 4 GB by
  zip's 32-bit fields, and counts against the browser receiver's 2 GB memory limit.
  The protocol still carries exactly one file, so there is no per-file progress, and a CLI
  receiver saves the `.zip` rather than its contents. Folders must still be zipped first.
- Server state is in memory: a restart drops waiting codes, and the server can't be
  horizontally scaled without shared room state.
