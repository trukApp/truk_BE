// const express = require('express');
// const axios = require('axios');
// const router = express.Router();

// const db = require('../../../dbConnection');
// const { logger } = require('../../logger/logger');
// const jwtAuth = require('../../JWT/jwtAuth');
// const cfg = require('../../config');

// const OPENWEATHER_API_KEY = (
//   cfg.openWeatherApiKey ||
//   process.env.OPENWEATHER_API_KEY ||
//   ''
// ).trim();

// /* ---------------- HELPERS ---------------- */

// function safeJSONParse(value, fallback = null) {
//   if (!value) return fallback;
//   if (typeof value === 'object') return value;

//   try {
//     return JSON.parse(value);
//   } catch {
//     return fallback;
//   }
// }

// function round2(num) {
//   return Math.round((Number(num) || 0) * 100) / 100;
// }

// function normalizeStatus(status = '') {
//   return String(status || '')
//     .toLowerCase()
//     .replace(/_/g, '-')
//     .trim();
// }

// function formatEta(dateVal) {
//   if (!dateVal) return null;

//   const d = new Date(dateVal);
//   if (Number.isNaN(d.getTime())) return null;

//   return d.toLocaleString('en-IN', {
//     day: 'numeric',
//     month: 'short',
//     hour: '2-digit',
//     minute: '2-digit',
//     hour12: true,
//     timeZone: 'Asia/Kolkata'
//   });
// }

// function getPathFromOrder(order, stops = [], latestGps = null) {
//   const path = [];

//   const allocations = safeJSONParse(order.allocations, []);
//   const firstAlloc = Array.isArray(allocations) ? allocations[0] : null;
//   const route = firstAlloc?.route || [];

//   if (Array.isArray(route) && route.length) {
//     route.forEach((leg, index) => {
//       if (index === 0 && leg.start?.latitude && leg.start?.longitude) {
//         path.push({
//           lat: Number(leg.start.latitude),
//           lng: Number(leg.start.longitude)
//         });
//       }

//       if (leg.end?.latitude && leg.end?.longitude) {
//         path.push({
//           lat: Number(leg.end.latitude),
//           lng: Number(leg.end.longitude)
//         });
//       }
//     });
//   }

//   if (!path.length && Array.isArray(stops)) {
//     stops.forEach(stop => {
//       if (stop.latitude && stop.longitude) {
//         path.push({
//           lat: Number(stop.latitude),
//           lng: Number(stop.longitude)
//         });
//       }
//     });
//   }

//   if (latestGps?.latitude && latestGps?.longitude) {
//     const gpsPoint = {
//       lat: Number(latestGps.latitude),
//       lng: Number(latestGps.longitude)
//     };

//     path.unshift(gpsPoint);
//   }

//   return path;
// }

// function calculateProgress(trackingStatus, stops = []) {
//   const status = normalizeStatus(trackingStatus);

//   if (status === 'trip-ended') return 100;
//   if (!Array.isArray(stops) || !stops.length) return 0;

//   let score = 0;

//   for (const stop of stops) {
//     const s = normalizeStatus(stop.status);

//     if (s === 'departed' || s === 'skipped') {
//       score += 1;
//     } else if (s === 'arrived' || s === 'unloading') {
//       score += 0.5;
//     }
//   }

//   return Math.min(100, Math.round((score / stops.length) * 100));
// }

// function getNextEta(stops = []) {
//   const nextStop = stops.find(s =>
//     ['planned', 'arrived', 'unloading'].includes(normalizeStatus(s.status))
//   );

//   if (nextStop?.planned_eta) {
//     return formatEta(nextStop.planned_eta);
//   }

//   return null;
// }

// function calculateDelaySeconds(stops = []) {
//   return stops.reduce((sum, stop) => {
//     if (stop.delay_sec) return sum + Number(stop.delay_sec || 0);

//     if (stop.planned_eta && stop.actual_arrival) {
//       const planned = new Date(stop.planned_eta).getTime();
//       const actual = new Date(stop.actual_arrival).getTime();

//       if (!Number.isNaN(planned) && !Number.isNaN(actual) && actual > planned) {
//         return sum + Math.round((actual - planned) / 1000);
//       }
//     }

//     return sum;
//   }, 0);
// }

