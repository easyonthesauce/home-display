const crypto = require('crypto');

const REGION_HOSTS = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
  ueaz: 'https://openapi-ueaz.tuyaus.com',
};

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacSha256Upper = (key, msg) =>
  crypto.createHmac('sha256', key).update(msg).digest('hex').toUpperCase();

class TuyaClient {
  constructor({ clientId, clientSecret, region }) {
    if (!clientId || !clientSecret) {
      throw new Error('TUYA_CLIENT_ID and TUYA_CLIENT_SECRET are required');
    }
    const host = REGION_HOSTS[region] || REGION_HOSTS.eu;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.host = host;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // Tuya signature spec:
  //   stringToSign = method + "\n" + sha256(body) + "\n" + signHeaders + "\n" + url
  //   no token:  sign = HMAC_SHA256(secret, clientId + t + nonce + stringToSign)
  //   with token: sign = HMAC_SHA256(secret, clientId + accessToken + t + nonce + stringToSign)
  async request(method, path, { withToken = true, body = '' } = {}) {
    if (withToken) await this.ensureToken();

    const t = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const contentHash = sha256Hex(body || '');
    const stringToSign = [method.toUpperCase(), contentHash, '', path].join('\n');
    const signTarget = withToken
      ? this.clientId + this.token + t + nonce + stringToSign
      : this.clientId + t + nonce + stringToSign;
    const sign = hmacSha256Upper(this.clientSecret, signTarget);

    const headers = {
      'client_id': this.clientId,
      'sign': sign,
      't': t,
      'sign_method': 'HMAC-SHA256',
      'nonce': nonce,
    };
    if (withToken) headers.access_token = this.token;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(this.host + path, {
      method,
      headers,
      body: body || undefined,
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok || json.success === false) {
      const code = json.code ?? res.status;
      const msg = json.msg ?? res.statusText;
      const err = new Error(`Tuya ${method} ${path} failed: ${code} ${msg}`);
      err.payload = json;
      throw err;
    }
    return json.result;
  }

  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return;
    const result = await this.request('GET', '/v1.0/token?grant_type=1', {
      withToken: false,
    });
    this.token = result.access_token;
    this.tokenExpiresAt = Date.now() + result.expire_time * 1000;
  }

  getDeviceInfo(deviceId) {
    return this.request('GET', `/v1.0/iot-03/devices/${deviceId}`);
  }

  getDeviceStatus(deviceId) {
    return this.request('GET', `/v1.0/iot-03/devices/${deviceId}/status`);
  }
}

module.exports = { TuyaClient };
