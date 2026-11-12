# The Worker's internals: R2, the Switch DO's routes, the /lan hand-over

What the Worker (src/worker.js, src/http/) expects of its bindings and of the Switch Durable Object (src/switch/do.js),
and what it sends it.  The routes are ports of web/server-rs/src/app (mod.rs, files.rs, manifest.rs, blocks.rs,
wasm.rs, lan.rs, names.rs, friends.rs); their status codes, headers and bodies are Rust's (test/e2e/http.diff.mjs
compares them end to end).

## Bindings and variables

| name | what |
|---|---|
| `GAME` | R2 bucket `nfsu2-machines-game`: the game's files and the module (below). Absent or empty: those routes answer 404 as Rust does for a missing file. |
| `ASSETS` | the static assets: the built page, `web/dist` (`web/build.mjs`). `run_worker_first: true`, `html_handling: "none"`, `not_found_handling: "none"`: the Worker asks for exact files and answers `/` -> `/index.html` and 404 itself. `web/dist-dev` (test pages, source maps; Rust's `--dev`) is not served. |
| `SWITCH` | the Switch Durable Object namespace; the Worker uses `idFromName('switch')`. |
| `ETAG_KEY` (secret) | hex, 16 bytes or more: the ETag key (Rust's `state/etag.key`). Missing: a random key per isolate (ETags then differ between isolates). |
| `LAN_ID_KEY` (secret) | hex, 16 bytes or more: the key of the /lan group and site ids (Rust's `group_key`, random at each start). Must be the same in every isolate, or one client counts as several. Missing: random per isolate. |
| `HOSTS` | the names the server answers for, comma-separated (Rust's `--host`; `*.zone` for one label under it). localhost, 127.0.0.0/8 and ::1 always. A request for another name gets 421. |
| `HSTS` | `off`: no Strict-Transport-Security. Otherwise it is sent over https for a name that is not localhost or an IP literal (Rust's `hsts_ok` behind a TLS proxy). |
| `NAMES`, `FRIENDS` | `on`: /names, /friends go to the Switch DO. Otherwise 404 at once (Rust without keyphrase saves / without the Online host). |
| `COUNTRY_FROM` | `header`: /country and the /lan country read the `CF-IPCountry` header (tests, local runs). Otherwise `request.cf.country`, then the header. |

## R2 layout

| key | what | customMetadata |
|---|---|---|
| `data/<path>` | each file of the install folder that the game reads, `<path>` as in the folder (case kept). Only the GAME_ENTRIES at the top are ever served or listed; dot names are never. | `mtimeMs`: Node's `String(fs.statSync(f).mtimeMs)` (the manifest's `m` and the ETag; else the upload time). `path`: optional, the path the ETag names (else `r2:<key>`). |
| `game.wasm` | the module as built (`out/web/nfsu2.wasm`) | `mtimeMs`, `path` as above |
| `game.wasm.br` | the module compressed with brotli, quality 5, size hint its length (what wasm.rs makes at start) | `hash`: base64url of SHA-256 of game.wasm, first 22 characters; `size`, `mtimeMs`: those of the game.wasm it was made from. When they do not match game.wasm, the module is sent as it is (as Rust before its compression is done). |
| `game.json` | `out/web/nfsu2.json` | `mtimeMs`, `path` |

The manifest (/data-manifest) is built from the `data/` listing (R2 `list` with `customMetadata`) at its first
request in an isolate, and again on `?refresh` at most every 10 s, byte for byte as manifest.rs writes it for the same
files, sizes and times (folders are the paths' prefixes; a folder with no file under it is not in R2).

## Internal requests to the Switch DO

The Worker calls `env.SWITCH.get(env.SWITCH.idFromName('switch')).fetch(request)` with these URLs.  Every one but
`/seen` and the /lan upgrade expects an **answer**: a 200 response with `content-type: application/x-nfsu2-answer+json`
whose body is the JSON of

    {"status": 200, "type": "application/json" | "text/plain; charset=utf-8" | null,
     "body": "<text>" | null, "headers": [["retry-after", "60"], ...], "cache": "store", "noindex": true}

(`state_routes.js internalResponse(answer)` makes it; the Worker adds the security and cache headers, content-type,
content-length and drops the body for HEAD: `routes.js answerResponse`).  Any other reply is a 500 for the client.

Headers on every internal request: `x-nfsu2-ids: {"key": "1.2.3.4" | "2001:db8:1:200::/56" | "", "siteKey":
"2001:db8:1::/48" | "", "group": "<22 chars>", "site": "<22 chars>" | ""}` (key, siteKey: the client's address key and
site key as Rust computes them, what its budgets and rates count by: headers.js addressKey / siteKey of CF-Connecting-IP;
group, site: those under HMAC-SHA256 with LAN_ID_KEY, base64url, 22 characters: Rust's `group_id(key)` and
`group_id("site " + site)`), `x-nfsu2-own-page: 1 | 0` (mod.rs `own_page`), `x-nfsu2-method` (the client's method: GET and HEAD are
sent as GET), and the client's `authorization`, `content-type`, `sec-fetch-site`, `content-length` when present.
`state_routes.js internalRequestInfo(request)` and `internalReq(request, maxBody)` read them.

| URL | when | the DO answers with |
|---|---|---|
| `https://switch/players?<the client's query>` | GET/HEAD /players | `playersAnswer(st, url.searchParams)`, st = {players: peer count, full, queue: pages in line, online: {personas, racing} or null, roam: the hub's counts or null} (mod.rs send_players) |
| `https://switch/lan-check` | GET/HEAD /lan without an upgrade, from one of the server's own pages (another site's page: the Worker answers `{"lan":"page"}` itself, Rust's first test) | `lanCheckResponse(gate.check(info.key, info.siteKey, nowMs))`, info = `internalRequestInfo(request)` |
| `https://switch/seen?<query>` | GET /seen with `at=page` or `at=play` and an `id` (after the Worker answered 204, in `ctx.waitUntil`) | anything (ignored); it calls `seenCall(days, url.searchParams, 'GET', nowMs)` with the day's counts (days.rs Days: `seen(id, what, now)`, `told(id, report, now)`) |
| `https://switch/names?<query>` | any method on /names, with `NAMES=on` | `await namesAnswer(namesRoute, await internalReq(request, NAMES_MAX_BODY), nowMs)` (`namesRoute`: a `NamesRoute` over the claims port, or null for 404) |
| `https://switch/friends?<query>` | any method on /friends, with `FRIENDS=on` | `await friendsAnswer(friendsRoute, await internalReq(request, FRIENDS_MAX_BODY), nowMs)` |

`test/e2e/switch-standin.js` wires all of these (with the state of an empty server) and is what the HTTP tests run.

## The /lan upgrade

`src/worker.js`: a request with an `Upgrade` header (and no `Connection` header, or one that names upgrade) goes to
`lan.js lanUpgrade(request, env)`, which checks, in lan.rs's order: the target, the Host (421), the path (404), the
handshake (GET, `Upgrade: websocket`, version 13, a key of 22 base64 characters and `==`: 400), the Origin (403);
each refusal is `routes.js refuseResponse(code)` (Rust's raw answer: the security headers, no-store, Content-Length
0, Connection: close).  Then the Worker forwards the request itself (headers and all) to the DO with

    x-lan-opts: {"key": "<address key>", "site": "<site key>" | "",
                 "opts": {"resume": bool, "queue": bool, "group": "<22>", "site": "<22>" | null, "ident": null,
                          "country": "DE" | null, "refuse": null, "protocol": "<first subprotocol>" | null,
                          "protocolBad": bool}}

key and site are Rust's address and site keys (headers.js addressKey / siteKey), what lan_conns and lan_opens count
by.  The DO keeps one `LanGate` (lan_gate.js; `new LanGate({})`, options override the limits for tests) for its
life and runs `const t = gate.take(key, site, nowMs, opts)`: the client's /lan connections (8 per address, 16 per
site: `{refuse: "busy", status: 429}`), how fast it opens them (a burst of 20, then 1 a second, twice that per site:
`{refuse: "fast", status: 429}`), then `opts.protocolBad` (`{refuse: "protocol", status: 400}`), in Rust's order; a
refusal carries `log` (Rust's console line, or null) and `response` (Rust's raw refusal, `refuseResponse(status)`:
the security headers, no-store, Content-Length 0, Connection: close), which the DO returns.  Otherwise
`{share, protocol}`: answer 101 with the WebSocket (`Sec-WebSocket-Protocol: <protocol>` when not null), attach it
with opts (resume, queue, group, site, ident, country, refuse as AttachOpts), and call `gate.release(share)` when the
connection closes (a second call is nothing).  `gate.check(key, site, nowMs)` is GET /lan's answer
("ok" | "busy" | "fast"), `gate.count()` / `gate.held(key)` Budget's counts, `gate.prune(nowMs)` every minute.

Hooks not filled yet: `ident` (nfsu2-bans' keyed hash of the address, `Bans::addr(key)`: null until the bans are
ported; Rust sets it whenever the address key is not empty), `refuse` (always null at the upgrade in Rust too), the
hello's ban check (`on_hello`: nfsu2-bans) and `on_claim` (nfsu2-claims `owner_of_token`): the DO's to wire once
those crates are ported.