// function getStatusLabel(trackingStatus, assignedStatus, risk) {
//   const ts = normalizeStatus(trackingStatus);
//   const as = normalizeStatus(assignedStatus);

//   if (ts === 'trip-ended') return 'Delivered';
//   if (risk === 'High') return 'At Risk';

//   if (ts === 'in-transit' || as === 'in-transit') {
//     return 'On Track';
//   }

//   if (ts === 'trip-started') return 'Trip Started';
//   if (ts === 'created' || as === 'assigned') return 'Assigned';

//   return 'Pending';
// }

// async function fetchWeatherForPoint(lat, lng) {
//   if (!OPENWEATHER_API_KEY || lat == null || lng == null) return null;

//   try {
//     const response = await axios.get(
//       'https://api.openweathermap.org/data/2.5/weather',
//       {
//         params: {
//           lat,
//           lon: lng,
//           appid: OPENWEATHER_API_KEY,
//           units: 'metric'
//         },
//         timeout: 4000
//       }
//     );

//     const d = response.data || {};

//     return {
//       condition: d.weather?.[0]?.main || null,
//       description: d.weather?.[0]?.description || null,
//       temp: d.main?.temp ?? null,
//       humidity: d.main?.humidity ?? null,
//       windSpeed: d.wind?.speed ?? null,
//       visibility: d.visibility ?? null,
//       rain1h: d.rain?.['1h'] || 0,
//       snow1h: d.snow?.['1h'] || 0
//     };
//   } catch (err) {
//     logger.warn('OpenWeather fetch failed', {
//       message: err.message,
//       lat,
//       lng
//     });

//     return null;
//   }
// }

// function buildInsights({ weather, delaySeconds }) {
//   const insights = [];

//   if (!weather) {
//     insights.push({
//       title: 'Weather',
//       insight: 'Weather data not available',
//       tag: 'LOW'
//     });
//   } else {
//     const condition = String(weather.condition || '').toLowerCase();
//     const desc = weather.description || weather.condition || 'Weather update';

//     if (
//       condition.includes('thunderstorm') ||
//       weather.rain1h >= 5 ||
//       weather.snow1h >= 5
//     ) {
//       insights.push({
//         title: 'Weather',
//         insight: `Severe weather observed: ${desc}`,
//         tag: 'HIGH'
//       });
//     } else if (
//       condition.includes('rain') ||
//       condition.includes('drizzle') ||
//       weather.rain1h > 0
//     ) {
//       insights.push({
//         title: 'Weather',
//         insight: `Rain expected/observed: ${desc}`,
//         tag: 'MEDIUM'
//       });
//     } else if (
//       condition.includes('fog') ||
//       condition.includes('mist') ||
//       condition.includes('haze') ||
//       condition.includes('smoke')
//     ) {
//       insights.push({
//         title: 'Fog',
//         insight: `Low visibility condition: ${desc}`,
//         tag: 'MEDIUM'
//       });
//     } else {
//       insights.push({
//         title: 'Weather',
//         insight: 'Weather looks normal on current route point',
//         tag: 'LOW'
//       });
//     }
//   }

//   if (delaySeconds > 3600) {
//     insights.push({
//       title: 'Traffic',
//       insight: `Trip delay crossed ${Math.round(delaySeconds / 60)} minutes`,
//       tag: 'HIGH'
//     });
//   } else {
//     insights.push({
//       title: 'Traffic',
//       insight: 'No major traffic delay detected',
//       tag: 'LOW'
//     });
//   }

//   insights.push({
//     title: 'Port',
//     insight: 'No live port congestion feed connected',
//     tag: 'LOW'
//   });

//   insights.push({
//     title: 'Rail',
//     insight: 'No live rail delay feed connected',
//     tag: 'LOW'
//   });

//   return insights;
// }

// function calculateRisk(insights, lastGpsTime, trackingStatus) {
//   if (insights.some(i => i.tag === 'HIGH')) return 'High';
//   if (insights.some(i => i.tag === 'MEDIUM')) return 'Medium';

//   const ts = normalizeStatus(trackingStatus);

//   if (ts === 'in-transit' && lastGpsTime) {
//     const last = new Date(lastGpsTime).getTime();
//     const diffMinutes = (Date.now() - last) / 1000 / 60;

//     if (!Number.isNaN(last) && diffMinutes > 120) {
//       return 'Medium';
//     }
//   }

