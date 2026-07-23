// egress-pin — service worker.
//
// Layer 1 — mandatory PAC via chrome.proxy: all profile traffic goes to the
//           proxy and there is no DIRECT fallback. If the proxy is down,
//           Chromium's network stack fails requests with
//           ERR_PROXY_CONNECTION_FAILED on its own. That is the killswitch:
//           nothing is polled, no latency is added, a leak is not possible.
// Layer 2 — declarativeNetRequest: covers the case where the proxy is alive
//           but exits somewhere else (wrong node, swapped config, silent
//           reconnect). Default state is blocked; it is only lifted after a
//           check succeeds.

const STATIC_RULESET = 'block_all';
const ALLOW_RULE_ID = 1001;

const DEFAULTS = {
  enabled: true,
  expectedIp: '',
  checkUrl: '',
  proxyScheme: 'socks5',
  proxyHost: '127.0.0.1',
  proxyPort: 10808,
  bypassHosts: ['localhost', '127.0.0.1'],
  timeoutMs: 4000,
};

const PAC_TOKEN = {
  socks5: 'SOCKS5',
  socks4: 'SOCKS',
  http: 'PROXY',
  https: 'HTTPS',
};

// ------------------------------------------------------------- config

const getConfig = () => chrome.storage.local.get(DEFAULTS);

async function setState(state) {
  await chrome.storage.session.set({ state: { ...state, at: Date.now() } });
  const badge = {
    ok: ['', '#1f9d55'],
    blocked: ['x', '#c0392b'],
    off: ['off', '#6b7280'],
  }[state.status] ?? ['?', '#b7791f'];
  await chrome.action.setBadgeText({ text: badge[0] });
  await chrome.action.setBadgeBackgroundColor({ color: badge[1] });
}

// ---------------------------------------------------------- layer 1

function buildPac(cfg) {
  const token = PAC_TOKEN[cfg.proxyScheme] ?? 'SOCKS5';
  const upstream = `${token} ${cfg.proxyHost}:${cfg.proxyPort}`;
  const bypass = JSON.stringify(cfg.bypassHosts ?? []);

  // The returned string deliberately carries no "; DIRECT" fallback.
  // Add one and the killswitch stops being a killswitch.
  return [
    'function FindProxyForURL(url, host) {',
    `  var bypass = ${bypass};`,
    '  for (var i = 0; i < bypass.length; i++) {',
    '    if (host === bypass[i] || shExpMatch(host, bypass[i])) return "DIRECT";',
    '  }',
    `  return ${JSON.stringify(upstream)};`,
    '}',
  ].join('\n');
}

async function applyProxy(cfg) {
  await chrome.proxy.settings.set({
    scope: 'regular',
    value: {
      mode: 'pac_script',
      pacScript: {
        data: buildPac(cfg),
        // mandatory: an invalid PAC must not let the stack drop to direct
        mandatory: true,
      },
    },
  });
}

const clearProxy = () => chrome.proxy.settings.clear({ scope: 'regular' });

async function hardenPrivacy() {
  // WebRTC speaks UDP and bypasses both the HTTP proxy and DNR — close it here.
  const settings = [
    [chrome.privacy.network.webRTCIPHandlingPolicy, 'disable_non_proxied_udp'],
    [chrome.privacy.network.networkPredictionEnabled, false],
  ];
  for (const [setting, value] of settings) {
    try {
      await setting.set({ value });
    } catch (e) {
      console.warn('privacy setting rejected', e);
    }
  }
}

// ---------------------------------------------------------- layer 2

async function ensureAllowRule(cfg) {
  const addRules = cfg.checkUrl
    ? [{
        id: ALLOW_RULE_ID,
        priority: 100,
        action: { type: 'allow' },
        condition: {
          urlFilter: `|${cfg.checkUrl}`,
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      }]
    : [];

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ALLOW_RULE_ID],
    addRules,
  });
}

async function setBlocking(on) {
  const key = on ? 'enableRulesetIds' : 'disableRulesetIds';
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    [key]: [STATIC_RULESET],
  });
}

// -------------------------------------------------------- IP probe

async function probeIp(cfg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.checkUrl, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: `endpoint returned ${res.status}` };
    const ip = (await res.text()).trim();
    if (ip !== cfg.expectedIp) {
      return { ok: false, ip, reason: `IP mismatch: ${ip || '-'}` };
    }
    return { ok: true, ip };
  } catch (e) {
    // Timeout, reset, refused proxy — all of it counts as unsafe.
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : 'network unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------- reconcile

let pending = null;

function reconcile() {
  if (pending) return pending;
  pending = run().finally(() => { pending = null; });
  return pending;
}

async function run() {
  const cfg = await getConfig();

  if (!cfg.enabled) {
    await setBlocking(false);
    await clearProxy();
    return setState({ status: 'off' });
  }

  if (!cfg.expectedIp || !cfg.checkUrl) {
    await setBlocking(true);
    return setState({ status: 'blocked', reason: 'not configured' });
  }

  const probe = await probeIp(cfg);
  await setBlocking(!probe.ok);
  return setState({
    status: probe.ok ? 'ok' : 'blocked',
    ip: probe.ip,
    reason: probe.reason,
  });
}

// ----------------------------------------------------------- start

async function bootstrap() {
  const cfg = await getConfig();
  await chrome.alarms.create('recheck', { periodInMinutes: 0.5 });

  if (cfg.enabled) {
    // Order matters: close first, then find out whether we may open.
    await ensureAllowRule(cfg);
    await setBlocking(true);
    await applyProxy(cfg);
    await hardenPrivacy();
  }
  await reconcile();
}

bootstrap();

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
chrome.alarms.onAlarm.addListener(reconcile);

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') bootstrap();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'recheck') {
    reconcile().then(() => chrome.storage.session.get('state')).then(respond);
    return true;
  }
});
