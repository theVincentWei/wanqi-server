"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BACKEND_TOKEN_HEADER = void 0;
exports.backendTokenOf = backendTokenOf;
exports.verifyBackendToken = verifyBackendToken;
const node_crypto_1 = require("node:crypto");
/**
 * daemon 侧 backend token 校验（glm-quota daemon 同款逐字照搬）：Server→daemon
 * 转发附内部头 `x-baigong-backend-token`（server/miniapp/backends.ts
 * BACKEND_TOKEN_HEADER 同名），daemon 恒定时间比对（双侧 sha256 后
 * timingSafeEqual）。`/healthz` 免鉴权（router 在鉴权前分流）。
 */
exports.BACKEND_TOKEN_HEADER = 'x-baigong-backend-token';
/** 请求头取内部 token（node:http 头名恒小写；数组形态取首值）。 */
function backendTokenOf(req) {
    const value = req.headers[exports.BACKEND_TOKEN_HEADER];
    if (Array.isArray(value))
        return value[0];
    return value;
}
/** 恒定时间比对：缺头 / 空头 / 错头一律 false（回包形态同 401，不可区分）。 */
function verifyBackendToken(expected, presented) {
    if (typeof presented !== 'string' || presented === '')
        return false;
    const sha256 = (value) => (0, node_crypto_1.createHash)('sha256').update(value).digest();
    return (0, node_crypto_1.timingSafeEqual)(sha256(presented), sha256(expected));
}