//   return 'Low';
// }

// /* ---------------- API ---------------- */

// router.get('/shipment-dashboard', jwtAuth.verifyToken, async (req, res) => {
//   const conn = await db.getConnection();

//   try {
//     const includeWeather = String(req.query.includeWeather || 'true') === 'true';
//     const weatherLimit = Math.max(1, Number(req.query.weatherLimit || 10));

//     const [activeRows] = await conn.query(`
//       SELECT
//         o.order_ID,
//         o.start_loc_ID,
//         o.end_loc_ID,
//         o.allocations,
//         o.created_at,
//         o.order_status,

//         sf.loc_desc AS start_location,
//         sf.latitude AS start_latitude,
//         sf.longitude AS start_longitude,

//         ef.loc_desc AS end_location,
//         ef.latitude AS end_latitude,
//         ef.longitude AS end_longitude,

//         ao.assign_ID,
//         ao.assigned_order_status,
//         ao.assigned_vehicle_data,

//         ts.tracking_id,
//         ts.vehicle_ID,
//         ts.device_id,
//         ts.vehicle_num,
//         ts.trip_started_at,
//         ts.trip_ended_at,
//         ts.status AS tracking_status,
//         ts.last_gps_time

//       FROM orders o

//       LEFT JOIN (
//         SELECT a1.*
//         FROM assigning_orders a1
//         INNER JOIN (
//           SELECT order_ID, MAX(assigning_id) AS max_assigning_id
//           FROM assigning_orders
//           GROUP BY order_ID
//         ) ax
//           ON ax.order_ID = a1.order_ID
//          AND ax.max_assigning_id = a1.assigning_id
//       ) ao
//         ON ao.order_ID = o.order_ID

//       LEFT JOIN (
//         SELECT t1.*
//         FROM order_tracking_sessions t1
//         INNER JOIN (
//           SELECT order_id, MAX(tracking_id) AS max_tracking_id
//           FROM order_tracking_sessions
//           GROUP BY order_id
//         ) tx
//           ON tx.order_id = t1.order_id
//          AND tx.max_tracking_id = t1.tracking_id
//       ) ts
//         ON ts.order_id = o.order_ID

//       LEFT JOIN master_locations sf
//         ON sf.loc_ID = o.start_loc_ID

//       LEFT JOIN master_locations ef
//         ON ef.loc_ID = o.end_loc_ID

//       WHERE
//         (
//           LOWER(COALESCE(ao.assigned_order_status, '')) IN ('assigned', 'in-transit', 'in transit')
//           OR ts.status IN ('created', 'trip_started', 'in_transit')
//         )
//         AND COALESCE(ts.status, '') <> 'trip_ended'

//       ORDER BY o.created_at DESC
//     `);

//     const trackingIds = activeRows.map(r => r.tracking_id).filter(Boolean);

//     const stopMap = {};
//     const gpsMap = {};

//     if (trackingIds.length) {
//       const [stops] = await conn.query(
//         `
//         SELECT *
//         FROM order_stop_tracking
//         WHERE tracking_id IN (?)
//         ORDER BY tracking_id, stop_no
//         `,
//         [trackingIds]
//       );

//       stops.forEach(stop => {
//         if (!stopMap[stop.tracking_id]) stopMap[stop.tracking_id] = [];
//         stopMap[stop.tracking_id].push(stop);
//       });

//       const [latestGpsRows] = await conn.query(
//         `
//         SELECT v1.*
//         FROM vehicle_gps_logs v1
//         INNER JOIN (
//           SELECT tracking_id, MAX(recorded_at) AS max_recorded_at
//           FROM vehicle_gps_logs
//           WHERE tracking_id IN (?)
//           GROUP BY tracking_id
//         ) vx
//           ON vx.tracking_id = v1.tracking_id
//          AND vx.max_recorded_at = v1.recorded_at
//         `,
//         [trackingIds]
//       );

//       latestGpsRows.forEach(gps => {
//         gpsMap[gps.tracking_id] = gps;
//       });
//     }

//     const shipments = [];

//     for (let i = 0; i < activeRows.length; i++) {
//       const row = activeRows[i];
//       const stops = stopMap[row.tracking_id] || [];
//       const latestGps = gpsMap[row.tracking_id] || null;

