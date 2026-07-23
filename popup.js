const WORDS = {
  ok: 'passing',
  blocked: 'blocked',
  off: 'off',
};

const el = (id) => document.getElementById(id);

function render(state, cfg) {
  const status = state?.status ?? '';
  el('signal').dataset.status = status;
  el('word').textContent = WORDS[status] ?? 'checking';
  el('reason').textContent = state?.reason ?? (status === 'ok' ? 'IP matches' : '');

  el('expected').textContent = cfg.expectedIp || 'not set';
  el('actual').textContent = state?.ip || '-';
  el('proxy').textContent = `${cfg.proxyScheme}://${cfg.proxyHost}:${cfg.proxyPort}`;
  el('at').textContent = state?.at
    ? new Date(state.at).toLocaleTimeString()
    : '-';
}

async function refresh() {
  const [{ state }, cfg] = await Promise.all([
    chrome.storage.session.get('state'),
    chrome.storage.local.get({
      expectedIp: '',
      proxyScheme: 'socks5',
      proxyHost: '127.0.0.1',
      proxyPort: 10808,
    }),
  ]);
  render(state, cfg);
}

el('recheck').addEventListener('click', async () => {
  el('word').textContent = 'checking';
  await chrome.runtime.sendMessage({ type: 'recheck' });
  await refresh();
});

el('options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
