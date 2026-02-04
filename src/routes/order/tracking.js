require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();

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
}



module.exports = router;