const { createClient } = require('redis');
const cfg = require('../config');

const client = createClient({ url: cfg.redisUrl });
client.on('error', (err) => console.error('[redis] error', err));

let ready = false;
async function initRedis() {
  if (!ready) {
    await client.connect();
    ready = true;
    console.log('[redis] connected');
  }
}

async function getJSON(key) {
  try {
    if (!ready) await initRedis();
    const v = await client.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    console.warn('[redis] getJSON failed', e.message);
    return null; // fall back gracefully
  }
}
async function setJSON(key, obj, ttlSec) {
  try {
    if (!ready) await initRedis();
    await client.set(key, JSON.stringify(obj), { EX: ttlSec });
  } catch (e) {
    console.warn('[redis] setJSON failed', e.message);
  }
}

module.exports = { initRedis, getJSON, setJSON };
