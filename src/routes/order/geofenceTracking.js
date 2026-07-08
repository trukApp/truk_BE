const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const router = express.Router();

const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');

/* ============================================================================
   CONFIG
============================================================================ */

const VAMOSYS_API_URL =
    process.env.VAMOSYS_API_URL ||
    'https://api.vamosys.com/mobile/getGrpDataForTrustedClients';

const VAMOSYS_PROVIDER_NAME =
    process.env.VAMOSYS_PROVIDER_NAME ||
    '9640881718';

const VAMOSYS_FCODE =
    process.env.VAMOSYS_FCODE ||
    'VAMTO';

const GEOFENCE_CRON_ENABLED =
    String(process.env.GEOFENCE_CRON_ENABLED || 'true').toLowerCase() === 'true';

const GEOFENCE_CRON_SCHEDULE =
    process.env.GEOFENCE_CRON_SCHEDULE ||
    '*/1 * * * *';

const GEOFENCE_ALERT_COOLDOWN_MINUTES =
    Number(process.env.GEOFENCE_ALERT_COOLDOWN_MINUTES || 30);

/* ============================================================================
   MAILER
============================================================================ */

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'itsupport@trukapp.com',
        pass: 'jgtv jjvr qzhq yzbj'
    }
});

transporter.verify((error) => {
    if (error) {
        logger.error('Geo-fence mailer verification failed:', {
            message: error.message,
            mail_user: process.env.MAIL_USER
        });
    } else {
        logger.info('Geo-fence mailer is ready.');
    }
});

async function sendGeofenceMail({
    to,
    eventType,
    geofence,
    vehicle,
    distanceM
}) {
    const subject =
        eventType === 'entered'
            ? `TrukApp Alert: Vehicle entered ${geofence.geofence_name || geofence.geofence_code}`
            : `TrukApp Alert: Vehicle exited ${geofence.geofence_name || geofence.geofence_code}`;

    const html = `
    <h2>TrukApp Geo-Fence Alert</h2>

    <p><b>Event:</b> ${eventType.toUpperCase()}</p>

    <hr/>

    <p><b>Geo-fence:</b> ${geofence.geofence_name || geofence.geofence_code}</p>
    <p><b>Geo-fence Code:</b> ${geofence.geofence_code}</p>
    <p><b>Fence Center:</b> ${geofence.center_lat}, ${geofence.center_lng}</p>
    <p><b>Radius:</b> ${geofence.radius_m} meters</p>

    <hr/>

    <p><b>Vehicle ID:</b> ${vehicle.vehicleId || geofence.vehicle_ID || '-'}</p>
    <p><b>Vehicle Number:</b> ${vehicle.regNo || geofence.vehicle_number || '-'}</p>
    <p><b>Current Location:</b> ${vehicle.lat}, ${vehicle.lng}</p>
    <p><b>Distance from Geo-fence Center:</b> ${Math.round(distanceM)} meters</p>

    <hr/>

    <p><b>Speed:</b> ${vehicle.speed ?? '-'} km/h</p>
    <p><b>Status:</b> ${vehicle.status || '-'}</p>
    <p><b>Ignition:</b> ${vehicle.ignitionStatus || '-'}</p>
    <p><b>Last Seen:</b> ${vehicle.lastSeen || '-'}</p>
    <p><b>Address:</b> ${vehicle.address || '-'}</p>

    <br/>
    <p>This is an automated alert from TrukApp.</p>
  `;

    await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.MAIL_USER,
        to,
        subject,
        html
    });
}

/* ============================================================================
   HELPERS
============================================================================ */