//       const progress = calculateProgress(row.tracking_status, stops);
//       const delaySeconds = calculateDelaySeconds(stops);

//       const weatherPoint =
//         latestGps?.latitude && latestGps?.longitude
//           ? { lat: latestGps.latitude, lng: latestGps.longitude }
//           : stops.find(s => ['planned', 'arrived'].includes(normalizeStatus(s.status)))
//             ? {
//                 lat: stops.find(s => ['planned', 'arrived'].includes(normalizeStatus(s.status))).latitude,
//                 lng: stops.find(s => ['planned', 'arrived'].includes(normalizeStatus(s.status))).longitude
//               }
//             : row.end_latitude && row.end_longitude
//               ? { lat: row.end_latitude, lng: row.end_longitude }
//               : null;

//       let weather = null;

//       if (includeWeather && weatherPoint && i < weatherLimit) {
//         weather = await fetchWeatherForPoint(weatherPoint.lat, weatherPoint.lng);
//       }

//       const insights = buildInsights({
//         weather,
//         delaySeconds
//       });

//       const risk = calculateRisk(
//         insights,
//         row.last_gps_time,
//         row.tracking_status
//       );

//       shipments.push({
//         id: row.order_ID,
//         start: row.start_location || row.start_loc_ID || null,
//         stop: row.end_location || row.end_loc_ID || null,
//         mode: 'Road',
//         status: getStatusLabel(
//           row.tracking_status,
//           row.assigned_order_status,
//           risk
//         ),
//         eta: getNextEta(stops),
//         progress,
//         risk,
//         path: getPathFromOrder(row, stops, latestGps),

//         tracking: {
//           tracking_id: row.tracking_id,
//           tracking_status: row.tracking_status,
//           vehicle_ID: row.vehicle_ID,
//           vehicle_num: row.vehicle_num,
//           device_id: row.device_id,
//           trip_started_at: row.trip_started_at,
//           last_gps_time: row.last_gps_time
//         },

//         assignment: {
//           assign_ID: row.assign_ID,
//           assigned_order_status: row.assigned_order_status,
//           assigned_vehicle_data: safeJSONParse(row.assigned_vehicle_data, [])
//         },

//         current_position: latestGps
//           ? {
//               lat: Number(latestGps.latitude),
//               lng: Number(latestGps.longitude),
//               speed: Number(latestGps.speed || 0),
//               recorded_at: latestGps.recorded_at
//             }
//           : null,

//         stops,
//         insights,
//         weather
//       });
//     }

//     const [[onTimeStats]] = await conn.query(`
//       SELECT
//         SUM(
//           CASE
//             WHEN actual_arrival IS NOT NULL
//              AND planned_eta IS NOT NULL
//              AND actual_arrival <= planned_eta
//             THEN 1 ELSE 0
//           END
//         ) AS on_time_count,
//         SUM(
//           CASE
//             WHEN actual_arrival IS NOT NULL
//              AND planned_eta IS NOT NULL
//             THEN 1 ELSE 0
//           END
//         ) AS measured_count
//       FROM order_stop_tracking
//     `);

//     const measuredCount = Number(onTimeStats.measured_count || 0);
//     const onTimeCount = Number(onTimeStats.on_time_count || 0);

//     const onTimeDelivery = measuredCount
//       ? Math.round((onTimeCount / measuredCount) * 100)
//       : 0;

//     const avgTransitTime = shipments.length
//       ? round2(
//           shipments.reduce((sum, s) => sum + Number(s.progress || 0), 0) /
//             shipments.length
//         )
//       : 0;

//     return res.status(200).json({
//       message: 'Shipment dashboard fetched successfully',
//       summary: {
//         activeShipments: shipments.length,
//         onTimeDelivery,
//         avgTransitTime
//       },
//       shipments
//     });

//   } catch (err) {
//     logger.error('shipment-dashboard failed', err);
//     return res.status(500).json({
//       message: 'Server error',
//       error: err.message
//     });
//   } finally {
//     conn.release();
//   }
// });

// module.exports = router;


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

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
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

function isTripStarted(row) {
  const ts = normalizeStatus(row.tracking_status);

  return (
    ts === 'in-transit' ||
    ts === 'trip-started' ||
    !!row.trip_started_at
  );
}

function isTripEnded(row) {
  return normalizeStatus(row.tracking_status) === 'trip-ended';
}

