const DEFAULTS = {
  enabled: true,
  expectedIp: '',
  checkUrl: '',
  proxyScheme: 'socks5',
  proxyHost: '127.0.0.1',
  proxyPort: 10808,
  bypassHosts: ['localhost', '127.0.0.1'],
};

const el = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  el('enabled').checked = cfg.enabled;
  el('expectedIp').value = cfg.expectedIp;
  el('checkUrl').value = cfg.checkUrl;
  el('proxyScheme').value = cfg.proxyScheme;
  el('proxyHost').value = cfg.proxyHost;
  el('proxyPort').value = cfg.proxyPort;
  el('bypassHosts').value = (cfg.bypassHosts ?? []).join(', ');
}

el('save').addEventListener('click', async () => {
  const port = Number.parseInt(el('proxyPort').value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    el('saved').textContent = 'Port must be a number between 1 and 65535.';
    return;
  }

  await chrome.storage.local.set({
    enabled: el('enabled').checked,
    expectedIp: el('expectedIp').value.trim(),
    checkUrl: el('checkUrl').value.trim(),
    proxyScheme: el('proxyScheme').value,
    proxyHost: el('proxyHost').value.trim() || '127.0.0.1',
    proxyPort: port,
    bypassHosts: el('bypassHosts').value
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  });

  el('saved').textContent = 'Saved. Check running.';
  setTimeout(() => { el('saved').textContent = ''; }, 2500);
});

load();
