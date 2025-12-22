// src/consumers/events.js
const { Kafka } = require('kafkajs');
const { Pool } = require('pg');
const cfg = require('../config');

const kafka = new Kafka({ clientId: `${cfg.kafka.clientId}-consumer`, brokers: cfg.kafka.brokers });
const consumer = kafka.consumer({ groupId: `${cfg.kafka.groupId}-events` });

const pool = new Pool({
    host: cfg.ts.host, port: cfg.ts.port, database: cfg.ts.database,
    user: cfg.ts.user, password: cfg.ts.password,
});

async function startConsumers() {
    await new Promise(r => setTimeout(r, 2000));
    await consumer.connect();

    // telemetry.gps → gps_points (you already saw this working)
    await consumer.subscribe({ topic: 'telemetry.gps', fromBeginning: true });

    // plan.optimized → plan_events
    await consumer.subscribe({ topic: 'plan.optimized', fromBeginning: true });

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const val = message.value?.toString() || '{}';
            let payload;
            try { payload = JSON.parse(val); } catch { return; }

            if (topic === 'telemetry.gps') {
                const tsMs = payload.ts || Date.now();
                const args = [
                    tsMs / 1000.0,
                    payload.vehicle_id || null,
                    Number(payload.lat), Number(payload.lon),
                    payload.speed_kph ?? null,
                    payload.heading_deg ?? null,
                    payload.odometer_km ?? null,
                    payload.fuel_pct ?? null,
                    payload.temp_c ?? null,
                    JSON.stringify(payload.meta || {})
                ];
                await pool.query(
                    `INSERT INTO gps_points
             (ts, vehicle_id, lat, lon, speed_kph, heading_deg, odometer_km, fuel_pct, temp_c, meta)
           VALUES (to_timestamp($1), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    args
                );
            }

            if (topic === 'plan.optimized') {
                const tsMs = payload.at || Date.now();
                const allocations = Array.isArray(payload.allocations) ? payload.allocations.length : null;
                const totalCost = payload.totalCost ?? null;
                await pool.query(
                    `INSERT INTO plan_events (ts, allocations, total_cost, meta)
           VALUES (to_timestamp($1), $2, $3, $4)`,
                    [tsMs / 1000.0, allocations, totalCost, JSON.stringify(payload)]
                );
            }
        }
    });

    console.log('[consumer] running');
}

module.exports = { startConsumers };