function isPlannedTrip(row) {
  const ts = normalizeStatus(row.tracking_status);
  const as = normalizeStatus(row.assigned_order_status);

  return (
    !row.trip_started_at &&
    !row.trip_ended_at &&
    (
      ts === 'created' ||
      as === 'assigned' ||
      row.order_status === 'self assigned' ||
      row.order_status === 'assignment pending'
    )
  );
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
      if (stop.latitude != null && stop.longitude != null) {
        path.push({
          lat: Number(stop.latitude),
          lng: Number(stop.longitude)
        });
      }
    });
  }

  if (latestGps?.latitude != null && latestGps?.longitude != null) {
    const gpsPoint = {
      lat: Number(latestGps.latitude),
      lng: Number(latestGps.longitude)
    };

    const alreadyExists = path.some(
      p => p.lat === gpsPoint.lat && p.lng === gpsPoint.lng
    );

    if (!alreadyExists) {
      path.unshift(gpsPoint);
    }
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
  if (!Array.isArray(stops) || !stops.length) return null;

  const nextStop = stops.find(s =>
    ['planned', 'arrived', 'unloading'].includes(normalizeStatus(s.status))
  );

  if (nextStop?.planned_eta) {
    return formatEta(nextStop.planned_eta);
  }

  const lastEtaStop = [...stops].reverse().find(s => s.planned_eta);

  return lastEtaStop?.planned_eta
    ? formatEta(lastEtaStop.planned_eta)
    : null;
}

function getLiveDelaySeconds(stops = []) {
  if (!Array.isArray(stops)) return 0;

  let delaySeconds = 0;
  const now = Date.now();

  for (const stop of stops) {
    const stopStatus = normalizeStatus(stop.status);

    if (stop.delay_sec) {
      delaySeconds += Number(stop.delay_sec || 0);
      continue;
    }

    if (stop.planned_eta && stop.actual_arrival) {
      const planned = new Date(stop.planned_eta).getTime();
      const actual = new Date(stop.actual_arrival).getTime();

      if (!Number.isNaN(planned) && !Number.isNaN(actual) && actual > planned) {
        delaySeconds += Math.round((actual - planned) / 1000);
      }

      continue;
    }

    if (
      stop.planned_eta &&
      ['planned', 'arrived', 'unloading'].includes(stopStatus)
    ) {
      const planned = new Date(stop.planned_eta).getTime();

      if (!Number.isNaN(planned) && now > planned) {
        delaySeconds += Math.round((now - planned) / 1000);
      }
    }
  }

  return delaySeconds;
}