function generateGeofenceCode() {
    const random = Math.floor(100000 + Math.random() * 900000);
    return `GEO${Date.now()}${random}`;
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = value => (value * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeVehicle(row) {
    const vehicleId =
        row.vehicleId ||
        row.vehicle_ID ||
        row.regNo ||
        row.shortName ||
        null;

    const regNo =
        row.regNo ||
        row.vehicleId ||
        row.shortName ||
        null;

    return {
        ...row,
        vehicleId,
        regNo,
        lat: toNumber(row.lat ?? row.latitude),
        lng: toNumber(row.lng ?? row.longitude)
    };
}

async function fetchVamosysVehicles() {
    const response = await axios.get(VAMOSYS_API_URL, {
        params: {
            providerName: VAMOSYS_PROVIDER_NAME,
            fcode: VAMOSYS_FCODE
        },
        timeout: 10000
    });

    if (!Array.isArray(response.data)) {
        throw new Error('Invalid Vamosys response. Expected an array.');
    }

    return response.data
        .map(normalizeVehicle)
        .filter(vehicle => vehicle.lat !== null && vehicle.lng !== null);
}

function shouldSendAlert(geofence, eventType) {
    if (eventType === 'entered' && Number(geofence.notify_on_entry) !== 1) {
        return false;
    }

    if (eventType === 'exited' && Number(geofence.notify_on_exit) !== 1) {
        return false;
    }

    if (!geofence.last_alert_sent_at) {
        return true;
    }

    const lastAlertTime = new Date(geofence.last_alert_sent_at).getTime();

    if (Number.isNaN(lastAlertTime)) {
        return true;
    }

    const diffMinutes = (Date.now() - lastAlertTime) / 1000 / 60;

    return diffMinutes >= GEOFENCE_ALERT_COOLDOWN_MINUTES;
}

function buildVehicleMap(vehicles) {
    const vehicleMap = new Map();

    for (const vehicle of vehicles) {
        if (vehicle.vehicleId) {
            vehicleMap.set(String(vehicle.vehicleId), vehicle);
        }

        if (vehicle.regNo) {
            vehicleMap.set(String(vehicle.regNo), vehicle);
        }

        if (vehicle.shortName) {
            vehicleMap.set(String(vehicle.shortName), vehicle);
        }
    }

    return vehicleMap;
}

/* ============================================================================
   CORE PROCESSOR
============================================================================ */

let isGeofenceJobRunning = false;

async function processGeofenceTracking() {
    const conn = await db.getConnection();

    try {
        const vehicles = await fetchVamosysVehicles();
        const vehicleMap = buildVehicleMap(vehicles);

        const [geofences] = await conn.query(
            `SELECT *
         FROM vehicle_geofences
        WHERE active = 1`
        );

        const results = [];

        for (const geofence of geofences) {
            const vehicle =
                vehicleMap.get(String(geofence.vehicle_ID)) ||
                vehicleMap.get(String(geofence.vehicle_number));

            if (!vehicle) {
                results.push({
                    geofence_code: geofence.geofence_code,
                    vehicle_ID: geofence.vehicle_ID,
                    vehicle_number: geofence.vehicle_number,
                    status: 'vehicle_not_found_in_vamosys_response'
                });
                continue;
            }

            const distanceM = haversineMeters(
                Number(geofence.center_lat),
                Number(geofence.center_lng),
                Number(vehicle.lat),
                Number(vehicle.lng)
            );

            const isInside = distanceM <= Number(geofence.radius_m);
            const wasInside = Number(geofence.last_inside) === 1;

            let eventType = null;

            if (isInside && !wasInside) {
                eventType = 'entered';
            } else if (!isInside && wasInside) {
                eventType = 'exited';
            }

            /*
              No entry/exit state change.
              Just update last_inside and move on.
            */
            if (!eventType) {
                await conn.query(
                    `UPDATE vehicle_geofences
              SET last_inside = ?,
                  updated_at = NOW()
            WHERE geofence_id = ?`,
                    [
                        isInside ? 1 : 0,
                        geofence.geofence_id
                    ]
                );

                results.push({
                    geofence_code: geofence.geofence_code,
                    vehicle_ID: geofence.vehicle_ID,
                    vehicle_number: geofence.vehicle_number,
                    inside: isInside,
                    distance_m: Math.round(distanceM),
                    event: null,
                    email_sent: false
                });

                continue;
            }

            let emailSent = 0;
            let emailSentAt = null;

            if (shouldSendAlert(geofence, eventType)) {
                try {
                    await sendGeofenceMail({
                        to: geofence.handler_email,
                        eventType,
                        geofence,
                        vehicle,
                        distanceM
                    });

                    emailSent = 1;
                    emailSentAt = new Date();
                } catch (mailError) {
                    logger.error('Geo-fence email failed:', {
                        message: mailError.message,
                        geofence_code: geofence.geofence_code,
                        vehicle_ID: geofence.vehicle_ID,
                        vehicle_number: geofence.vehicle_number
                    });
                }
            }

            await conn.query(
                `INSERT INTO vehicle_geofence_events
          (
            geofence_id,
            geofence_code,
            vehicle_ID,
            vehicle_number,
            event_type,
            vehicle_lat,
            vehicle_lng,
            distance_m,
            speed,
            ignition_status,
            vehicle_status,
            address,
            tracker_date,
            last_seen,
            email_sent,
            email_sent_at,
            email_to,
            raw_payload
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    geofence.geofence_id,
                    geofence.geofence_code,
                    geofence.vehicle_ID,
                    geofence.vehicle_number,
                    eventType,
                    vehicle.lat,
                    vehicle.lng,
                    distanceM,
                    vehicle.speed ?? null,
                    vehicle.ignitionStatus || null,
                    vehicle.status || null,
                    vehicle.address || null,
                    vehicle.date || null,
                    vehicle.lastSeen || null,
                    emailSent,
                    emailSentAt,
                    geofence.handler_email,
                    JSON.stringify(vehicle)
                ]
            );

            await conn.query(
                `UPDATE vehicle_geofences
            SET last_inside = ?,
                last_alert_sent_at = CASE
                  WHEN ? = 1 THEN NOW()
                  ELSE last_alert_sent_at
                END,
                updated_at = NOW()
          WHERE geofence_id = ?`,
                [
                    isInside ? 1 : 0,
                    emailSent,
                    geofence.geofence_id
                ]
            );

            results.push({
                geofence_code: geofence.geofence_code,
                vehicle_ID: geofence.vehicle_ID,
                vehicle_number: geofence.vehicle_number,
                event: eventType,
                inside: isInside,
                distance_m: Math.round(distanceM),
                email_sent: emailSent === 1
            });
        }

        return {
            checkedVehicles: vehicles.length,
            checkedGeofences: geofences.length,
            results
        };

    } finally {
        conn.release();
    }
}

/* ============================================================================
   APIs
============================================================================ */

/**
 * Create geo-fence.
 */
router.post('/create-geofence', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            vehicle_ID,
            vehicle_number,
            geofence_name,
            center_lat,
            center_lng,
            radius_m,
            handler_email,
            notify_on_entry = 1,
            notify_on_exit = 0,
            created_by
        } = req.body;

        if (
            !vehicle_ID ||
            !vehicle_number ||
            center_lat == null ||
            center_lng == null ||
            radius_m == null ||
            !handler_email
        ) {
            return res.status(400).json({
                message: 'vehicle_ID, vehicle_number, center_lat, center_lng, radius_m and handler_email are required.'
            });
        }

        const lat = toNumber(center_lat);
        const lng = toNumber(center_lng);
        const radius = Number(radius_m);

        if (lat === null || lng === null || !Number.isFinite(radius) || radius <= 0) {
            return res.status(400).json({
                message: 'Invalid center_lat, center_lng or radius_m.'
            });
        }

        const geofenceCode = generateGeofenceCode();

        await db.query(
            `INSERT INTO vehicle_geofences
        (
          geofence_code,
          vehicle_ID,
          vehicle_number,
          geofence_name,
          center_lat,
          center_lng,
          radius_m,
          handler_email,
          notify_on_entry,
          notify_on_exit,
          created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                geofenceCode,
                vehicle_ID,
                vehicle_number,
                geofence_name || null,
                lat,
                lng,
                radius,
                handler_email,
                notify_on_entry ? 1 : 0,
                notify_on_exit ? 1 : 0,
                created_by || null
            ]
        );

        return res.status(201).json({
            message: 'Geo-fence created successfully.',
            geofence: {
                geofence_code: geofenceCode,
                vehicle_ID,
                vehicle_number,
                geofence_name: geofence_name || null,
                center_lat: lat,
                center_lng: lng,
                radius_m: radius,
                handler_email,
                active: true
            }
        });

    } catch (error) {
        logger.error('Error creating geo-fence:', error);

        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});

/**
 * Get geo-fences.
 */
router.get('/geofences', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            vehicle_ID,
            vehicle_number,
            active
        } = req.query;

        const conditions = [];
        const values = [];

        if (vehicle_ID) {
            conditions.push('vehicle_ID = ?');
            values.push(vehicle_ID);
        }

        if (vehicle_number) {
            conditions.push('vehicle_number = ?');
            values.push(vehicle_number);
        }

        if (active === 'true' || active === '1') {
            conditions.push('active = 1');
        } else if (active === 'false' || active === '0') {
            conditions.push('active = 0');
        }

        let query = `SELECT * FROM vehicle_geofences`;

        if (conditions.length) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` ORDER BY geofence_id DESC`;

        const [rows] = await db.query(query, values);

        return res.status(200).json({
            message: 'Geo-fences fetched successfully.',
            geofences: rows
        });

    } catch (error) {
        logger.error('Error fetching geo-fences:', error);

        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});

/**
 * Update geo-fence.
 */
router.put('/update-geofence', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { geofence_code } = req.query;

        if (!geofence_code) {
            return res.status(400).json({
                message: 'geofence_code is required.'
            });
        }

        const updates = [];
        const values = [];

        if (req.body.geofence_name !== undefined) {
            updates.push('geofence_name = ?');
            values.push(req.body.geofence_name || null);
        }

        if (req.body.center_lat !== undefined) {
            const lat = toNumber(req.body.center_lat);
            if (lat === null) {
                return res.status(400).json({ message: 'Invalid center_lat.' });
            }

            updates.push('center_lat = ?');
            values.push(lat);

            /*
              When center changes, reset state so next cron can detect entry freshly.
            */
            updates.push('last_inside = 0');
        }

        if (req.body.center_lng !== undefined) {
            const lng = toNumber(req.body.center_lng);
            if (lng === null) {
                return res.status(400).json({ message: 'Invalid center_lng.' });
            }

            updates.push('center_lng = ?');
            values.push(lng);

            updates.push('last_inside = 0');
        }

        if (req.body.radius_m !== undefined) {
            const radius = Number(req.body.radius_m);
            if (!Number.isFinite(radius) || radius <= 0) {
                return res.status(400).json({ message: 'Invalid radius_m.' });
            }

            updates.push('radius_m = ?');
            values.push(radius);

            updates.push('last_inside = 0');
        }

        if (req.body.handler_email !== undefined) {
            updates.push('handler_email = ?');
            values.push(req.body.handler_email);
        }

        if (req.body.active !== undefined) {
            updates.push('active = ?');
            values.push(req.body.active ? 1 : 0);
        }

        if (req.body.notify_on_entry !== undefined) {
            updates.push('notify_on_entry = ?');
            values.push(req.body.notify_on_entry ? 1 : 0);
        }

        if (req.body.notify_on_exit !== undefined) {
            updates.push('notify_on_exit = ?');
            values.push(req.body.notify_on_exit ? 1 : 0);
        }

        if (!updates.length) {
            return res.status(400).json({
                message: 'No valid fields provided for update.'
            });
        }

        updates.push('updated_at = NOW()');
        values.push(geofence_code);

        const [result] = await db.query(
            `UPDATE vehicle_geofences
          SET ${updates.join(', ')}
        WHERE geofence_code = ?`,
            values
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                message: 'Geo-fence not found.'
            });
        }

        return res.status(200).json({
            message: 'Geo-fence updated successfully.',
            geofence_code
        });

    } catch (error) {
        logger.error('Error updating geo-fence:', error);

        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});

