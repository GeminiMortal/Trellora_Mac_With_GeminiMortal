const target = process.argv[2] ?? 'ws://127.0.0.1:9333/devtools/page/49B9A397FB3F6AE5C6349ED007C591B5';
const expression = `(() => {
  const rail = document.querySelector('.app-nav-rail');
  if (!rail) return { error: 'NO RAIL' };
  const rect = rail.getBoundingClientRect();
  const mid = document.elementFromPoint(rect.left + 30, rect.top + rect.height / 2);
  const region = (el) => el ? getComputedStyle(el).webkitAppRegion : null;
  const chain = [];
  let e = mid;
  while (e && chain.length < 7) { chain.push(e.tagName + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ':' + region(e)); e = e.parentElement; }
  return {
    rail: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    railRegion: region(rail),
    topRegion: region(document.querySelector('.app-nav-rail-top')),
    midRegion: region(mid),
    chain: chain.join(' < '),
    rootInert: document.getElementById('root')?.hasAttribute('inert'),
    splashPresent: Boolean(document.getElementById('startup-splash')),
  };
})()`;
const ws = new WebSocket(target);
ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression } })));
ws.addEventListener('message', (event) => {
  const data = JSON.parse(String(event.data));
  if (data.id === 1) { console.log(JSON.stringify(data.result?.result?.value ?? data.error ?? data, null, 1)); process.exit(0); }
});
ws.addEventListener('error', (event) => { console.error('WS ERROR', event.message ?? event); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
