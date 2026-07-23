# egress-pin

A Chromium extension that pins one browser profile to one exit IP — and cuts the profile off the network the moment traffic would leave from anywhere else.

Built for a narrow case: you keep a separate Brave profile behind a VPN, and you need certainty that it never touches the network directly when the tunnel drops. Scoped per profile, so your other profiles keep browsing normally.

## How it works

Two independent layers. The first is the actual killswitch; the second covers a case the first one can't see.

### Layer 1 — mandatory PAC, no direct fallback

The extension installs a PAC script through `chrome.proxy` that returns a single upstream proxy and never returns `DIRECT`. When the proxy is unreachable, Chromium fails every request with `ERR_PROXY_CONNECTION_FAILED`; falling back to a direct connection has to be requested explicitly, and this PAC never requests it. `mandatory: true` closes the other half of the problem: if the PAC itself fails to evaluate, the network stack still refuses to go direct.

Nothing is polled and nothing is intercepted in JavaScript. The decision lives in the network stack, so this layer costs zero added latency and it holds even if the extension's service worker is asleep.

### Layer 2 — declarativeNetRequest, fail-closed

Layer 1 proves traffic went *into the proxy*. It cannot prove where the proxy sent it. Layer 2 covers the rest: a wrong node, a swapped config, a proxy that silently reconnected somewhere else.

Every 30 seconds the extension fetches an endpoint that echoes the client IP and compares it to the configured one. On mismatch — or on any error at all, including a timeout — a static `block_all` ruleset is enabled and every request in the profile dies with `ERR_BLOCKED_BY_CLIENT`.

That ruleset ships **enabled** in the manifest, so a cold browser start is blocked before the service worker even runs. It is only ever disabled after a check succeeds. Every failure path leads to the closed state.

### Also handled

- `webRTCIPHandlingPolicy = disable_non_proxied_udp` — WebRTC speaks UDP and would otherwise bypass both the HTTP proxy and declarativeNetRequest.
- `networkPredictionEnabled = false` — no speculative DNS or prefetch.

## Install

Not on the Web Store. Load it unpacked:

```
chrome://extensions → Developer mode → Load unpacked → load this repository folder
```

Install it into the profile you want locked down, not into all of them.

## Configure

Open the extension's options page.

| Setting | Notes |
|---|---|
| Proxy | Your local client's listener. For Xray, usually `socks5://127.0.0.1:10808` |
| Direct hosts | Comma-separated. Everything else is proxy-only, with no fallback |
| Expected exit IP | The address the outside world should see |
| Check endpoint | A URL returning that IP as plain text |

### Check endpoint

It has to return the client IP and nothing else, uncached. Angie or nginx:

```nginx
location = /_ip {
    default_type text/plain;
    add_header Cache-Control "no-store" always;
    return 200 "$remote_addr\n";
}
```

Host it somewhere that observes the real exit address of your chain, or you'll be comparing against the wrong hop. A small VPS of your own beats public "what is my IP" services here: lower latency, no rate limits, no third party watching you check.

## Verify it actually works

1. With the tunnel up, load any site. It should work; the badge stays clear.
2. Kill the proxy client and reload. `ERR_PROXY_CONNECTION_FAILED` should appear **immediately**, not 30 seconds later. If it takes 30 seconds, layer 1 didn't engage and only the poller saved you — check `chrome://net-internals/#proxy` and confirm the effective config lists no `DIRECT`.
3. Bring the tunnel back but set a deliberately wrong expected IP. Within half a minute the badge turns red and requests fail with `ERR_BLOCKED_BY_CLIENT`. That's layer 2.
4. Run any WebRTC leak test. No local addresses should surface.

## Permissions

| Permission | Why |
|---|---|
| `proxy` | Layer 1. Installs the PAC script |
| `declarativeNetRequest` | Layer 2. Block and allow rules only — this variant needs no host permissions and cannot read request contents |
| `privacy` | WebRTC policy and network prediction |
| `storage` | Config and cached status |
| `alarms` | The 30-second re-check |

No host permissions, no `webRequest`, no content scripts. The extension never sees the contents of your traffic — it can only refuse to carry it.

## Limitations

Read this part.

- **The extension can be disabled.** Launch the profile without it and nothing protects you. This is a soft killswitch by construction.
- **Layer 2 has a window.** Up to 30 seconds, the floor for `chrome.alarms`. Layer 1 closes that window — but only if your VPN exposes a local proxy. In pure tun mode there is nothing for the PAC to point at, layer 1 does not apply, and the polling window is all you have.
- **Browser scope only.** Other applications, and this browser's other profiles, are untouched.

If you need a guarantee rather than a strong default, that belongs at the OS level: nftables, WFP, or running the profile inside its own network namespace. The trade-off is real — this extension binds to a single profile, which firewall rules do awkwardly at best, but only the OS can be strict.

## License

MIT.