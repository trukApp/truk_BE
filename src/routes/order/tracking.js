require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();
const cron = require('node-cron');

const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');
const jwtAuth = require('../../JWT/jwtAuth');
const polyline = require('@mapbox/polyline');

const cfg = require('../../config');
const { getJSON, setJSON } = require('../../lib/redis');
const { logApiPerf, logSolverPerf } = require('../../lib/tsdb');
const { emit } = require('../../lib/kafka');

router.post('/start-trip', jwtAuth.verifyToken, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { order_ID } = req.body;

        if (!order_ID) {
            return res.status(400).json({ message: 'order_ID is required' });
        }

        // 1. Tracking session
        const [trackingRows] = await conn.query(
            `SELECT tracking_id, status
         FROM order_tracking_sessions
        WHERE order_id = ?`,
            [order_ID]
        );

        if (!trackingRows.length) {
            return res.status(404).json({ message: 'Tracking session not found' });
        }

        const tracking = trackingRows[0];

        if (tracking.status !== 'created') {
            return res.status(400).json({
                message: `Trip cannot be started. Current status: ${tracking.status}`
            });
        }

        // 2. Assignment
        const [assignRows] = await conn.query(
            `SELECT assigned_vehicle_data
         FROM assigning_orders
        WHERE order_ID = ?
     ORDER BY assigning_id DESC
        LIMIT 1`,
            [order_ID]
        );

        if (!assignRows.length) {
            return res.status(400).json({
                message: 'Order is not assigned yet'
            });
        }

        let assignedData = assignRows[0].assigned_vehicle_data;

        // 🔥 FIX: handle JSON/object safely
        if (typeof assignedData === 'string') {
            try {
                assignedData = JSON.parse(assignedData);
            } catch {
                assignedData = [];
            }
        }

        if (!Array.isArray(assignedData)) {
            assignedData = [];
        }

        const device_ID = assignedData[0]?.dev_ID;

        if (!device_ID) {
            return res.status(400).json({
                message: 'Device ID not found in assigned vehicle data'
            });
        }

        // 3. Start trip
        await conn.query(
            `UPDATE order_tracking_sessions
          SET device_id = ?,
              trip_started_at = NOW(),
              status = 'IN_TRANSIT'
        WHERE order_id = ?`,
            [device_ID, order_ID]
        );

        return res.json({
            message: 'Trip started successfully',
            order_ID,
            device_ID,
            tracking_id: tracking.tracking_id
        });

    } catch (err) {
        logger.error('start-trip failed', err);
        return res.status(500).json({ message: 'Internal server error' });
    } finally {
        conn.release();
    }
});



async function fetchGpsFromVendor(providerName, regNo) {
    const url = `https://api.vamosys.com/mobile/getGrpDataForTrustedClients`;

    try {
        const res = await axios.get(url, {
            params: {
                providerName,               // 9640881718
                fcode:"VAMTO"
            },
            timeout: 5000
        });

        if (!Array.isArray(res.data)) return null;

        // 🔍 FILTER by vehicle number (regNo)
        const vehicle = res.data.find(
            v => v.regNo === regNo
        );

        if (!vehicle) return null;

        return {
            lat: Number(vehicle.latitude),
            lng: Number(vehicle.longitude),
            speed: Number(vehicle.speed || 0),
            timestamp: Number(vehicle.date)
        };

    } catch (err) {
        logger.error('GPS vendor error:', err.message);
        return null;
    }
}



// cron.schedule('*/20 * * * * *', async () => {
 cron.schedule('0 * * * *', async () => {
    const conn = await db.getConnection();

    try {
        // 1️⃣ Fetch ONLY active trips
        const [sessions] = await conn.query(`
  SELECT 
    ots.tracking_id,
    ao.assigned_vehicle_data
  FROM order_tracking_sessions ots
  JOIN assigning_orders ao ON ao.order_ID = ots.order_id
  WHERE ots.status IN ('trip_started','in_transit')
`);


        for (const s of sessions) {
            let vehicles = s.assigned_vehicle_data;

            if (typeof vehicles === 'string') {
                vehicles = JSON.parse(vehicles);
            }

            const { dev_ID, self_vehicle_num } = vehicles[0];

            const gps = await fetchGpsFromVendor(
                dev_ID,               // providerName
                self_vehicle_num      // regNo
            );

            if (!gps) continue;

            await axios.post(
                `http://13.127.36.10:8088/truk/track/gps-ping`,
                {
                    deviceId: dev_ID,   // stays same for your system
                    lat: gps.lat,
                    lng: gps.lng,
                    speed: gps.speed,
                    timestamp: gps.timestamp
                },
                { timeout: 3000 }
            );
        }

    } catch (err) {
        logger.error('GPS cron failed:', err);
    } finally {
        conn.release();
    }
});


