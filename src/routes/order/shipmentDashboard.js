const express = require('express');
const axios = require('axios');
const router = express.Router();

const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');
const cfg = require('../../config');

const OPENWEATHER_API_KEY = (
  cfg.openWeatherApiKey ||
  process.env.OPENWEATHER_API_KEY ||
  ''
).trim();

/* ---------------- HELPERS ---------------- */

function safeJSONParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function normalizeStatus(status = '') {
  return String(status || '')
    .toLowerCase()
    .replace(/_/g, '-')
    .trim();
}

function formatEta(dateVal) {
  if (!dateVal) return null;

  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return null;

  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata'
  });
}

function getPathFromOrder(order, stops = [], latestGps = null) {
  const path = [];

  const allocations = safeJSONParse(order.allocations, []);
  const firstAlloc = Array.isArray(allocations) ? allocations[0] : null;
  const route = firstAlloc?.route || [];

  if (Array.isArray(route) && route.length) {
    route.forEach((leg, index) => {
      if (index === 0 && leg.start?.latitude && leg.start?.longitude) {
        path.push({
          lat: Number(leg.start.latitude),
          lng: Number(leg.start.longitude)
        });
      }

      if (leg.end?.latitude && leg.end?.longitude) {
        path.push({
          lat: Number(leg.end.latitude),
          lng: Number(leg.end.longitude)
        });
      }
    });
  }

  if (!path.length && Array.isArray(stops)) {
    stops.forEach(stop => {
      if (stop.latitude && stop.longitude) {
        path.push({
          lat: Number(stop.latitude),
          lng: Number(stop.longitude)
        });
      }
    });
  }

  if (latestGps?.latitude && latestGps?.longitude) {
    const gpsPoint = {
      lat: Number(latestGps.latitude),
      lng: Number(latestGps.longitude)
    };

    path.unshift(gpsPoint);
  }

  return path;
}

function calculateProgress(trackingStatus, stops = []) {
  const status = normalizeStatus(trackingStatus);

  if (status === 'trip-ended') return 100;
  if (!Array.isArray(stops) || !stops.length) return 0;

  let score = 0;

  for (const stop of stops) {
    const s = normalizeStatus(stop.status);

    if (s === 'departed' || s === 'skipped') {
      score += 1;
    } else if (s === 'arrived' || s === 'unloading') {
      score += 0.5;
    }
  }

  return Math.min(100, Math.round((score / stops.length) * 100));
}

function getNextEta(stops = []) {
  const nextStop = stops.find(s =>
    ['planned', 'arrived', 'unloading'].includes(normalizeStatus(s.status))
  );

  if (nextStop?.planned_eta) {
    return formatEta(nextStop.planned_eta);
  }

  return null;
}

function calculateDelaySeconds(stops = []) {
  return stops.reduce((sum, stop) => {
    if (stop.delay_sec) return sum + Number(stop.delay_sec || 0);

    if (stop.planned_eta && stop.actual_arrival) {
      const planned = new Date(stop.planned_eta).getTime();
      const actual = new Date(stop.actual_arrival).getTime();

      if (!Number.isNaN(planned) && !Number.isNaN(actual) && actual > planned) {
        return sum + Math.round((actual - planned) / 1000);
      }
    }

    return sum;
  }, 0);
}

function getStatusLabel(trackingStatus, assignedStatus, risk) {
  const ts = normalizeStatus(trackingStatus);
  const as = normalizeStatus(assignedStatus);

  if (ts === 'trip-ended') return 'Delivered';
  if (risk === 'High') return 'At Risk';

  if (ts === 'in-transit' || as === 'in-transit') {
    return 'On Track';
  }

  if (ts === 'trip-started') return 'Trip Started';
  if (ts === 'created' || as === 'assigned') return 'Assigned';

  return 'Pending';
}

async function fetchWeatherForPoint(lat, lng) {
  if (!OPENWEATHER_API_KEY || lat == null || lng == null) return null;

  try {
    const response = await axios.get(
      'https://api.openweathermap.org/data/2.5/weather',
      {
        params: {
          lat,
          lon: lng,
          appid: OPENWEATHER_API_KEY,
          units: 'metric'
        },
        timeout: 4000
      }
    );

    const d = response.data || {};

    return {
      condition: d.weather?.[0]?.main || null,
      description: d.weather?.[0]?.description || null,
      temp: d.main?.temp ?? null,
      humidity: d.main?.humidity ?? null,
      windSpeed: d.wind?.speed ?? null,
      visibility: d.visibility ?? null,
      rain1h: d.rain?.['1h'] || 0,
      snow1h: d.snow?.['1h'] || 0
    };
  } catch (err) {
    logger.warn('OpenWeather fetch failed', {
      message: err.message,
      lat,
      lng
    });

    return null;
  }
}

