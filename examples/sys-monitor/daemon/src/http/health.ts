import type { ServerResponse } from 'node:http';

/**
 * GET /healthz（FR-1112 Server 生命周期面 30s 周期探测；恒免鉴权）。
 */

export function isHealthRequest(method: string, pathname: string): boolean {
  return method === 'GET' && pathname === '/healthz';
}

export function handleHealth(res: ServerResponse): void {
  const body = JSON.stringify({ status: 'ok', service: 'sys-monitor-daemon' });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
