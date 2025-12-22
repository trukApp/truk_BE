const { Pool } = require('pg');
const cfg = require('../config');

const pool = new Pool({
  host: cfg.ts.host,
  port: cfg.ts.port,
  database: cfg.ts.database,
  user: cfg.ts.user,
  password: cfg.ts.password,
});

async function logApiPerf(routeName, ms, ok) {
  try {
    await pool.query(
      `INSERT INTO api_perf(ts, route, ms, success) VALUES (NOW(), $1, $2, $3)`,
      [routeName, ms, !!ok]
    );
  } catch (e) {
    console.warn('[tsdb] logApiPerf failed', e.message);
  }
}

async function logSolverPerf(packCount, vehCount, ms, cost) {
  try {
    await pool.query(
      `INSERT INTO solver_perf(ts, pack_count, veh_count, ms, est_cost) VALUES (NOW(), $1, $2, $3, $4)`,
      [packCount, vehCount, ms, cost ?? null]
    );
  } catch (e) {
    console.warn('[tsdb] logSolverPerf failed', e.message);
  }
}

async function insertGpsPoint(p) {
  // p.ts may be ms since epoch; default to NOW()
  await pool.query(
    `INSERT INTO gps_points(
       ts, vehicle_id, lat, lon, speed_kph, heading_deg,
       odometer_km, fuel_pct, temp_c, meta
     )
     VALUES (
       COALESCE(to_timestamp($1/1000.0), NOW()),
       $2,$3,$4,$5,$6,$7,$8,$9,$10
     )`,
    [
      p.ts || null, p.vehicle_id, p.lat, p.lon,
      p.speed_kph ?? null, p.heading_deg ?? null,
      p.odometer_km ?? null, p.fuel_pct ?? null,
      p.temp_c ?? null, p.meta ?? {}
    ]
  );
}

module.exports = { logApiPerf, logSolverPerf, insertGpsPoint };