function getStatusLabel(trackingStatus, assignedStatus, segment) {
  const ts = normalizeStatus(trackingStatus);
  const as = normalizeStatus(assignedStatus);

  if (ts === 'trip-ended') return 'Delivered';
  if (segment === 'critical') return 'Critical';
  if (segment === 'delayed') return 'Delayed';
  if (segment === 'on-track') return 'On Track';
  if (segment === 'planned') return 'Planned';

  if (ts === 'in-transit' || as === 'in-transit') return 'On Track';
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

function buildInsights({ weather, delaySeconds, latestGps, row }) {
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
      condition.includes('smoke') ||
      Number(weather.visibility || 999999) < 1000
    ) {
      insights.push({
        title: 'Fog',
        insight: `Low visibility condition: ${desc}`,
        tag: 'MEDIUM'
      });
    } else if (Number(weather.windSpeed || 0) >= 12) {
      insights.push({
        title: 'Weather',
        insight: `High wind speed observed: ${weather.windSpeed} m/s`,
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

  if (delaySeconds >= 24 * 60 * 60) {
    insights.push({
      title: 'Delay',
      insight: `Shipment delayed by more than ${Math.floor(delaySeconds / 3600)} hours`,
      tag: 'HIGH'
    });
  } else if (delaySeconds > 3600) {
    insights.push({
      title: 'Traffic',
      insight: `Trip delay crossed ${Math.round(delaySeconds / 60)} minutes`,
      tag: 'MEDIUM'
    });
  } else {
    insights.push({
      title: 'Traffic',
      insight: 'No major traffic delay detected',
      tag: 'LOW'
    });
  }

  if (latestGps?.recorded_at && isTripStarted(row)) {
    const lastGps = new Date(latestGps.recorded_at).getTime();

    if (!Number.isNaN(lastGps)) {
      const diffMins = (Date.now() - lastGps) / 1000 / 60;

      if (diffMins > 24 * 60) {
        insights.push({
          title: 'GPS',
          insight: `GPS not updated for more than ${Math.round(diffMins / 60)} hours`,
          tag: 'HIGH'
        });
      } else if (diffMins > 120) {
        insights.push({
          title: 'GPS',
          insight: `GPS not updated for ${Math.round(diffMins)} minutes`,
          tag: 'MEDIUM'
        });
      }
    }
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

function calculateRisk(insights, delaySeconds) {
  if (delaySeconds >= 24 * 60 * 60) return 'High';
  if (insights.some(i => i.tag === 'HIGH')) return 'High';
  if (delaySeconds > 0) return 'Medium';
  if (insights.some(i => i.tag === 'MEDIUM')) return 'Medium';

  return 'Low';
}

function getDelayReason({ delaySeconds, weather, latestGps, row }) {
  const reasons = [];

  if (delaySeconds >= 24 * 60 * 60) {
    reasons.push(`Critical delay detected: ${Math.floor(delaySeconds / 3600)} hours`);
  } else if (delaySeconds > 0) {
    reasons.push(`ETA delay detected: ${Math.round(delaySeconds / 60)} minutes`);
  }

  if (weather) {
    const condition = String(weather.condition || '').toLowerCase();
    const desc = weather.description || weather.condition || 'Weather issue';

    if (
      condition.includes('rain') ||
      condition.includes('thunderstorm') ||
      condition.includes('drizzle') ||
      weather.rain1h > 0
    ) {
      reasons.push(`Bad weather: ${desc}`);
    }

    if (
      condition.includes('fog') ||
      condition.includes('mist') ||
      condition.includes('haze') ||
      condition.includes('smoke') ||
      Number(weather.visibility || 999999) < 1000
    ) {
      reasons.push(`Low visibility: ${desc}`);
    }

    if (Number(weather.windSpeed || 0) >= 12) {
      reasons.push(`High wind speed: ${weather.windSpeed} m/s`);
    }
  }

  if (latestGps?.recorded_at && isTripStarted(row)) {
    const lastGps = new Date(latestGps.recorded_at).getTime();

    if (!Number.isNaN(lastGps)) {
      const diffMins = (Date.now() - lastGps) / 1000 / 60;

      if (diffMins > 120) {
        reasons.push(`GPS not updated for ${Math.round(diffMins)} minutes`);
      }
    }
  }

  return reasons.length ? reasons : ['Running as expected'];
}

function getShipmentSegment({ row, delaySeconds, risk, weather, latestGps }) {
  if (isTripEnded(row)) {
    return 'completed';
  }

  if (isPlannedTrip(row)) {
    return 'planned';
  }

  if (isTripStarted(row)) {
    const moreThanOneDayDelay = delaySeconds >= 24 * 60 * 60;

    let gpsStaleCritical = false;

    if (latestGps?.recorded_at) {
      const lastGps = new Date(latestGps.recorded_at).getTime();

      if (!Number.isNaN(lastGps)) {
        gpsStaleCritical =
          ((Date.now() - lastGps) / 1000 / 60) > 24 * 60;
      }
    }

    if (moreThanOneDayDelay || gpsStaleCritical) {
      return 'critical';
    }

    const hasWeatherDelay = (() => {
      if (!weather) return false;

      const condition = String(weather.condition || '').toLowerCase();

      return (
        condition.includes('rain') ||
        condition.includes('thunderstorm') ||
        condition.includes('drizzle') ||
        condition.includes('fog') ||
        condition.includes('mist') ||
        condition.includes('haze') ||
        condition.includes('smoke') ||
        Number(weather.rain1h || 0) > 0 ||
        Number(weather.visibility || 999999) < 1000 ||
        Number(weather.windSpeed || 0) >= 12
      );
    })();

    if (delaySeconds > 0 || risk === 'Medium' || hasWeatherDelay) {
      return 'delayed';
    }

    return 'on-track';
  }

  return 'planned';
}

function getNearestStop(lat, lng, stops = []) {
  if (lat == null || lng == null || !Array.isArray(stops) || !stops.length) {
    return null;
  }

  let nearest = null;
  let minDistance = Infinity;

  for (const stop of stops) {
    if (stop.latitude == null || stop.longitude == null) continue;

    const distance = haversine(
      Number(lat),
      Number(lng),
      Number(stop.latitude),
      Number(stop.longitude)
    );

    if (distance < minDistance) {
      minDistance = distance;
      nearest = stop;
    }
  }

  if (!nearest) return null;

  return {
    stop_no: nearest.stop_no,
    loc_ID: nearest.loc_ID,
    status: nearest.status,
    distance_m: Math.round(minDistance)
  };
}

function buildCurrentPosition({ latestGps, row, stops }) {
  if (!isTripStarted(row)) {
    return null;
  }

  if (!latestGps) {
    return {
      available: false,
      message: 'Trip started but live GPS not available yet'
    };
  }

  return {
    available: true,
    lat: Number(latestGps.latitude),
    lng: Number(latestGps.longitude),
    speed: Number(latestGps.speed || 0),
    recorded_at: latestGps.recorded_at,
    source: 'vehicle_gps_logs',
    exact_location: {
      latitude: Number(latestGps.latitude),
      longitude: Number(latestGps.longitude)
    },
    nearest_stop: getNearestStop(
      latestGps.latitude,
      latestGps.longitude,
      stops
    )
  };
}

function getWeatherPoint(row, stops, latestGps) {
  if (latestGps?.latitude != null && latestGps?.longitude != null) {
    return {
      lat: latestGps.latitude,
      lng: latestGps.longitude
    };
  }

  const nextStop = stops.find(s =>
    ['planned', 'arrived', 'unloading'].includes(normalizeStatus(s.status))
  );

  if (nextStop?.latitude != null && nextStop?.longitude != null) {
    return {
      lat: nextStop.latitude,
      lng: nextStop.longitude
    };
  }

  if (row.end_latitude != null && row.end_longitude != null) {
    return {
      lat: row.end_latitude,
      lng: row.end_longitude
    };
  }

  return null;
}

function buildShipmentObject({
  row,
  stops,
  latestGps,
  weather
}) {
  const progress = calculateProgress(row.tracking_status, stops);
  const delaySeconds = getLiveDelaySeconds(stops);

  const insights = buildInsights({
    weather,
    delaySeconds,
    latestGps,
    row
  });

  const risk = calculateRisk(insights, delaySeconds);

  const segment = getShipmentSegment({
    row,
    delaySeconds,
    risk,
    weather,
    latestGps
  });

  const delayReasons = getDelayReason({
    delaySeconds,
    weather,
    latestGps,
    row
  });

  return {
    id: row.order_ID,
    start: row.start_location || row.start_loc_ID || null,
    stop: row.end_location || row.end_loc_ID || null,
    mode: 'Road',

    status: getStatusLabel(
      row.tracking_status,
      row.assigned_order_status,
      segment
    ),

    segment,
    eta: getNextEta(stops),
    progress,
    risk,

    delay: {
      is_delayed: delaySeconds > 0 || segment === 'delayed' || segment === 'critical',
      delay_seconds: delaySeconds,
      delay_minutes: Math.round(delaySeconds / 60),
      delay_hours: round2(delaySeconds / 3600),
      reasons: delayReasons
    },

    path: getPathFromOrder(row, stops, latestGps),

    current_position: buildCurrentPosition({
      latestGps,
      row,
      stops
    }),

    tracking: {
      tracking_id: row.tracking_id,
      tracking_status: row.tracking_status,
      vehicle_ID: row.vehicle_ID,
      vehicle_num: row.vehicle_num,
      device_id: row.device_id,
      trip_started_at: row.trip_started_at,
      trip_ended_at: row.trip_ended_at,
      last_gps_time: row.last_gps_time
    },

    assignment: {
      assign_ID: row.assign_ID,
      assigned_order_status: row.assigned_order_status,
      assigned_vehicle_data: safeJSONParse(row.assigned_vehicle_data, [])
    },

    stops,
    insights,
    weather
  };
}

/* ---------------- COMMON DATA LOADER ---------------- */

async function loadDashboardRows(conn) {
  const [rows] = await conn.query(`
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
        OR o.order_status IN ('self assigned', 'assignment pending')
      )
      AND COALESCE(ts.status, '') <> 'trip_ended'

    ORDER BY o.created_at DESC
  `);

  return rows;
}

async function loadStopsAndGps(conn, rows) {
  const trackingIds = rows.map(r => r.tracking_id).filter(Boolean);

  const stopMap = {};
  const gpsMap = {};

  if (!trackingIds.length) {
    return { stopMap, gpsMap };
  }

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
    if (!stopMap[stop.tracking_id]) {
      stopMap[stop.tracking_id] = [];
    }

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

  return { stopMap, gpsMap };
}

async function buildShipmentList({
  rows,
  stopMap,
  gpsMap,
  includeWeather,
  weatherLimit
}) {
  const shipments = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const stops = stopMap[row.tracking_id] || [];
    const latestGps = gpsMap[row.tracking_id] || null;

    const weatherPoint = getWeatherPoint(row, stops, latestGps);

    let weather = null;

    if (includeWeather && weatherPoint && i < weatherLimit) {
      weather = await fetchWeatherForPoint(
        weatherPoint.lat,
        weatherPoint.lng
      );
    }

    const shipment = buildShipmentObject({
      row,
      stops,
      latestGps,
      weather
    });

    shipments.push(shipment);
  }

  return shipments;
}

/* ---------------- API 1: MAIN SHIPMENT DASHBOARD ---------------- */

router.get('/shipment-dashboard', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();

  try {
    const includeWeather = String(req.query.includeWeather || 'true') === 'true';
    const weatherLimit = Math.max(1, Number(req.query.weatherLimit || 10));

    const rows = await loadDashboardRows(conn);
    const { stopMap, gpsMap } = await loadStopsAndGps(conn, rows);

    const shipments = await buildShipmentList({
      rows,
      stopMap,
      gpsMap,
      includeWeather,
      weatherLimit
    });

    const activeShipments = shipments.filter(s =>
      ['on-track', 'delayed', 'critical'].includes(s.segment)
    ).length;

    const onTrackShipments = shipments.filter(s => s.segment === 'on-track').length;
    const delayedShipments = shipments.filter(s => s.segment === 'delayed').length;
    const criticalShipments = shipments.filter(s => s.segment === 'critical').length;
    const plannedShipments = shipments.filter(s => s.segment === 'planned').length;

    return res.status(200).json({
      message: 'Shipment dashboard fetched successfully',
      summary: {
        activeShipments,
        onTrackShipments,
        delayedShipments,
        criticalShipments,
        plannedShipments,
        totalShipments: shipments.length
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

/* ---------------- API 2: SUMMARY WITH GROUPED SHIPMENT DATA ---------------- */

router.get('/shipment-dashboard-summary', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();

  try {
    const includeWeather = String(req.query.includeWeather || 'true') === 'true';
    const weatherLimit = Math.max(1, Number(req.query.weatherLimit || 25));

    const rows = await loadDashboardRows(conn);
    const { stopMap, gpsMap } = await loadStopsAndGps(conn, rows);

    const shipments = await buildShipmentList({
      rows,
      stopMap,
      gpsMap,
      includeWeather,
      weatherLimit
    });

    const groupedShipments = {
      active: [],
      onTrack: [],
      delayed: [],
      critical: [],
      planned: []
    };

    for (const shipment of shipments) {
      if (['on-track', 'delayed', 'critical'].includes(shipment.segment)) {
        groupedShipments.active.push(shipment);
      }

      if (shipment.segment === 'on-track') {
        groupedShipments.onTrack.push(shipment);
      }

      if (shipment.segment === 'delayed') {
        groupedShipments.delayed.push(shipment);
      }

      if (shipment.segment === 'critical') {
        groupedShipments.critical.push(shipment);
      }

      if (shipment.segment === 'planned') {
        groupedShipments.planned.push(shipment);
      }
    }

    return res.status(200).json({
      message: 'Shipment dashboard summary fetched successfully',

      summary: {
        activeShipments: groupedShipments.active.length,
        onTrackShipments: groupedShipments.onTrack.length,
        delayedShipments: groupedShipments.delayed.length,
        criticalShipments: groupedShipments.critical.length,
        plannedShipments: groupedShipments.planned.length,
        totalShipments: shipments.length
      },

      groupedShipments,

      shipments
    });

  } catch (err) {
    logger.error('shipment-dashboard-summary failed', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  } finally {
    conn.release();
  }
});

module.exports = router;