router.post('/gps-ping', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { deviceId, lat, lng, speed, timestamp } = req.body;

        if (!deviceId || lat == null || lng == null || !timestamp) {
            return res.status(400).json({ message: 'Invalid GPS payload' });
        }

        // 1. Active trip
        const [sessions] = await conn.query(
            `SELECT tracking_id
         FROM order_tracking_sessions
        WHERE device_id = ?
          AND status = 'IN_TRANSIT'`,
            [deviceId]
        );

        if (!sessions.length) {
            return res.json({ message: 'No active trip for device' });
        }

        const trackingId = sessions[0].tracking_id;

        // 2. Store GPS
        await conn.query(
            `INSERT INTO vehicle_gps_logs
   (tracking_id, device_id, latitude, longitude, speed, recorded_at)
   VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000))`,
            [trackingId, deviceId, lat, lng, speed || 0, timestamp]
        );


        // 3. Heartbeat
        await conn.query(
            `UPDATE order_tracking_sessions
          SET last_gps_time = FROM_UNIXTIME(?/1000)
        WHERE tracking_id = ?`,
            [timestamp, trackingId]
        );

        // 4. Next pending stop
        const [stops] = await conn.query(
            `SELECT id, stop_no, latitude, longitude, radius_m
         FROM order_stop_tracking
        WHERE tracking_id = ?
          AND status = 'PLANNED'
        ORDER BY stop_no
        LIMIT 1`,
            [trackingId]
        );

        if (!stops.length) {
            return res.json({ message: 'All stops completed or arrived' });
        }

        const stop = stops[0];
        const distance = haversine(
            lat,
            lng,
            stop.latitude,
            stop.longitude
        );

        if (distance <= stop.radius_m) {
            await conn.query(
                `UPDATE order_stop_tracking
      SET actual_latitude = ?,
          actual_longitude = ?,
          actual_arrival = NOW(),
          status = 'ARRIVED'
    WHERE id = ?`,
                [lat, lng, stop.id]
            );

        }

        return res.json({ message: 'GPS processed' });

    } catch (err) {
        logger.error('gps-ping failed', err);
        return res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});


function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
    const toRad = v => (v * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};


