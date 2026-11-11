"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHealthRequest = isHealthRequest;
exports.handleHealth = handleHealth;
/**
 * GET /healthz（FR-1112 Server 生命周期面 30s 周期探测；恒免鉴权）。
 */
function isHealthRequest(method, pathname) {
    return method === 'GET' && pathname === '/healthz';
}
function handleHealth(res) {
    const body = JSON.stringify({ status: 'ok', service: 'sys-monitor-daemon' });
    res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}