function buildInsights({ weather, delaySeconds }) {
  const insights = [];

  if (!weather) {
    insights.push({
      title: 'Weather',
      insight: 'Weather data not available',
      tag: 'LOW'
    });
  } else {
    const condition = String(weather.condition || '').toLowerCase();
    const desc = weather.description || weather.condition || 'Weather update';

    if (
      condition.includes('thunderstorm') ||
      weather.rain1h >= 5 ||
      weather.snow1h >= 5
    ) {
      insights.push({
        title: 'Weather',
        insight: `Severe weather observed: ${desc}`,
        tag: 'HIGH'
      });
    } else if (
      condition.includes('rain') ||
      condition.includes('drizzle') ||
      weather.rain1h > 0
    ) {
      insights.push({
        title: 'Weather',
        insight: `Rain expected/observed: ${desc}`,
        tag: 'MEDIUM'
      });
    } else if (
      condition.includes('fog') ||
      condition.includes('mist') ||
      condition.includes('haze') ||
      condition.includes('smoke')
    ) {
      insights.push({
        title: 'Fog',
        insight: `Low visibility condition: ${desc}`,
        tag: 'MEDIUM'
      });
    } else {
      insights.push({
        title: 'Weather',
        insight: 'Weather looks normal on current route point',
        tag: 'LOW'
      });
    }
  }

  if (delaySeconds > 3600) {
    insights.push({
      title: 'Traffic',
      insight: `Trip delay crossed ${Math.round(delaySeconds / 60)} minutes`,
      tag: 'HIGH'
    });
  } else {
    insights.push({
      title: 'Traffic',
      insight: 'No major traffic delay detected',
      tag: 'LOW'
    });
  }

  insights.push({
    title: 'Port',
    insight: 'No live port congestion feed connected',
    tag: 'LOW'
  });

  insights.push({
    title: 'Rail',
    insight: 'No live rail delay feed connected',
    tag: 'LOW'
  });

  return insights;
}

function calculateRisk(insights, lastGpsTime, trackingStatus) {
  if (insights.some(i => i.tag === 'HIGH')) return 'High';
  if (insights.some(i => i.tag === 'MEDIUM')) return 'Medium';

  const ts = normalizeStatus(trackingStatus);

  if (ts === 'in-transit' && lastGpsTime) {
    const last = new Date(lastGpsTime).getTime();
    const diffMinutes = (Date.now() - last) / 1000 / 60;

    if (!Number.isNaN(last) && diffMinutes > 120) {
      return 'Medium';
    }
  }

  return 'Low';
}

/* ---------------- API ---------------- */

