import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * daemon 侧 backend token 校验（glm-quota daemon 同款逐字照搬）：Server→daemon
 * 转发附内部头 `x-baigong-backend-token`（server/miniapp/backends.ts
 * BACKEND_TOKEN_HEADER 同名），daemon 恒定时间比对（双侧 sha256 后
 * timingSafeEqual）。`/healthz` 免鉴权（router 在鉴权前分流）。
 */

export const BACKEND_TOKEN_HEADER = 'x-baigong-backend-token';

/** 请求头取内部 token（node:http 头名恒小写；数组形态取首值）。 */
export function backendTokenOf(req: IncomingMessage): string | undefined {
  const value = req.headers[BACKEND_TOKEN_HEADER];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** 恒定时间比对：缺头 / 空头 / 错头一律 false（回包形态同 401，不可区分）。 */
export function verifyBackendToken(expected: string, presented: string | undefined): boolean {
  if (typeof presented !== 'string' || presented === '') return false;
  const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(sha256(presented), sha256(expected));
}
