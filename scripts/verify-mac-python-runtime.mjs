// 验证与 pythonWorkerClient 相同的探测策略：纯净 PATH（模拟 Finder 启动）下选出解释器并对打包 runtime 握手。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const runtimeDirectory = process.argv[2];
const MINOR = 10;

function probe(executable) {
  const result = spawnSync(executable, ['-E', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 6000 });
  const match = /^(\d+)\.(\d+)/m.exec((result.stdout ?? '').trim());
  if (result.status !== 0 || !match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 3 || (major === 3 && minor >= MINOR) ? `${major}.${minor}` : null;
}

const candidates = [];
for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
  for (const suffix of ['3.13', '3.12', '3.11', '3.10']) candidates.push(path.join(directory, `python${suffix}`));
  candidates.push(path.join(directory, 'python3'));
}
candidates.push('/usr/bin/python3', 'python3');

console.log('PATH =', process.env.PATH);
for (const candidate of candidates) {
  if (candidate.includes('/') && !fs.existsSync(candidate)) { console.log('skip(不存在):', candidate); continue; }
  const version = probe(candidate);
  console.log('探测:', candidate, '->', version ?? '不满足3.10+/失败');
  if (!version) continue;
  const payload = `${JSON.stringify({ id: 'h', method: 'hello', params: { protocolVersion: 1 } })}\n${JSON.stringify({ id: 's', method: 'shutdown', params: {} })}\n`;
  const worker = spawnSync(candidate, ['-E', '-m', 'pipeline_worker'], { cwd: runtimeDirectory, input: payload, encoding: 'utf8', timeout: 30000 });
    const hello = worker.stdout?.split('\n').find((line) => line.includes('"id":"h"'));
  console.log('握手 exit:', worker.status, '| 响应:', (hello ?? worker.stderr ?? '').slice(0, 200));
  process.exit(worker.status === 0 && hello ? 0 : 1);
}
console.log('没有任何满足 3.10+ 的解释器');
process.exit(2);
