const target = process.argv[2] ?? 'ws://127.0.0.1:9333/devtools/page/49B9A397FB3F6AE5C6349ED007C591B5';
const ws = new WebSocket(target);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
ws.addEventListener('message', (event) => {
  const data = JSON.parse(String(event.data));
  if (data.id && pending.has(data.id)) { const { resolve, reject } = pending.get(data.id); pending.delete(data.id); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data); }
});
ws.addEventListener('open', async () => {
  const before = await evaluate('JSON.stringify([window.screenX, window.screenY])');
  const railRect = await evaluate('(() => { const r = document.querySelector(".app-nav-rail").getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height - 120)]; })()');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: railRect[0], y: railRect[1], button: 'left', clickCount: 1 });
  await sleep(150);
  for (let i = 1; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: railRect[0] + i * 40, y: railRect[1] + i * 10, button: 'left' }); await sleep(40); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: railRect[0] + 400, y: railRect[1] + 100, button: 'left' });
  await sleep(400);
  const after = await evaluate('JSON.stringify([window.screenX, window.screenY])');
  console.log('拖动前:', before, '拖动后:', after, '起点:', JSON.stringify(railRect));
  console.log(before !== after ? '成功：窗口被拖动（app-region 生效）' : '失败：窗口未移动');
  process.exit(0);
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 20000);
