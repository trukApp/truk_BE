// lib/redis.js
// Resilient Redis utility with:
// - fast-fail timeouts
// - circuit breaker (avoid hammering a sick Redis)
// - in-memory TTL cache fallback
// - optional kill switch via REDIS_DISABLED=1

const { createClient } = require('redis');
const cfg = require('../config');

/* -------------------- Config -------------------- */
const REDIS_URL =
  cfg.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Per-call timeout (ms) for Redis commands
const CALL_TIMEOUT_MS = Number(
  process.env.REDIS_CALL_TIMEOUT_MS || cfg.redisCallTimeoutMs || 500
);

// Open the breaker after this many consecutive errors/timeouts
const CIRCUIT_ERR_THRESHOLD = Number(
  process.env.REDIS_CIRCUIT_THRESHOLD || 3
);

// Keep the breaker open for this long (ms)
const CIRCUIT_OPEN_MS = Number(
  process.env.REDIS_CIRCUIT_OPEN_MS || 60_000
);

// In-memory fallback TTL (seconds)
const LOCAL_TTL_SEC = Number(
  process.env.REDIS_LOCAL_TTL_SEC || 600
);

// Hard kill switch
const REDIS_DISABLED = process.env.REDIS_DISABLED === '1';

/* ---------------- In-memory cache ---------------- */
const mem = new Map(); // key -> { v:any, exp:number(ms) }

function memGet(key) {
  const it = mem.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) { mem.delete(key); return null; }
  return it.v;
}
function memSet(key, value, ttlSec) {
  const ttl = (ttlSec && ttlSec > 0 ? ttlSec : LOCAL_TTL_SEC) * 1000;
  mem.set(key, { v: value, exp: Date.now() + ttl });
}

/* ---------------- Redis client & state ---------------- */
const client = createClient({
  url: REDIS_URL,
  disableOfflineQueue: true, // never queue (no hanging)
  socket: {
    keepAlive: 10_000,
    // Linear-ish backoff up to 5s
    reconnectStrategy: (retries) => Math.min(200 * retries, 5000),
  },
});

let ready = false;
let consecErrors = 0;
let circuitOpenUntil = 0;
let lastCircuitLogAt = 0;

client.on('connect', () => console.log('[redis] connecting...'));
client.on('ready', () => { ready = true; consecErrors = 0; console.log('[redis] ready'); });
client.on('end', () => { ready = false; console.warn('[redis] connection ended'); });
client.on('reconnecting', () => console.warn('[redis] reconnecting...'));
client.on('error', (err) => {
  ready = false;
  bumpError(`error ${err && err.message ? err.message : String(err)}`);
});

function nowMs() { return Date.now(); }

function breakerOpen() {
  return nowMs() < circuitOpenUntil;
}
function openBreaker() {
  circuitOpenUntil = nowMs() + CIRCUIT_OPEN_MS;
  const shouldLog = nowMs() - lastCircuitLogAt > 5000;
  if (shouldLog) {
    lastCircuitLogAt = nowMs();
    console.warn(`[redis] circuit OPEN for ${CIRCUIT_OPEN_MS}ms`);
  }
}
function closeBreaker() {
  circuitOpenUntil = 0;
  consecErrors = 0;
  console.warn('[redis] circuit CLOSED');
}

function bumpError(tag) {
  consecErrors += 1;
  if (consecErrors >= CIRCUIT_ERR_THRESHOLD && !breakerOpen()) {
    openBreaker();
  } else {
    console.warn(`[redis] ${tag}`);
  }
}

function withTimeout(promise, ms = CALL_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('REDIS_TIMEOUT')), ms)),
  ]);
}

async function ensureConnected() {
  if (REDIS_DISABLED) return false;
  if (breakerOpen()) return false;
  if (ready) return true;

  try {
    await withTimeout(client.connect());
    ready = true;
    console.log('[redis] connected');
    closeBreaker();
    return true;
  } catch (e) {
    bumpError(`connect failed: ${e.message}`);
    return false;
  }
}

/* ---------------- Public API ---------------- */
async function getJSON(key) {
  // If disabled or breaker open, use memory only
  if (REDIS_DISABLED || breakerOpen() || !(await ensureConnected())) {
    return memGet(key);
  }

  try {
    const v = await withTimeout(client.get(key));
    consecErrors = 0; // success
    if (!v) return memGet(key) || null;
    const parsed = JSON.parse(v);
    // Warm local cache too (soft TTL)
    memSet(key, parsed, LOCAL_TTL_SEC);
    return parsed;
  } catch (e) {
    bumpError(`getJSON ${key} -> ${e.message}`);
    // Fallback
    return memGet(key);
  }
}

async function setJSON(key, obj, ttlSec) {
  // Always populate local cache first so callers benefit even if Redis is down
  try { memSet(key, obj, ttlSec || LOCAL_TTL_SEC); } catch {}

  if (REDIS_DISABLED || breakerOpen() || !(await ensureConnected())) {
    return false;
  }

  try {
    const s = JSON.stringify(obj);
    if (ttlSec && Number(ttlSec) > 0) {
      await withTimeout(client.setEx(key, Number(ttlSec), s));
    } else {
      await withTimeout(client.set(key, s));
    }
    consecErrors = 0; // success
    return true;
  } catch (e) {
    bumpError(`setJSON ${key} -> ${e.message}`);
    return false;
  }
}

async function initRedis() {
  // Backwards-compat name used by your code
  return ensureConnected();
}

function cacheStatus() {
  if (REDIS_DISABLED) return 'disabled';
  if (breakerOpen()) return 'offline:circuit';
  if (ready) return 'online';
  return 'offline:connecting';
}

module.exports = {
  initRedis,
  getJSON,
  setJSON,
  client,
  cacheStatus,
};