router.get('/shipment-dashboard', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();

  try {
    const includeWeather = String(req.query.includeWeather || 'true') === 'true';
    const weatherLimit = Math.max(1, Number(req.query.weatherLimit || 10));

    const [activeRows] = await conn.query(`
      SELECT
        o.order_ID,
        o.start_loc_ID,
        o.end_loc_ID,
        o.allocations,
        o.created_at,
        o.order_status,

        sf.loc_desc AS start_location,
        sf.latitude AS start_latitude,
        sf.longitude AS start_longitude,

        ef.loc_desc AS end_location,
        ef.latitude AS end_latitude,
        ef.longitude AS end_longitude,

        ao.assign_ID,
        ao.assigned_order_status,
        ao.assigned_vehicle_data,

        ts.tracking_id,
        ts.vehicle_ID,
        ts.device_id,
        ts.vehicle_num,
        ts.trip_started_at,
        ts.trip_ended_at,
        ts.status AS tracking_status,
        ts.last_gps_time

      FROM orders o

      LEFT JOIN (
        SELECT a1.*
        FROM assigning_orders a1
        INNER JOIN (
          SELECT order_ID, MAX(assigning_id) AS max_assigning_id
          FROM assigning_orders
          GROUP BY order_ID
        ) ax
          ON ax.order_ID = a1.order_ID
         AND ax.max_assigning_id = a1.assigning_id
      ) ao
        ON ao.order_ID = o.order_ID

      LEFT JOIN (
        SELECT t1.*
        FROM order_tracking_sessions t1
        INNER JOIN (
          SELECT order_id, MAX(tracking_id) AS max_tracking_id
          FROM order_tracking_sessions
          GROUP BY order_id
        ) tx
          ON tx.order_id = t1.order_id
         AND tx.max_tracking_id = t1.tracking_id
      ) ts
        ON ts.order_id = o.order_ID

      LEFT JOIN master_locations sf
        ON sf.loc_ID = o.start_loc_ID

      LEFT JOIN master_locations ef
        ON ef.loc_ID = o.end_loc_ID

      WHERE
        (
          LOWER(COALESCE(ao.assigned_order_status, '')) IN ('assigned', 'in-transit', 'in transit')
          OR ts.status IN ('created', 'trip_started', 'in_transit')
        )
        AND COALESCE(ts.status, '') <> 'trip_ended'

      ORDER BY o.created_at DESC
    `);

    const trackingIds = activeRows.map(r => r.tracking_id).filter(Boolean);

    const stopMap = {};
    const gpsMap = {};

    if (trackingIds.length) {
      const [stops] = await conn.query(
        `
        SELECT *
        FROM order_stop_tracking
        WHERE tracking_id IN (?)
        ORDER BY tracking_id, stop_no
        `,
        [trackingIds]
      );

      stops.forEach(stop => {
        if (!stopMap[stop.tracking_id]) stopMap[stop.tracking_id] = [];
        stopMap[stop.tracking_id].push(stop);
      });

      const [latestGpsRows] = await conn.query(
        `
        SELECT v1.*
        FROM vehicle_gps_logs v1
        INNER JOIN (
          SELECT tracking_id, MAX(recorded_at) AS max_recorded_at
          FROM vehicle_gps_logs
          WHERE tracking_id IN (?)
          GROUP BY tracking_id
        ) vx
          ON vx.tracking_id = v1.tracking_id
         AND vx.max_recorded_at = v1.recorded_at
        `,
        [trackingIds]
      );

      latestGpsRows.forEach(gps => {
        gpsMap[gps.tracking_id] = gps;
      });
    }

    const shipments = [];

    for (let i = 0; i < activeRows.length; i++) {
      const row = activeRows[i];
      const stops = stopMap[row.tracking_id] || [];
      const latestGps = gpsMap[row.tracking_id] || null;

      const progress = calculateProgress(row.tracking_status, stops);
      const delaySeconds = calculateDelaySeconds(stops);

      const weatherPoint =
        latestGps?.latitude && latestGps?.longitude
          ? { lat: latestGps.latitude, lng: latestGps.longitude }
          : stops.find(s => ['planned', 'arrived'].includes(normalizeStatus(s.status)))
            ? {
                lat: stops.find(s => ['planned', 'arrived'].includes(normalizeStatus(s.status))).latitude,
                lng: stops.find(s => ['planned', 'arrived'].includes(normalizeStatus(s.status))).longitude
              }
            : row.end_latitude && row.end_longitude
              ? { lat: row.end_latitude, lng: row.end_longitude }
              : null;

      let weather = null;

      if (includeWeather && weatherPoint && i < weatherLimit) {
        weather = await fetchWeatherForPoint(weatherPoint.lat, weatherPoint.lng);
      }

      const insights = buildInsights({
        weather,
        delaySeconds
      });

      const risk = calculateRisk(
        insights,
        row.last_gps_time,
        row.tracking_status
      );

      shipments.push({
        id: row.order_ID,
        start: row.start_location || row.start_loc_ID || null,
        stop: row.end_location || row.end_loc_ID || null,
        mode: 'Road',
        status: getStatusLabel(
          row.tracking_status,
          row.assigned_order_status,
          risk
        ),
        eta: getNextEta(stops),
        progress,
        risk,
        path: getPathFromOrder(row, stops, latestGps),

        tracking: {
          tracking_id: row.tracking_id,
          tracking_status: row.tracking_status,
          vehicle_ID: row.vehicle_ID,
          vehicle_num: row.vehicle_num,
          device_id: row.device_id,
          trip_started_at: row.trip_started_at,
          last_gps_time: row.last_gps_time
        },

        assignment: {
          assign_ID: row.assign_ID,
          assigned_order_status: row.assigned_order_status,
          assigned_vehicle_data: safeJSONParse(row.assigned_vehicle_data, [])
        },

        current_position: latestGps
          ? {
              lat: Number(latestGps.latitude),
              lng: Number(latestGps.longitude),
              speed: Number(latestGps.speed || 0),
              recorded_at: latestGps.recorded_at
            }
          : null,

        stops,
        insights,
        weather
      });
    }

    const [[onTimeStats]] = await conn.query(`
      SELECT
        SUM(
          CASE
            WHEN actual_arrival IS NOT NULL
             AND planned_eta IS NOT NULL
             AND actual_arrival <= planned_eta
            THEN 1 ELSE 0
          END
        ) AS on_time_count,
        SUM(
          CASE
            WHEN actual_arrival IS NOT NULL
             AND planned_eta IS NOT NULL
            THEN 1 ELSE 0
          END
        ) AS measured_count
      FROM order_stop_tracking
    `);

    const measuredCount = Number(onTimeStats.measured_count || 0);
    const onTimeCount = Number(onTimeStats.on_time_count || 0);

    const onTimeDelivery = measuredCount
      ? Math.round((onTimeCount / measuredCount) * 100)
      : 0;

    const avgTransitTime = shipments.length
      ? round2(
          shipments.reduce((sum, s) => sum + Number(s.progress || 0), 0) /
            shipments.length
        )
      : 0;

    return res.status(200).json({
      message: 'Shipment dashboard fetched successfully',
      summary: {
        activeShipments: shipments.length,
        onTimeDelivery,
        avgTransitTime
      },
      shipments
    });

  } catch (err) {
    logger.error('shipment-dashboard failed', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  } finally {
    conn.release();
  }
});

module.exports = router;