/**
 * Deactivate geo-fence.
 */
router.delete('/delete-geofence', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { geofence_code } = req.query;

        if (!geofence_code) {
            return res.status(400).json({
                message: 'geofence_code is required.'
            });
        }

        const [result] = await db.query(
            `UPDATE vehicle_geofences
          SET active = 0,
              updated_at = NOW()
        WHERE geofence_code = ?`,
            [geofence_code]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                message: 'Geo-fence not found.'
            });
        }

        return res.status(200).json({
            message: 'Geo-fence deactivated successfully.',
            geofence_code
        });

    } catch (error) {
        logger.error('Error deleting geo-fence:', error);

        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});

/**
 * Manual trigger for testing.
 */
router.post('/check-geofences-now', jwtAuth.verifyToken, async (req, res) => {
    try {
        const result = await processGeofenceTracking();

        return res.status(200).json({
            message: 'Geo-fence check completed.',
            ...result
        });

    } catch (error) {
        logger.error('Manual geo-fence check failed:', error);

        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});

/**
 * Event logs.
 */
router.get('/geofence-events', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            geofence_code,
            vehicle_ID,
            vehicle_number,
            event_type,
            page = 1,
            limit = 20
        } = req.query;

        const conditions = [];
        const values = [];

        if (geofence_code) {
            conditions.push('geofence_code = ?');
            values.push(geofence_code);
        }

        if (vehicle_ID) {
            conditions.push('vehicle_ID = ?');
            values.push(vehicle_ID);
        }

        if (vehicle_number) {
            conditions.push('vehicle_number = ?');
            values.push(vehicle_number);
        }

        if (event_type) {
            conditions.push('event_type = ?');
            values.push(event_type);
        }

        const pageNum = Math.max(1, Number(page));
        const limitNum = Math.max(1, Number(limit));
        const offset = (pageNum - 1) * limitNum;

        let query = `SELECT * FROM vehicle_geofence_events`;

        if (conditions.length) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` ORDER BY event_id DESC LIMIT ? OFFSET ?`;
        values.push(limitNum, offset);

        const [events] = await db.query(query, values);

        return res.status(200).json({
            message: 'Geo-fence events fetched successfully.',
            page: pageNum,
            limit: limitNum,
            events
        });

    } catch (error) {
        logger.error('Error fetching geo-fence events:', error);

        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});

/* ============================================================================
   CRON
============================================================================ */

if (GEOFENCE_CRON_ENABLED) {
    cron.schedule(GEOFENCE_CRON_SCHEDULE, async () => {
        if (isGeofenceJobRunning) {
            logger.warn('Geo-fence cron skipped because previous run is still active.');
            return;
        }

        isGeofenceJobRunning = true;

        try {
            logger.info('Running geo-fence tracking cron...');

            const result = await processGeofenceTracking();

            logger.info('Geo-fence tracking cron completed.', {
                checkedVehicles: result.checkedVehicles,
                checkedGeofences: result.checkedGeofences
            });

        } catch (error) {
            logger.error('Geo-fence tracking cron failed:', error);
        } finally {
            isGeofenceJobRunning = false;
        }
    });
}

module.exports = router;