router.post('/complete-stop', jwtAuth.verifyToken, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { order_ID, stop_no, pod_doc, latitude, longitude } = req.body;

        if (!order_ID || stop_no == null || latitude == null || longitude == null) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // 1️⃣ Active tracking session
        const [[tracking]] = await conn.query(
            `SELECT tracking_id, status
         FROM order_tracking_sessions
        WHERE order_id = ?
          AND status IN ('trip_started','in_transit')`,
            [order_ID]
        );

        if (!tracking) {
            return res.status(400).json({ message: 'Trip not started or already ended' });
        }

        // 2️⃣ Fetch stop
        const [[stop]] = await conn.query(
            `SELECT id,
              latitude,
              longitude,
              radius_m,
              actual_arrival,
              status
         FROM order_stop_tracking
        WHERE tracking_id = ?
          AND stop_no = ?`,
            [tracking.tracking_id, stop_no]
        );

        if (!stop) {
            return res.status(404).json({ message: 'Stop not found' });
        }

        if (stop.status !== 'arrived') {
            return res.status(400).json({
                message: `Stop must be ARRIVED before completion`,
                current_status: stop.status
            });
        }

        // 3️⃣ Radius validation (destination_radius logic)
        const distance = haversine(
            latitude,
            longitude,
            stop.latitude,
            stop.longitude
        );

        if (distance > stop.radius_m) {
            return res.status(400).json({
                message: 'Vehicle is outside allowed destination radius',
                distance_m: Math.round(distance),
                allowed_radius_m: stop.radius_m
            });
        }

        // 4️⃣ Compute unloading duration
        const arrivalTime = new Date(stop.actual_arrival);
        const unloadEnd = new Date();
        const unloadingSeconds = Math.round(
            (unloadEnd - arrivalTime) / 1000
        );

        // 5️⃣ Update stop
        await conn.query(
            `UPDATE order_stop_tracking
          SET unloading_start = actual_arrival,
              unloading_end = ?,
              unloading_duration_sec = ?,
              status = 'departed'
        WHERE id = ?`,
            [unloadEnd, unloadingSeconds, stop.id]
        );

        // 6️⃣ POD attachment (optional)
        if (pod_doc) {
            await conn.query(
                `UPDATE assigning_orders
            SET pod_doc = ?
          WHERE order_ID = ?`,
                [pod_doc, order_ID]
            );
        }

        // 7️⃣ Check remaining stops
        const [[pending]] = await conn.query(
            `SELECT COUNT(*) AS cnt
         FROM order_stop_tracking
        WHERE tracking_id = ?
          AND status IN ('planned','arrived','unloading')`,
            [tracking.tracking_id]
        );

        if (pending.cnt === 0) {
            await conn.query(
                `UPDATE order_tracking_sessions
            SET status = 'trip_ended',
                trip_ended_at = NOW()
          WHERE tracking_id = ?`,
                [tracking.tracking_id]
            );

            await conn.query(
                `UPDATE orders
            SET order_status = 'Delivered'
          WHERE order_ID = ?`,
                [order_ID]
            );
        }

        res.json({
            message: 'Stop completed successfully',
            stop_no,
            unloading_duration_sec: unloadingSeconds
        });

    } catch (err) {
        logger.error('complete-stop failed', err);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        conn.release();
    }
});


router.get('/live', jwtAuth.verifyToken, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { order_ID } = req.query;

        // 1️⃣ Active tracking session
        const [[session]] = await conn.query(
            `SELECT tracking_id, device_id, status, last_gps_time
         FROM order_tracking_sessions
        WHERE order_id = ?
        ORDER BY tracking_id DESC
        LIMIT 1`,
            [order_ID]
        );

        if (!session) {
            return res.status(404).json({ message: 'Tracking not found' });
        }

        // 2️⃣ Latest GPS
        const [[gps]] = await conn.query(
            `SELECT latitude, longitude, speed, recorded_at
         FROM vehicle_gps_logs
        WHERE tracking_id = ?
        ORDER BY recorded_at DESC
        LIMIT 1`,
            [session.tracking_id]
        );

        // 3️⃣ Next stop (optional for UI marker)
        const [[nextStop]] = await conn.query(
            `SELECT stop_no, loc_ID, radius_m, status
         FROM order_stop_tracking
        WHERE tracking_id = ?
          AND status IN ('planned','arrived')
        ORDER BY stop_no
        LIMIT 1`,
            [session.tracking_id]
        );

        return res.json({
            order_ID,
            tracking_status: session.status,
            device_id: session.device_id,
            last_updated: session.last_gps_time,
            current_position: gps || null,
            next_stop: nextStop || null
        });

    } catch (err) {
        logger.error('live-track failed', err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});



router.get('/replay', jwtAuth.verifyToken, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { order_ID } = req.query;

        // 1️⃣ Tracking session
        const [[session]] = await conn.query(
            `SELECT tracking_id
         FROM order_tracking_sessions
        WHERE order_id = ?
        ORDER BY tracking_id DESC
        LIMIT 1`,
            [order_ID]
        );

        if (!session) {
            return res.status(404).json({ message: 'Tracking not found' });
        }

        // 2️⃣ GPS history
        const [points] = await conn.query(
            `SELECT latitude, longitude, speed, recorded_at
         FROM vehicle_gps_logs
        WHERE tracking_id = ?
        ORDER BY recorded_at ASC`,
            [session.tracking_id]
        );

        // 3️⃣ Stops (for markers)
        const [stops] = await conn.query(
            `SELECT stop_no, loc_ID, latitude, longitude, status
         FROM order_stop_tracking
        WHERE tracking_id = ?
        ORDER BY stop_no`,
            [session.tracking_id]
        );

        return res.json({
            order_ID,
            total_points: points.length,
            gps_path: points,
            stops
        });

    } catch (err) {
        logger.error('route-replay failed', err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});



module.exports = router;