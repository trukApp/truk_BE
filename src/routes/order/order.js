// require('dotenv').config();
// const express = require('express');
// const axios = require('axios');
// const router = express.Router();

// const db = require('../../../dbConnection');
// const { logger } = require('../../logger/logger');
// const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');
// const jwtAuth = require('../../JWT/jwtAuth');
// const polyline = require('@mapbox/polyline');

// const cfg = require('../../config');
// const { getJSON, setJSON } = require('../../lib/redis');
// const { logApiPerf, logSolverPerf } = require('../../lib/tsdb');
// const { emit } = require('../../lib/kafka');

// /* ----------------------- CONFIG ----------------------- */
// const GOOGLE_API_KEY = cfg.googleApiKey;
// const OPENWEATHER_API_KEY = (cfg.openWeatherApiKey || process.env.OPENWEATHER_API_KEY || '').trim();
// const WEATHER_UNITS_DEFAULT = (cfg.weatherUnits || process.env.WEATHER_UNITS || 'metric').trim();
// const WEATHER_CACHE_TTL = Number(cfg.weatherCacheTtl || 600);
// const WEATHER_MAX_POINTS_DEFAULT = 30;
// const WEATHER_SAMPLE_EVERY_KM_DEFAULT = 20;

// // External HTTP timeouts & concurrency caps
// const AXIOS_TIMEOUT_MS = Number(cfg.httpTimeoutMs || process.env.HTTP_TIMEOUT_MS || 3500);
// const WEATHER_CONCURRENCY = Number(cfg.weatherConcurrency || process.env.WEATHER_CONCURRENCY || 5);

// // Traffic cache TTL (seconds)
// const TRAFFIC_CACHE_TTL = Number(cfg.trafficCacheTtl || process.env.TRAFFIC_CACHE_TTL || 120);

// /* ---------------------- helpers ---------------------- */
// function buildRouteKey(locations) {
//   return locations.map(loc => `${loc.latitude},${loc.longitude}`).join('|');
// }
// function toRadians(deg) { return deg * Math.PI / 180; }
// function distanceBetweenCoords(lat1, lon1, lat2, lon2) {
//   const R = 6371;
//   const dLat = toRadians(lat2 - lat1);
//   const dLon = toRadians(lon2 - lon1);
//   const a = Math.sin(dLat / 2) ** 2 +
//     Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
//     Math.sin(dLon / 2) ** 2;
//   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//   return R * c;
// }
// function sampleRoutePoints(coords, intervalKm = 20, maxPoints = Infinity) {
//   if (!coords.length) return [];
//   const sampled = [coords[0]];
//   let last = coords[0], acc = 0;
//   for (let i = 1; i < coords.length; i++) {
//     const d = distanceBetweenCoords(last.lat, last.lng, coords[i].lat, coords[i].lng);
//     acc += d;
//     if (acc >= intervalKm) {
//       sampled.push(coords[i]);
//       last = coords[i];
//       acc = 0;
//       if (sampled.length >= maxPoints) break;
//     }
//   }
//   if (sampled[sampled.length - 1] !== coords[coords.length - 1] && sampled.length < maxPoints) {
//     sampled.push(coords[coords.length - 1]);
//   }
//   return sampled;
// }
// function parseDistanceText(txt) {
//   return parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
// }
// const kmText = m => `${(m / 1000).toFixed(1)} km`;
// const minText = s => `${Math.round(s / 60)} mins`;

// // Fire-and-forget so telemetry never blocks a response
// function noBlock(promise, label, ms = 400) {
//   Promise.race([
//     promise,
//     new Promise(resolve => setTimeout(resolve, ms))
//   ]).catch(e => logger && logger.warn && logger.warn(`${label} failed`, { msg: e.message }));
// }

// // simple batching helper (limits concurrent promises)
// async function runInBatches(items, batchSize, worker) {
//   const out = [];
//   for (let i = 0; i < items.length; i += batchSize) {
//     const slice = items.slice(i, i + batchSize);
//     const res = await Promise.all(slice.map(worker));
//     out.push(...res);
//   }
//   return out;
// }

// /* --------- NEW: point and location normalizers --------- */
// function normalizePoint(p) {
//   if (p && typeof p === 'object') {
//     if ('lat' in p && 'lng' in p) return { lat: +p.lat, lng: +p.lng };
//     if ('latitude' in p && 'longitude' in p) return { lat: +p.latitude, lng: +p.longitude };
//   }
//   throw new Error('Bad point: expected {lat,lng} or {latitude,longitude}');
// }
// function dedupeConsecutiveLocations(locs) {
//   if (!Array.isArray(locs) || locs.length === 0) return [];
//   const out = [locs[0]];
//   for (let i = 1; i < locs.length; i++) {
//     const a = out[out.length - 1], b = locs[i];
//     if (a.latitude !== b.latitude || a.longitude !== b.longitude) out.push(b);
//   }
//   return out;
// }

// /* --------- normalize departure & cache bucket helpers --------- */
// function normalizeDeparture(epoch) {
//   const now = Math.floor(Date.now() / 1000);
//   if (!epoch || epoch < now - 600) return now;        // clamp past to "now"
//   const maxAhead = 24 * 3600;                         // cap future to 24h
//   return Math.min(epoch, now + maxAhead);
// }
// function departureBucket(epoch, minutes = 15) {
//   const e = normalizeDeparture(epoch);
//   return Math.floor(e / (minutes * 60));
// }

// /* ---------------- WEATHER HELPERS (OpenWeather) ---------------- */
// // hardened: validate numbers so toFixed never gets undefined
// function wKey(lat, lng, units) {
//   const la = Number(lat), lo = Number(lng);
//   if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('Invalid lat/lng for weather key');
//   return `weather:${units}:${la.toFixed(2)},${lo.toFixed(2)}`;
// }
// async function fetchWeatherPoint(lat, lng, units = WEATHER_UNITS_DEFAULT) {
//   if (!OPENWEATHER_API_KEY) throw new Error('OPENWEATHER_API_KEY missing');
//   const key = wKey(lat, lng, units);
//   const cached = await getJSON(key);
//   if (cached) return cached;

//   // NOTE: OpenWeather expects "lon", not "lng"
//   const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_API_KEY}&units=${units}`;
//   const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
//   const d = resp.data || {};
//   const out = {
//     lat: +lat,
//     lng: +lng,
//     at: Math.floor(Date.now() / 1000),
//     units,
//     temp: d.main?.temp ?? null,
//     feelsLike: d.main?.feels_like ?? null,
//     humidity: d.main?.humidity ?? null,
//     windSpeed: d.wind?.speed ?? null,
//     windDir: d.wind?.deg ?? null,
//     condition: (d.weather && d.weather[0]?.main) || null,
//     icon: (d.weather && d.weather[0]?.icon) || null,
//     precip1h: (d.rain && (d.rain['1h'] || 0)) || (d.snow && (d.snow['1h'] || 0)) || 0
//   };
//   await setJSON(key, out, WEATHER_CACHE_TTL);
//   return out;
// }

// // Parallel + resilient weather fetch with concurrency limit
// async function getWeatherAlongRoute(points, { units = WEATHER_UNITS_DEFAULT, maxPoints = WEATHER_MAX_POINTS_DEFAULT } = {}) {
//   const use = Array.isArray(points) ? points.slice(0, maxPoints) : [];
//   if (!use.length) {
//     return { pointsWeather: [], summary: { minTemp: null, maxTemp: null, distinctConditions: [], points: 0 }, units };
//   }

//   const results = await runInBatches(use, WEATHER_CONCURRENCY, async (p) => {
//     try {
//       // p is already normalized to {lat,lng} by callers that accept mixed shapes
//       return await fetchWeatherPoint(p.lat, p.lng, units);
//     } catch (e) {
//       logger.warn('weather fetch failed at point', {
//         point: p,
//         status: e?.response?.status,
//         data: e?.response?.data,
//         msg: e?.message || String(e)
//       });
//       return null;
//     }
//   });

//   const ok = results.filter(Boolean);
//   const temps = ok.map(r => r.temp).filter(v => typeof v === 'number');
//   const conds = new Set(ok.map(r => r.condition).filter(Boolean));
//   const summary = {
//     minTemp: temps.length ? Math.min(...temps) : null,
//     maxTemp: temps.length ? Math.max(...temps) : null,
//     distinctConditions: Array.from(conds),
//     points: ok.length
//   };
//   return { pointsWeather: ok, summary, units };
// }

// /* ------------------ ROUTING (Google / OSRM) ------------------ */
// async function fetchRouteGoogle(locations, { includeTraffic = false, departureTimeEpoch = 0 } = {}) {
//   // ensure no consecutive dupes to avoid zero-length legs
//   locations = dedupeConsecutiveLocations(locations);

//   const origin = locations[0];
//   const dest = locations[locations.length - 1];
//   const waypoints = locations.length > 2
//     ? locations.slice(1, -1).map(l => `${l.latitude},${l.longitude}`).join('|')
//     : '';

//   const params = [
//     `origin=${origin.latitude},${origin.longitude}`,
//     `destination=${dest.latitude},${dest.longitude}`,
//     waypoints ? `waypoints=${waypoints}` : '',
//     `mode=driving`,
//     `key=${GOOGLE_API_KEY}`
//   ];

//   // request traffic metrics when asked
//   if (includeTraffic) {
//     const dep = normalizeDeparture(departureTimeEpoch);
//     params.push('region=IN'); // helps with routing in India; harmless elsewhere
//     params.push('departure_time=' + dep);
//     params.push('traffic_model=best_guess'); // requires "departure_time" for duration_in_traffic
//   }

//   const url = `https://maps.googleapis.com/maps/api/directions/json?${params.filter(Boolean).join('&')}`;
//   const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
//   const data = resp?.data || {};
//   if (data.status !== 'OK') {
//     const err = new Error(`Google error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
//     // log diagnostics
//     logger.error('Google Directions failed', {
//       status: data.status,
//       error_message: data.error_message,
//       waypointCount: locations.length,
//       includeTraffic,
//       departureTimeEpoch
//     });
//     throw err;
//   }
//   const r0 = data.routes[0] || {};
//   const legs = r0.legs || [];
//   const poly = r0.overview_polyline?.points || '';
//   const decoded = poly ? polyline.decode(poly).map(([lat, lng]) => ({ lat, lng })) : [];

//   const mappedLegs = legs.map((leg, i) => {
//     const base = {
//       start: {
//         address: leg.start_address,
//         latitude: locations[i].latitude,
//         longitude: locations[i].longitude
//       },
//       end: {
//         address: leg.end_address,
//         latitude: locations[i + 1].latitude,
//         longitude: locations[i + 1].longitude
//       },
//       distance: leg.distance?.text || '',
//       duration: leg.duration?.text || ''
//     };

//     if (includeTraffic && leg.duration_in_traffic?.value != null) {
//       const normalSec = leg.duration?.value || 0;
//       const trafficSec = leg.duration_in_traffic.value;
//       base.durationInTraffic = leg.duration_in_traffic?.text || base.duration;
//       base.trafficDelaySec = Math.max(0, trafficSec - normalSec);
//       base.traffic = {
//         durationInTrafficSec: trafficSec,
//         normalDurationSec: normalSec,
//         delaySec: Math.max(0, trafficSec - normalSec)
//       };
//     }

//     return base;
//   });

//   // warn if traffic requested but missing (can happen on tiny/zero legs; we de-dupe to reduce this)
//   if (includeTraffic && legs.some(l => l?.duration_in_traffic?.value == null)) {
//     logger.warn('Google: duration_in_traffic missing for some legs', {
//       legCount: legs.length
//     });
//   }

//   // route-level traffic summary if requested
//   let trafficSummary = null;
//   if (includeTraffic) {
//     const delays = mappedLegs.map(l => +l.trafficDelaySec || 0);
//     const totalDelaySec = delays.reduce((s, n) => s + n, 0);
//     const avgDelay = mappedLegs.length ? Math.round(totalDelaySec / mappedLegs.length) : 0;
//     const congestion = totalDelaySec > 3600 ? 'high' : totalDelaySec > 900 ? 'medium' : 'low';
//     trafficSummary = {
//       trafficAt: normalizeDeparture(departureTimeEpoch),
//       totalDelaySec,
//       avgDelayPerLegSec: avgDelay,
//       congestion
//     };
//   }

//   return { legs: mappedLegs, shape: decoded, trafficSummary };
// }

// async function fetchRouteOSRM(locations) {
//   // de-dupe to keep parity with Google path
//   locations = dedupeConsecutiveLocations(locations);

//   const coords = locations.map(p => `${p.longitude},${p.latitude}`).join(';');
//   const url = `${cfg.osrmBaseUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
//   const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
//   if (resp.data.code !== 'Ok') {
//     throw new Error(`OSRM error: ${resp.data.code}`);
//   }
//   const route = resp.data.routes[0];
//   const decoded = polyline.decode(route.geometry)
//     .map(([lat, lng]) => ({ lat, lng }));

//   const legs = (route.legs || []).map((leg, i) => ({
//     start: {
//       address: '',
//       latitude: locations[i].latitude,
//       longitude: locations[i].longitude
//     },
//     end: {
//       address: '',
//       latitude: locations[i + 1].latitude,
//       longitude: locations[i + 1].longitude
//     },
//     distance: kmText(leg.distance || 0),
//     duration: minText(leg.duration || 0)
//   }));

//   return { legs, shape: decoded, trafficSummary: null };
// }

// /**
//  * Core helper that:
//  *  - checks Redis cache
//  *  - fetches route from provider (Google or OSRM)
//  *  - computes sampled points every ~N km
//  *  - returns { optimizedRoute[], sampledCoords[], trafficSummary }
//  */
// async function getOptimizedRouteWithLoad(locations, shipmentLoads, {
//   includeTraffic = false,
//   departureTimeEpoch = 0,
//   sampleEveryKm = WEATHER_SAMPLE_EVERY_KM_DEFAULT,
//   maxSamplePoints = Infinity
// } = {}) {
//   if (!Array.isArray(locations) || locations.length < 2) {
//     throw new Error('Need at least origin and destination');
//   }

//   // NEW: de-dupe consecutive identical coords to avoid zero legs
//   locations = dedupeConsecutiveLocations(locations);

//   // cache key includes provider + traffic toggle + DEPARTURE BUCKET + coordinates
//   // also include sampling params only for fallback; we'll resample if 'shape' is cached.
//   const depBucket = includeTraffic ? departureBucket(departureTimeEpoch) : 0;
//   const cacheKey = `route:${cfg.routingProvider}:${includeTraffic ? 'T' : 'N'}:${depBucket}:${buildRouteKey(locations)}:${sampleEveryKm}:${maxSamplePoints}`;
//   const cached = await getJSON(cacheKey);
//   let optimizedRoute, sampledCoords, trafficSummary, shape;

//   if (cached) {
//     // Backward compatibility if old cache had no 'shape'
//     optimizedRoute = cached.optimizedRoute;
//     trafficSummary = cached.trafficSummary || null;
//     shape = cached.shape || null;
//     if (shape && Array.isArray(shape)) {
//       sampledCoords = sampleRoutePoints(shape, sampleEveryKm, maxSamplePoints);
//     } else {
//       sampledCoords = cached.sampledCoords || [];
//     }
//   } else {
//     let legs, trafficSummaryLocal = null, shapeLocal = [];
//     if (cfg.routingProvider === 'osrm') {
//       ({ legs, shape: shapeLocal, trafficSummary: trafficSummaryLocal } = await fetchRouteOSRM(locations));
//     } else {
//       ({ legs, shape: shapeLocal, trafficSummary: trafficSummaryLocal } = await fetchRouteGoogle(locations, { includeTraffic, departureTimeEpoch }));
//     }

//     // Build optimizedRoute while computing cumulative load
//     const builtRoute = [];
//     let currentLoad = 0;
//     legs.forEach((leg, i) => {
//       const load = shipmentLoads[i] || 0;
//       currentLoad += load;
//       if (
//         leg.start.latitude !== leg.end.latitude ||
//         leg.start.longitude !== leg.end.longitude
//       ) {
//         builtRoute.push({ ...leg, loadAfterStop: currentLoad });
//       }
//     });

//     optimizedRoute = builtRoute;
//     shape = shapeLocal || [];
//     sampledCoords = sampleRoutePoints(shape, sampleEveryKm, maxSamplePoints);
//     trafficSummary = trafficSummaryLocal;

//     // Store 'shape' so future callers can resample differently
//     await setJSON(cacheKey, { optimizedRoute, shape, trafficSummary }, cfg.redisTTL);
//   }

//   // Recompute loadAfterStop for the caller's shipments (in case cache came from different loads)
//   let currentLoad = 0;
//   const recomputed = optimizedRoute.map((leg, i) => {
//     currentLoad += (shipmentLoads[i] || 0);
//     return { ...leg, loadAfterStop: currentLoad };
//   });

//   return { optimizedRoute: recomputed, sampledCoords, trafficSummary };
// }

// /* ------------------- bearing / clustering ------------------- */
// function getBearing(lat1, lon1, lat2, lon2) {
//   const toRad = d => d * Math.PI / 180;
//   const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
//   const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
//     Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
//   return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
// }
// function getDirection8(b) {
//   if (b < 22.5 || b >= 337.5) return 'N';
//   if (b < 67.5) return 'NE';
//   if (b < 112.5) return 'E';
//   if (b < 157.5) return 'SE';
//   if (b < 202.5) return 'S';
//   if (b < 247.5) return 'SW';
//   if (b < 292.5) return 'W';
//   return 'NW';
// }
// function isDirectionCompatible(a, b) {
//   const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
//   let iA = dirs.indexOf(a), iB = dirs.indexOf(b);
//   if (iA < 0 || iB < 0) return false;
//   let d = Math.abs(iA - iB);
//   if (d > 4) d = 8 - d;
//   return d <= 1;
// }
// function groupPackagesByDirection(pkgs) {
//   const visited = new Set(), groups = [];
//   for (let i = 0; i < pkgs.length; i++) {
//     if (visited.has(i)) continue;
//     const queue = [i], cluster = [pkgs[i]];
//     visited.add(i);
//     while (queue.length) {
//       const idx = queue.shift();
//       for (let j = 0; j < pkgs.length; j++) {
//         if (!visited.has(j) && isDirectionCompatible(pkgs[idx].direction8, pkgs[j].direction8)) {
//           visited.add(j);
//           queue.push(j);
//           cluster.push(pkgs[j]);
//         }
//       }
//     }
//     groups.push(cluster);
//   }
//   return groups;
// }

// /* ---------------------- DB helpers ----------------------- */
// function isVehicleValid(v) {
//   const t = new Date(), from = new Date(v.transportation_details.validity_from),
//     to = new Date(v.transportation_details.validity_to);
//   return t >= from && t <= to;
// }
// function isVehicleDown(v) {
//   if (!v.downtimes.downtime_starts_from) return false;
//   const now = new Date(),
//     s = new Date(v.downtimes.downtime_starts_from),
//     e = new Date(v.downtimes.downtime_ends_from);
//   return now >= s && now <= e;
// }
// async function getLocationById(loc_ID) {
//   const [rows] = await db.query(`
//     SELECT latitude, longitude, loc_desc
//     FROM master_locations WHERE loc_ID=?`, [loc_ID]);
//   if (!rows.length) throw new Error(`Location not found: ${loc_ID}`);
//   return {
//     latitude: parseFloat(rows[0].latitude) || 0,
//     longitude: parseFloat(rows[0].longitude) || 0,
//     loc_desc: rows[0].loc_desc || ''
//   };
// }
// function safeJsonParse(val, def = []) {
//   if (typeof val === 'string') {
//     try { return JSON.parse(val); } catch { return def; }
//   }
//   return val || def;
// }
// function getPackageSpecialFlags(pkg, productMap) {
//   let f = 0, d = 0, h = 0, t = 0;
//   for (const pr of pkg.products) {
//     const info = productMap[pr.prod_ID];
//     if (!info) continue;
//     if (info.fragile_goods) f = 1;
//     if (info.dangerous_goods) d = 1;
//     if (info.hazardous) h = 1;
//     if (info.temp_controlled) t = 1;
//   }
//   return { fragile: f, dangerous: d, hazardous: h, tempCtrl: t };
// }
// function getVehicleSpecialFlags(v) {
//   return {
//     fragile_vehicle: v.fragile_vehicle || 0,
//     danger_proof: v.danger_proof || 0,
//     hazardous_proof: v.hazardous_proof || 0,
//     temp_controlled_vehicle: v.temp_controlled_vehicle || 0
//   };
// }
// function checkPackageVehicleCompatibility(pkgF, vehF) {
//   const pkgIsNormal = !pkgF.fragile && !pkgF.dangerous && !pkgF.hazardous && !pkgF.tempCtrl;
//   if (pkgIsNormal) {
//     return !vehF.fragile_vehicle &&
//       !vehF.danger_proof &&
//       !vehF.hazardous_proof &&
//       !vehF.temp_controlled_vehicle;
//   }
//   if (pkgF.fragile && !vehF.fragile_vehicle) return false;
//   if (pkgF.dangerous && !vehF.danger_proof) return false;
//   if (pkgF.hazardous && !vehF.hazardous_proof) return false;
//   if (pkgF.tempCtrl && !vehF.temp_controlled_vehicle) return false;
//   return true;
// }

// /* ---------- packaging helpers (ONLY from master_products) --------- */
// function resolvePacIdsFromProduct(prodRow) {
//   if (!prodRow) return [];
//   let pt = prodRow.packaging_type;
//   if (typeof pt === 'string') {
//     try { pt = JSON.parse(pt); } catch { pt = null; }
//   }
//   if (!Array.isArray(pt)) return [];
//   return pt.filter(x => x && x.pac_ID).map(x => x.pac_ID);
// }
// async function loadAllPackageInfo(pacIDs) {
//   if (!pacIDs.length) return {};
//   const ph = pacIDs.map(_ => '?').join(',');
//   const [rows] = await db.query(`
//     SELECT * FROM master_package_info WHERE pac_ID IN (${ph})`, pacIDs);
//   return rows.reduce((m, r) => { m[r.pac_ID] = r; return m; }, {});
// }
// function collectAllPacIDs(packagesData, productMap) {
//   const ids = new Set();
//   for (const pkg of packagesData) {
//     for (const line of pkg.products) {
//       const pacIds = resolvePacIdsFromProduct(productMap[line.prod_ID]);
//       pacIds.forEach(id => ids.add(id));
//     }
//   }
//   return [...ids];
// }
// async function sumPackageWeightVolume(pkg, productMap, pkgInfoMap) {
//   let totalW = 0, totalV = 0;
//   for (const line of pkg.products) {
//     const prod = productMap[line.prod_ID];
//     if (!prod) continue;
//     totalW += parseWeightAndUOM(prod.weight, prod.weight_uom) * line.quantity;
//     const pacIds = resolvePacIdsFromProduct(prod);
//     if (pacIds.length) {
//       const info = pkgInfoMap[pacIds[0]];
//       if (info) totalV += parseVolumeAndUOM(info.pack_volume, info.pack_volume_uom) * line.quantity;
//     }
//   }
//   return { totalW, totalV };
// }

// /* ---------------- backtracking cost solver ---------------- */
// async function findMinCostArrangement(cluster, vehicles, sourceLoc) {
//   vehicles = vehicles.slice().sort((a, b) => a.cost_per_ton - b.cost_per_ton);

//   let best = {
//     cost: Infinity,
//     allocations: [],
//     unallocated: cluster.map(p => p.pack_ID),
//     placedCount: 0
//   };

//   function snapshot(used, remaining) {
//     return {
//       cost: used.reduce((s, a) => s + a.cost, 0),
//       allocations: JSON.parse(JSON.stringify(used)),
//       unallocated: remaining.map(r => r.pack_ID),
//       placedCount: cluster.length - remaining.length
//     };
//   }

//   async function backtrack(rem, iVeh, used) {
//     if (!rem.length) {
//       const shot = snapshot(used, rem);
//       if (shot.placedCount > best.placedCount ||
//           (shot.placedCount === best.placedCount && shot.cost < best.cost)) best = shot;
//       return;
//     }
//     if (iVeh >= vehicles.length) {
//       const shot = snapshot(used, rem);
//       if (shot.placedCount > best.placedCount ||
//           (shot.placedCount === best.placedCount && shot.cost < best.cost)) best = shot;
//       return;
//     }

//     const v = vehicles[iVeh];
//     const subsets = [];

//     function buildSub(idx, chosen, sumW, sumV, flags) {
//       if (idx === rem.length) {
//         subsets.push({ chosen, sumW, sumV, flags });
//         return;
//       }
//       buildSub(idx + 1, chosen, sumW, sumV, flags);
//       const pkg = rem[idx];
//       const newW = sumW + pkg.totalWeight;
//       const newV = sumV + pkg.totalVolume;
//       if (newW <= v.weightCapKg && newV <= v.usableVol) {
//         const nf = { ...flags };
//         nf.fragile ||= pkg.specialFlags.fragile;
//         nf.dangerous ||= pkg.specialFlags.dangerous;
//         nf.hazardous ||= pkg.specialFlags.hazardous;
//         nf.tempCtrl ||= pkg.specialFlags.tempCtrl;
//         if (checkPackageVehicleCompatibility(nf, getVehicleSpecialFlags(v))) {
//           buildSub(idx + 1, [...chosen, pkg], newW, newV, nf);
//         }
//       }
//     }

//     buildSub(0, [], 0, 0, { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 });

//     for (const { chosen, sumW } of subsets) {
//       if (!chosen.length) continue;

//       chosen.sort((a, b) => a.distFromSource - b.distFromSource);
//       const locs = [sourceLoc, ...chosen.map(x => x.destination)];
//       const shipments = new Array(chosen.length).fill(1);

//       // traffic off in solver recursion for speed/cost
//       const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(locs, shipments);

//       const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
//       const tons = sumW / 1000;
//       const cost = tons * v.cost_per_ton * totalDist;

//       let loadArr = [], remainIDs = chosen.map(x => x.pack_ID);
//       optimizedRoute.forEach((leg, i) => {
//         const stop = i + 1, matches = [];
//         for (const id of remainIDs) {
//           const pObj = chosen.find(x => x.pack_ID === id);
//           if (pObj &&
//               pObj.destination.latitude === leg.end.latitude &&
//               pObj.destination.longitude === leg.end.longitude) {
//             matches.push(id);
//           }
//         }
//         if (matches.length) {
//           matches.forEach(m => remainIDs.splice(remainIDs.indexOf(m), 1));
//           loadArr.push({ stop, location: leg.end.address, packages: matches });
//         }
//       });

//       used.push({
//         vehicle_ID: v.vehicle_ID,
//         totalWeightCapacity: v.totalWeightCapacity,
//         totalVolumeCapacity: v.totalVolumeCapacity,
//         occupiedWeight: sumW,
//         occupiedVolume: chosen.reduce((s, p) => s + p.totalVolume, 0),
//         leftoverWeight: v.weightCapKg - sumW,
//         leftoverVolume: v.volumeCapM3 - chosen.reduce((s, p) => s + p.totalVolume, 0),
//         cost,
//         packages: chosen.map(x => x.pack_ID),
//         route: optimizedRoute,
//         loadArrangement: loadArr,
//         sampledRoutePoints: sampledCoords
//       });

//       await backtrack(rem.filter(r => !chosen.includes(r)), iVeh + 1, used);
//       used.pop();
//     }
//     await backtrack(rem, iVeh + 1, used);
//   }

//   await backtrack(cluster, 0, []);
//   return (best.placedCount > 0)
//     ? { cost: best.cost, allocations: best.allocations, unallocated: best.unallocated }
//     : { cost: 0, allocations: [], unallocated: best.unallocated };
// }

// function generateUnallocationReason(pkgInfo, vehicles) {
//   if (!vehicles.length) return 'No vehicles after filters.';
//   const fleet = vehicles.map(getVehicleSpecialFlags);
//   if (pkgInfo.specialFlags.tempCtrl && !fleet.some(v => v.temp_controlled_vehicle))
//     return 'Needs temperature-controlled truck.';
//   if (pkgInfo.specialFlags.fragile && !fleet.some(v => v.fragile_vehicle))
//     return 'Needs fragile-goods truck.';
//   if (pkgInfo.specialFlags.dangerous && !fleet.some(v => v.danger_proof))
//     return 'Needs dangerous-goods truck.';
//   if (pkgInfo.specialFlags.hazardous && !fleet.some(v => v.hazardous_proof))
//     return 'Needs hazardous-goods truck.';

//   const maxW = Math.max(...vehicles.map(v => v.weightCapKg));
//   const maxV = Math.max(...vehicles.map(v => v.volumeCapM3));
//   if (pkgInfo.totalWeight > maxW) return 'Package too heavy for any truck.';
//   if (pkgInfo.totalVolume > maxV) return 'Package too large for any truck.';
//   return 'Could not allocate package.';
// }

// /* ---------------- allocation orchestration ---------------- */
// async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap, extra = {}) {
//   const {
//     includeTraffic = false,
//     departureTimeEpoch = 0,
//     weatherOpts = {}
//   } = extra;

//   const allocations = [], unallocatedPackages = [];
//   let totalCost = 0;
//   const pkgInfos = [];

//   for (const pkg of packagesData) {
//     const { totalW, totalV } = await sumPackageWeightVolume(pkg, productMap, packagingInfoMap);
//     const destLoc = await getLocationById(pkg.ship_to);
//     const bearing = getBearing(sourceLocation.latitude, sourceLocation.longitude, destLoc.latitude, destLoc.longitude);
//     const dir8 = getDirection8(bearing);
//     const distKM = distanceBetweenCoords(sourceLocation.latitude, sourceLocation.longitude, destLoc.latitude, destLoc.longitude);
//     const flags = getPackageSpecialFlags(pkg, productMap);
//     pkgInfos.push({
//       pack_ID: pkg.pack_ID,
//       totalWeight: totalW,
//       totalVolume: totalV,
//       destination: destLoc,
//       direction8: dir8,
//       distFromSource: distKM,
//       specialFlags: flags
//     });
//   }

//   const groups = groupPackagesByDirection(pkgInfos);
//   for (const group of groups) {
//     const sumW = group.reduce((s, g) => s + g.totalWeight, 0);
//     const sumV = group.reduce((s, g) => s + g.totalVolume, 0);
//     const combinedFlags = group.reduce((f, g) => ({
//       fragile: f.fragile || g.specialFlags.fragile,
//       dangerous: f.dangerous || g.specialFlags.dangerous,
//       hazardous: f.hazardous || g.specialFlags.hazardous,
//       tempCtrl: f.tempCtrl || g.specialFlags.tempCtrl
//     }), { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 });

//     let feasible = vehicles.filter(v =>
//       v.weightCapKg >= sumW &&
//       v.usableVol >= sumV &&
//       checkPackageVehicleCompatibility(combinedFlags, getVehicleSpecialFlags(v))
//     );

//     if (feasible.length) {
//       feasible.sort((a, b) => a.cost_per_ton - b.cost_per_ton);
//       const chosen = feasible[0];

//       group.sort((a, b) => a.distFromSource - b.distFromSource);
//       const routeLocs = [sourceLocation, ...group.map(g => g.destination)];
//       const shipments = new Array(group.length).fill(1);

//       const { optimizedRoute, sampledCoords, trafficSummary } =
//         await getOptimizedRouteWithLoad(routeLocs, shipments, {
//           includeTraffic,
//           departureTimeEpoch,
//           sampleEveryKm: weatherOpts.sampleEveryKm || WEATHER_SAMPLE_EVERY_KM_DEFAULT,
//           maxSamplePoints: weatherOpts.maxPoints || WEATHER_MAX_POINTS_DEFAULT
//         });

//       const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
//       const tons = sumW / 1000;
//       const cost = tons * chosen.cost_per_ton * totalDist;
//       totalCost += cost;

//       let loadArr = [], remainIDs = group.map(g => g.pack_ID);
//       optimizedRoute.forEach((leg, i) => {
//         const stop = i + 1, using = [];
//         remainIDs.forEach(id => {
//           const pkg = group.find(g => g.pack_ID === id);
//           if (pkg &&
//               pkg.destination.latitude === leg.end.latitude &&
//               pkg.destination.longitude === leg.end.longitude) {
//             using.push(id);
//           }
//         });
//         if (using.length) {
//           using.forEach(id => remainIDs.splice(remainIDs.indexOf(id), 1));
//           loadArr.push({ stop, location: leg.end.address, packages: using });
//         }
//       });

//       allocations.push({
//         vehicle_ID: chosen.vehicle_ID,
//         totalWeightCapacity: chosen.totalWeightCapacity,
//         totalVolumeCapacity: chosen.totalVolumeCapacity,
//         occupiedWeight: sumW,
//         occupiedVolume: group.reduce((s, g) => s + g.totalVolume, 0),
//         leftoverWeight: chosen.weightCapKg - sumW,
//         leftoverVolume: chosen.volumeCapM3 - group.reduce((s, g) => s + g.totalVolume, 0),
//         cost,
//         packages: group.map(g => g.pack_ID),
//         pkgVolumes: group.map(g => g.totalVolume),
//         route: optimizedRoute,
//         trafficSummary,
//         loadArrangement: loadArr,
//         sampledRoutePoints: sampledCoords
//       });

//     } else {
//       const { cost, allocations: subAllocs, unallocated } =
//         await findMinCostArrangement(group, vehicles, sourceLocation);
//       totalCost += cost;
//       allocations.push(...subAllocs);
//       unallocated.forEach(id => {
//         const info = pkgInfos.find(p => p.pack_ID === id);
//         unallocatedPackages.push({
//           pack_ID: id,
//           reason: generateUnallocationReason(info, vehicles)
//         });
//       });
//     }
//   }

//   return { allocations, totalCost, unallocated: unallocatedPackages };
// }

// /* ------------------- dimension + 3D placement ------------------- */
// function parseDimension(str = '') {
//   if (typeof str === 'number') return +str || 0;
//   const m = String(str).match(/(\d+(?:\.\d+)?)/);
//   if (!m) return 0;
//   const val = parseFloat(m[1]);
//   return /cm/i.test(str) ? val / 100 : val;
// }
// function r3(n) { return Math.round(n * 1000) / 1000; }
// function buildColorMapByProdPkg(packageInfoDetails) {
//   const palette = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#0ea5e9', '#6366f1', '#22c55e'];
//   const colorByKey = {};
//   let i = 0;
//   for (const p of packageInfoDetails) {
//     const pkg_ID = p.pkg_ID;
//     for (const l of (p.lines || [])) {
//       if (!l?.prod_ID) continue;
//       const key = `${l.prod_ID}|${pkg_ID}`;
//       if (!colorByKey[key]) colorByKey[key] = palette[i++ % palette.length];
//     }
//   }
//   return colorByKey;
// }
// function explodePackage(pkgRecord, colorByKey) {
//   const out = [];
//   for (const l of (pkgRecord.lines || [])) {
//     const d = l.packagingDimensions;
//     if (!d) continue;
//     const L = +d.lengthM || 0, W = +d.widthM || 0, H = +d.heightM || 0;
//     const q = Number(l.quantity || 0);
//     const color = colorByKey[`${l.prod_ID}|${pkgRecord.pkg_ID}`] || '#999';
//     const allowedLayers = Math.max(1, Number(l.allowedLayers || 1));
//     for (let i = 0; i < q; i++) out.push({ pkg_ID: pkgRecord.pkg_ID, prod_ID: l.prod_ID, L, W, H, color, allowedLayers });
//   }
//   return out;
// }
// function getMaxBoxHeight(packageInfoDetails) {
//   let h = 0;
//   for (const p of packageInfoDetails) {
//     for (const l of (p.lines || [])) {
//       if (l?.packagingDimensions?.heightM) {
//         h = Math.max(h, +l.packagingDimensions.heightM);
//       }
//     }
//   }
//   return h || 0.5;
// }
// function computeBoxPlacements(loadArrangement, packageInfoDetails, vehicleDimensions, opts = {}) {
//   const res = packStopBlocks(loadArrangement, packageInfoDetails, vehicleDimensions, opts);
//   return res;
// }
// function packStopBlocks(loadArrangement, packageInfoDetails, vehicleDimensions, opts = {}) {
//   const truckL = vehicleDimensions.interiorLengthM || 0;
//   const truckW = vehicleDimensions.interiorWidthM || 0;
//   const truckH = vehicleDimensions.interiorHeightM || 0;

//   const EPS = 1e-9;
//   const Z_GUTTER = opts.zGutter ?? 0.0;
//   const FRONT_GUTTER_X = opts.frontGutter ?? 0.0;
//   const LAYER_GAP = opts.layerGap ?? 0.02;

//   const layerHeight = opts.layerHeight ?? getMaxBoxHeight(packageInfoDetails);
//   const maxLayers = Math.max(1, Math.min(opts.maxLayers || 1, layerHeight > 0 ? Math.floor(truckH / layerHeight) : 1));

//   const colorByKey = buildColorMapByProdPkg(packageInfoDetails);
//   const pkgMap = new Map(packageInfoDetails.map(p => [p.pkg_ID, p]));

//   const stopsDesc = [...loadArrangement].sort((a, b) => b.stop - a.stop);

//   const layers = Array.from({ length: maxLayers }, () => ({
//     stripes: [],
//     zUsed: 0
//   }));

//   const placements = [];
//   let total = 0, placed = 0, highestLayerUsed = -1;

//   function placeInStripe(layerIdx, s, boxes) {
//     while (boxes.length) {
//       let pick = -1;
//       for (let i = 0; i < boxes.length; i++) {
//         if (boxes[i].W - s.width <= EPS) { pick = i; break; }
//       }
//       if (pick < 0) break;

//       const b = boxes[pick];
//       if (s.xCursor + b.L - truckL > EPS) break;

//       if (s.zCursor + b.W - s.width > EPS) {
//         if (s.rowMaxL <= EPS) break;
//         s.xCursor = Math.min(truckL, s.xCursor + s.rowMaxL);
//         s.zCursor = 0;
//         s.rowMaxL = 0;
//         if (s.xCursor + b.L - truckL > EPS) break;
//       }

//       placements.push({
//         pkg_ID: b.pkg_ID, prod_ID: b.prod_ID, color: b.color,
//         position: [r3(s.xCursor), r3(layerIdx * layerHeight + layerIdx * LAYER_GAP), r3(s.z0 + s.zCursor)],
//         dimensions: [r3(b.L), r3(b.H), r3(b.W)]
//       });
//       placed++;
//       highestLayerUsed = Math.max(highestLayerUsed, layerIdx);

//       s.zCursor += b.W + Z_GUTTER;
//       s.rowMaxL = Math.max(s.rowMaxL, b.L);
//       boxes.splice(pick, 1);
//     }
//   }

//   function placeIntoLayer(layerIdx, boxes) {
//     const layer = layers[layerIdx];

//     for (const s of layer.stripes) {
//       placeInStripe(layerIdx, s, boxes);
//       if (!boxes.length) return true;
//     }

//     while (boxes.length && layer.zUsed + 1e-9 < truckW) {
//       const availW = Math.max(0, truckW - layer.zUsed);
//       if (availW <= 1e-9) break;

//       const s = { z0: layer.zUsed, width: availW, xCursor: FRONT_GUTTER_X, zCursor: 0, rowMaxL: 0 };
//       placeInStripe(layerIdx, s, boxes);

//       layer.stripes.push(s);
//       layer.zUsed = Math.min(truckW, s.z0 + s.width);

//       if (!boxes.length) return true;
//       if (s.zCursor === 0 && s.rowMaxL === 0) break;
//     }
//     return boxes.length === 0;
//   }

//   for (const stop of stopsDesc) {
//     let boxes = [];
//     for (const pkgId of (stop.packages || [])) {
//       const pkg = pkgMap.get(pkgId);
//       if (pkg) boxes.push(...explodePackage(pkg, colorByKey));
//     }
//     boxes.sort((a, b) => b.L - a.L);
//     total += boxes.length;

//     for (let layerIdx = 0; layerIdx < maxLayers && boxes.length; layerIdx++) {
//       placeIntoLayer(layerIdx, boxes);
//     }
//   }

//   return { placements, total, placed, layersUsed: Math.max(0, highestLayerUsed + 1) };
// }
// function generatePackageBlocks(boxPlacements) {
//   return boxPlacements.map(b => ({
//     pkg_ID: b.pkg_ID,
//     prod_ID: b.prod_ID,
//     color: b.color || '#999',
//     position: b.position,
//     dimensions: b.dimensions
//   }));
// }
// function buildProductLegend(loadArrangement, packageInfoDetails, colorByProdPkg) {
//   const byProd = {};
//   for (const stopEntry of loadArrangement) {
//     const stop = stopEntry.stop;
//     for (const pkg_ID of stopEntry.packages) {
//       const p = packageInfoDetails.find(x => x.pkg_ID === pkg_ID);
//       if (!p) continue;
//       for (const l of (p.lines || [])) {
//         if (!l?.prod_ID) continue;
//         const rec = (byProd[l.prod_ID] ||= {
//           prod_ID: l.prod_ID, color: '#999', totalQty: 0, byPackage: {}, byStop: {}
//         });
//         const q = Number(l.quantity || 0);
//         rec.totalQty += q;
//         const key = `${l.prod_ID}|${pkg_ID}`;
//         const prev = rec.byPackage[pkg_ID] || { qty: 0, color: colorByProdPkg[key] || '#999' };
//         rec.byPackage[pkg_ID] = { qty: prev.qty + q, color: prev.color };
//         rec.byStop[stop] = (rec.byStop[stop] || 0) + q;
//       }
//     }
//   }
//   return Object.values(byProd).map(r => ({
//     prod_ID: r.prod_ID,
//     color: r.color,
//     totalQty: r.totalQty,
//     byPackage: Object.entries(r.byPackage).map(([pack_ID, v]) => ({ pack_ID, qty: v.qty, color: v.color })),
//     byStop: Object.entries(r.byStop).map(([stop, qty]) => ({ stop: Number(stop), qty })).sort((a, b) => a.stop - b.stop)
//   }));
// }

// /* -------------------------- ROUTES --------------------------- */

// // Create order (allocations) with optional traffic + weather
// router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
//   const t0 = Date.now();
//   try {
//     const { packages: packageIDs, filters } = req.body;
//     if (!packageIDs?.length) return res.status(400).json({ error: 'No packages provided.' });

//     const includeTraffic = !!filters?.includeTraffic;
//     const departureTimeEpoch = Number(filters?.traffic?.departureTimeEpoch || 0);

//     // Default to true if a weather key exists (caller can disable by send includeWeather:false)
//     const includeWeather = (typeof filters?.includeWeather === 'boolean')
//       ? !!filters.includeWeather
//       : !!OPENWEATHER_API_KEY;

//     const weatherOpts = {
//       units: (filters?.weather?.units || WEATHER_UNITS_DEFAULT),
//       sampleEveryKm: Number(filters?.weather?.sampleEveryKm || WEATHER_SAMPLE_EVERY_KM_DEFAULT),
//       maxPoints: Number(filters?.weather?.maxPoints || WEATHER_MAX_POINTS_DEFAULT)
//     };

//     // 1) fetch packages & validate same origin/date
//     const packagesData = await getPackagesByIds(packageIDs);
//     const origin = packagesData[0].ship_from;
//     const pickupDate = packagesData[0].pickup_date_time.split('T')[0];
//     packagesData.forEach(p => {
//       if (p.ship_from !== origin) throw new Error('All packages must share ship_from');
//       if (p.pickup_date_time.split('T')[0] !== pickupDate)
//         throw new Error('All packages must share pickup date');
//     });

//     // 2) products
//     const allLines = packagesData.flatMap(p => p.products || []);
//     const prodIDs = [...new Set(allLines.map(l => l.prod_ID))];
//     if (!prodIDs.length)
//       return res.status(400).json({ error: 'No product lines in packages' });

//     const [prodRows] = await db.query(
//       `SELECT product_ID, weight, weight_uom, volume, volume_uom,
//        fragile_goods, dangerous_goods, hazardous, temp_controlled,
//        packaging_type, stacking_factor
//        FROM master_products
//        WHERE product_ID IN (?)`,
//       [prodIDs]
//     );
//     const productMap = prodRows.reduce((m, r) => (m[r.product_ID] = r, m), {});

//     // 3) packaging info
//     const allPacIDs = collectAllPacIDs(packagesData, productMap);
//     const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

//     // tallest package height
//     const heights = allLines.map(l => {
//       const prod = productMap[l.prod_ID];
//       const pacIds = resolvePacIdsFromProduct(prod);
//       const info = pacIds[0] ? packagingInfoMap[pacIds[0]] : null;
//       return info ? parseDimension(`${info.pack_height} ${info.dimensions_uom}`) : 0;
//     }).filter(Boolean);
//     const maxPkgH = heights.length ? Math.max(...heights) : 0;

//     // global stacking factor cap
//     const sfCaps = allLines.map(l => {
//       const raw = productMap[l.prod_ID]?.stacking_factor;
//       if (raw === null || raw === undefined || raw === '') return 1;
//       const n = Number(raw);
//       return (isNaN(n) || n <= 1) ? 1 : n;
//     });
//     const globalSfCap = sfCaps.length ? Math.max(...sfCaps) : 1;

//     // 4) vehicles near origin
//     const [dbVehicles] = await db.query(
//       `SELECT * FROM master_resources WHERE JSON_CONTAINS(loc_ID, ?)`,
//       [JSON.stringify(origin)]
//     );

//     let fleet = dbVehicles.map(v => {
//       const caps = safeJsonParse(v.capacity, {});
//       const W = parseDimension(caps.interior_width);
//       const L = parseDimension(caps.interior_length);
//       const H = parseDimension(caps.interior_height);

//       const rawVolDims = (W && L && H) ? (W * L * H) : parseVolumeAndUOM(caps.cubic_capacity, caps.cubic_capacity_unit);
//       const rawM3 = rawVolDims || 0;

//       const maxLayersByHeight = (maxPkgH > 0 && H > 0) ? Math.max(1, Math.floor(H / maxPkgH)) : 1;
//       const truckAllowedLayers = Math.min(maxLayersByHeight, globalSfCap);
//       const oneLayerM3 = (maxPkgH > 0) ? (W * L * maxPkgH) : 0;
//       const usableVol = oneLayerM3 * truckAllowedLayers;

//       const weightCapKg = parseWeightAndUOM(caps.payload_weight, caps.payload_weight_unit);

//       return {
//         ...v,
//         transportation_details: safeJsonParse(v.transportation_details, {}),
//         downtimes: safeJsonParse(v.downtimes, {}),
//         capacity: caps,
//         weightCapKg,
//         totalWeightCapacity: weightCapKg,
//         totalVolumeCapacity: rawM3,
//         volumeCapM3: rawM3,
//         oneLayerM3,
//         usableVol,
//         maxLayersByHeight,
//         maxLayers: maxLayersByHeight,
//         allowedLayers: truckAllowedLayers,
//         cost_per_ton: +safeJsonParse(v.additional_details, {}).cost_per_ton || 0
//       };
//     });

//     // 5) filters/sorts
//     if (filters?.checkValidity) fleet = fleet.filter(isVehicleValid);
//     if (filters?.checkDowntime) fleet = fleet.filter(v => !isVehicleDown(v));
//     if (filters?.sortUnlimitedUsage) fleet.sort((a, b) => (a.unlimited_usage || 0) - (b.unlimited_usage || 0));
//     if (filters?.sortOwnership) fleet.sort((a, b) => (a.individual_resource || '').localeCompare(b.individual_resource || ''));
//     fleet.sort((a, b) => a.cost_per_ton - b.cost_per_ton);

//     // 6) origin coords
//     const sourceLoc = await getLocationById(origin);

//     // 7) allocate (with toggles)
//     const { allocations, totalCost, unallocated } = await allocatePackages(
//       packagesData,
//       fleet,
//       sourceLoc,
//       productMap,
//       packagingInfoMap,
//       {
//         includeTraffic,
//         departureTimeEpoch,
//         weatherOpts
//       }
//     );

//     // 8) enrich for FE (3D packing etc.)
//     const enriched = await Promise.all(allocations.map(async a => {
//       const v = fleet.find(x => x.vehicle_ID === a.vehicle_ID) || {};
//       const caps = v.capacity || {};

//       const widthM = parseDimension(caps.interior_width);
//       const lengthM = parseDimension(caps.interior_length);
//       const heightM = parseDimension(caps.interior_height);

//       const packageInfoDetails = a.packages.map(pkgID => {
//         const pkgRecord = packagesData.find(p => p.pack_ID === pkgID);
//         const lines = (pkgRecord?.products || []).map(line => {
//           const prod = productMap[line.prod_ID];
//           const pacIds = resolvePacIdsFromProduct(prod);
//           const firstPac = pacIds[0] || null;
//           const packInfo = firstPac ? packagingInfoMap[firstPac] : null;

//           const sfRaw = prod?.stacking_factor;
//           const stacking_factor = (sfRaw === '' ? null : sfRaw);
//           const sfNum = Number(stacking_factor);
//           const sfCap = (!sfNum || isNaN(sfNum) || sfNum <= 1) ? 1 : sfNum;

//           const dims = packInfo ? {
//             lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
//             widthM: parseDimension(`${packInfo.pack_width}  ${packInfo.dimensions_uom}`),
//             heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
//           } : null;

//           let allowedLayers = 1;
//           if (dims?.heightM && heightM) {
//             const heightCap = Math.max(1, Math.floor(heightM / dims.heightM));
//             allowedLayers = Math.min(heightCap, sfCap);
//           }

//           return {
//             prod_ID: line.prod_ID,
//             quantity: line.quantity,
//             pac_ID: firstPac,
//             stacking_factor,
//             sfCap,
//             package_info: packInfo,
//             packagingDimensions: dims,
//             allowedLayers
//           };
//         });

//         return { pkg_ID: pkgID, lines };
//       });

//       const perLineLayers = [];
//       packageInfoDetails.forEach(p => {
//         (p.lines || []).forEach(l => {
//           if (l.packagingDimensions) {
//             perLineLayers.push({
//               prod_ID: l.prod_ID,
//               pac_ID: l.pac_ID,
//               allowedLayers: l.allowedLayers
//             });
//           }
//         });
//       });

//       const occupied = a.occupiedVolume;
//       const rawM3 = v.totalVolumeCapacity || 0;
//       const usableM3 = v.usableVol || rawM3;

//       const occupiedPercentRaw    = rawM3    ? +((occupied / rawM3)    * 100).toFixed(2) : 0;
//       const occupiedPercentUsable = usableM3 ? +((occupied / usableM3) * 100).toFixed(2) : 0;

//       const packageDetails = a.packages.map((pkg_ID, idx) => {
//         const vol = (a.pkgVolumes && a.pkgVolumes[idx]) || 0;
//         const percentOfTruckRaw    = rawM3    ? +(vol / rawM3    * 100).toFixed(2) : 0;
//         const percentOfUsableRules = usableM3 ? +(vol / usableM3 * 100).toFixed(2) : 0;
//         return {
//           pkg_ID,
//           volumeM3: vol,
//           percentOfTruck: percentOfTruckRaw,
//           percentOfUsable: percentOfUsableRules
//         };
//       });

//       const colorByProdPkg = buildColorMapByProdPkg(packageInfoDetails);
//       const tallestH = getMaxBoxHeight(packageInfoDetails);

//       const { placements: rawPlacements, layersUsed } = computeBoxPlacements(
//         a.loadArrangement,
//         packageInfoDetails,
//         { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
//         {
//           maxLayers: Math.max(1, v.allowedLayers || 1),
//           zGutter: 0.0,
//           frontGutter: 0.0,
//           layerGap: 0.02,
//           layerHeight: tallestH
//         }
//       );

//       const boxPlacements = generatePackageBlocks(rawPlacements);
//       const productLegend = buildProductLegend(a.loadArrangement, packageInfoDetails, colorByProdPkg);

//       // Attach weather if requested
//       let weatherAlongRoute = undefined;
//       let weatherSummary = undefined;
//       if (includeWeather) {
//         if (!OPENWEATHER_API_KEY) {
//           logger.warn('OPENWEATHER_API_KEY missing: skipping weather');
//         } else if (a.sampledRoutePoints?.length) {
//           const normalized = a.sampledRoutePoints.map(normalizePoint);
//           const { pointsWeather, summary } = await getWeatherAlongRoute(
//             normalized,
//             { units: weatherOpts.units, maxPoints: weatherOpts.maxPoints }
//           );
//           weatherAlongRoute = pointsWeather;
//           weatherSummary = summary;
//         } else {
//           weatherAlongRoute = [];
//           weatherSummary = { minTemp: null, maxTemp: null, distinctConditions: [], points: 0 };
//         }
//       }

//       // Compute traffic summary if route has traffic fields but summary missing
//       let trafficSummary = a.trafficSummary || null;
//       if (includeTraffic && !trafficSummary && Array.isArray(a.route)) {
//         const delays = a.route.map(l => +l.trafficDelaySec || 0);
//         const totalDelaySec = delays.reduce((s, n) => s + n, 0);
//         const avgDelay = a.route.length ? Math.round(totalDelaySec / a.route.length) : 0;
//         const congestion = totalDelaySec > 3600 ? 'high' : totalDelaySec > 900 ? 'medium' : 'low';
//         trafficSummary = {
//           trafficAt: normalizeDeparture(departureTimeEpoch),
//           totalDelaySec,
//           avgDelayPerLegSec: avgDelay,
//           congestion
//         };
//       }

//       return {
//         ...a,
//         boxPlacements,
//         vehicleDimensions: { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
//         packageInfoDetails,

//         occupiedPercent: occupiedPercentRaw,
//         occupiedPercentRaw,
//         occupiedPercentUsable,

//         packageDetails,
//         productLegend,
//         truckCapacity: {
//           rawM3: v.totalVolumeCapacity,
//           oneLayerM3: v.oneLayerM3,
//           usableM3: v.usableVol,
//           maxLayersByHeight: v.maxLayersByHeight,
//           allowedLayers: v.allowedLayers,
//           allowedByHeight: v.maxLayersByHeight,
//           allowedBySF: globalSfCap,
//           layersUsed,
//           perLineLayers
//         },

//         // new optional extras
//         weatherAlongRoute,
//         weatherSummary,
//         trafficSummary
//       };
//     }));

//     // metrics + event
//     const ms = Date.now() - t0;
//     await logApiPerf('/create-order', ms, true);
//     await logSolverPerf(packagesData.length, fleet.length, ms, totalCost);
//     try { await emit('plan.optimized', { totalCost, allocations: enriched, at: Date.now() }); } catch {}

//     return res.status(200).json({
//       message: enriched.length ? 'Best Combinational Scenario' : 'No suitable vehicles found',
//       totalCost: enriched.length ? totalCost : null,
//       allocations: enriched,
//       unallocatedPackages: unallocated
//     });

//   } catch (err) {
//     const ms = Date.now() - t0;
//     try { await logApiPerf('/create-order', ms, false); } catch {}
//     logger.error('Error creating order:', err);
//     return res.status(500).json({ error: err.message });
//   }
// });

// /* ---- Sample route ---- */
// async function getPackagesByIds(packageIDs) {
//   const ph = packageIDs.map(_ => '?').join(',');
//   const [rows] = await db.query(`
//     SELECT * FROM packages WHERE pack_ID IN (${ph})`, packageIDs);
//   if (!rows.length) throw new Error('No matching packages');
//   return rows.map(r => ({
//     pack_ID: r.pack_ID,
//     ship_from: r.ship_from,
//     ship_to: r.ship_to,
//     products: safeJsonParse(r.product_ID),
//     pickup_date_time: r.pickup_date_time
//   }));
// }

// router.post('/sample-route', jwtAuth.verifyToken, async (req, res) => {
//   const t0 = Date.now();
//   try {
//     const { locations } = req.body;
//     if (!Array.isArray(locations) || locations.length < 2) {
//       return res.status(400).json({ error: 'Provide at least origin and destination.' });
//     }

//     const shipments = new Array(Math.max(0, locations.length - 1)).fill(0);
//     const { sampledCoords } = await getOptimizedRouteWithLoad(locations, shipments);

//     // respond first
//     res.status(200).json({ sampledRoutePoints: sampledCoords });

//     // non-blocking telemetry
//     noBlock(logApiPerf('/sample-route', Date.now() - t0, true), 'logApiPerf(/sample-route)');
//     noBlock(emit('route.sampled', { points: sampledCoords, at: Date.now() }), 'emit(route.sampled)');
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//     noBlock(logApiPerf('/sample-route', Date.now() - t0, false), 'logApiPerf(/sample-route)');
//     logger.error('Error sampling route:', err);
//   }
// });

// /* ---------------- helper endpoints ---------------- */

// // Traffic: returns legs + summary (Google only) — cached + non-blocking telemetry
// router.post('/route/traffic', jwtAuth.verifyToken, async (req, res) => {
//   const t0 = Date.now();
//   try {
//     const { locations, departureTimeEpoch = 0 } = req.body || {};
//     if (!Array.isArray(locations) || locations.length < 2) {
//       return res.status(400).json({ error: 'Provide at least origin and destination.' });
//     }
//     if (cfg.routingProvider !== 'google') {
//       return res.status(400).json({ error: 'Traffic is supported only when ROUTING_PROVIDER=google' });
//     }
//     if (!GOOGLE_API_KEY) {
//       return res.status(500).json({ error: 'Google API key missing' });
//     }

//     const depBucket = departureBucket(departureTimeEpoch);
//     const keyLocs = dedupeConsecutiveLocations(locations);
//     const cacheKey = `traffic:${cfg.routingProvider}:${depBucket}:${buildRouteKey(keyLocs)}`;

//     const cached = await getJSON(cacheKey);
//     if (cached) {
//       res.status(200).json(cached);
//       noBlock(logApiPerf('/route/traffic', Date.now() - t0, true), 'logApiPerf(/route/traffic)');
//       return;
//     }

//     const { legs, trafficSummary } = await fetchRouteGoogle(keyLocs, {
//       includeTraffic: true,
//       departureTimeEpoch
//     });

//     const payload = { provider: 'google', legs, summary: trafficSummary };

//     // respond immediately
//     res.status(200).json(payload);

//     // background cache + telemetry
//     noBlock(setJSON(cacheKey, payload, TRAFFIC_CACHE_TTL), 'traffic cache set');
//     noBlock(logApiPerf('/route/traffic', Date.now() - t0, true), 'logApiPerf(/route/traffic)');
//     noBlock(emit('route.traffic', { legs, summary: trafficSummary, at: Date.now() }), 'emit(route.traffic)');
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//     noBlock(logApiPerf('/route/traffic', Date.now() - t0, false), 'logApiPerf(/route/traffic)');
//     logger.error('Error on /route/traffic:', err);
//   }
// });

// // Weather: accepts points[] or locations[] and samples along polyline
// router.post('/route/weather', jwtAuth.verifyToken, async (req, res) => {
//   const t0 = Date.now();
//   try {
//     if (!OPENWEATHER_API_KEY) {
//       return res.status(500).json({ error: 'OPENWEATHER_API_KEY missing' });
//     }
//     const { points, locations, units = WEATHER_UNITS_DEFAULT, sampleEveryKm = WEATHER_SAMPLE_EVERY_KM_DEFAULT, maxPoints = WEATHER_MAX_POINTS_DEFAULT } = req.body || {};

//     let usePoints = Array.isArray(points) ? points : null;
//     if ((!usePoints || !usePoints.length) && Array.isArray(locations) && locations.length >= 2) {
//       const shipments = new Array(Math.max(0, locations.length - 1)).fill(0);
//       const { sampledCoords } = await getOptimizedRouteWithLoad(locations, shipments, {
//         sampleEveryKm,
//         maxSamplePoints: maxPoints
//       });
//       usePoints = sampledCoords;
//     }

//     if (!usePoints || !usePoints.length) {
//       return res.status(400).json({ error: 'Provide points[] or locations[] (>=2)' });
//     }

//     // NEW: normalize potential {latitude,longitude} inputs to {lat,lng}
//     const normalized = usePoints.map(normalizePoint);

//     const { pointsWeather, summary } = await getWeatherAlongRoute(normalized, { units, maxPoints });

//     // respond first
//     const payload = { units, pointsWeather, summary };
//     res.status(200).json(payload);

//     // non-blocking telemetry
//     noBlock(logApiPerf('/route/weather', Date.now() - t0, true), 'logApiPerf(/route/weather)');
//     noBlock(emit('route.weather', { count: pointsWeather.length, at: Date.now() }), 'emit(route.weather)');
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//     noBlock(logApiPerf('/route/weather', Date.now() - t0, false), 'logApiPerf(/route/weather)');
//     logger.error('Error on /route/weather:', err);
//   }
// });

// module.exports = router;



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

/* ----------------------- CONFIG ----------------------- */
const GOOGLE_API_KEY = cfg.googleApiKey;
const OPENWEATHER_API_KEY = (cfg.openWeatherApiKey || process.env.OPENWEATHER_API_KEY || '').trim();
const WEATHER_UNITS_DEFAULT = (cfg.weatherUnits || process.env.WEATHER_UNITS || 'metric').trim();
const WEATHER_CACHE_TTL = Number(cfg.weatherCacheTtl || 600);
const WEATHER_MAX_POINTS_DEFAULT = 30;
const WEATHER_SAMPLE_EVERY_KM_DEFAULT = 20;

// External HTTP timeouts & concurrency caps
const AXIOS_TIMEOUT_MS = Number(cfg.httpTimeoutMs || process.env.HTTP_TIMEOUT_MS || 3500);
const WEATHER_CONCURRENCY = Number(cfg.weatherConcurrency || process.env.WEATHER_CONCURRENCY || 5);

// Traffic cache TTL (seconds)
const TRAFFIC_CACHE_TTL = Number(cfg.trafficCacheTtl || process.env.TRAFFIC_CACHE_TTL || 120);
// Route result cache TTL (seconds) for polyline + legs
const ROUTE_CACHE_TTL = Number(cfg.routeCacheTtl || process.env.ROUTE_CACHE_TTL || 600);

/* ---------------------- helpers ---------------------- */
function buildRouteKey(locations) {
  return locations.map(loc => `${loc.latitude},${loc.longitude}`).join('|');
}
function toRadians(deg) { return deg * Math.PI / 180; }
function distanceBetweenCoords(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function sampleRoutePoints(coords, intervalKm = 20, maxPoints = Infinity) {
  if (!coords.length) return [];
  const sampled = [coords[0]];
  let last = coords[0], acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = distanceBetweenCoords(last.lat, last.lng, coords[i].lat, coords[i].lng);
    acc += d;
    if (acc >= intervalKm) {
      sampled.push(coords[i]);
      last = coords[i];
      acc = 0;
      if (sampled.length >= maxPoints) break;
    }
  }
  if (sampled[sampled.length - 1] !== coords[coords.length - 1] && sampled.length < maxPoints) {
    sampled.push(coords[coords.length - 1]);
  }
  return sampled;
}
function parseDistanceText(txt = '') {
  if (!txt) return 0;
  const num = parseFloat(String(txt).replace(/[^\d.]/g, '')) || 0;
  if (/km/i.test(txt)) return num;        // already in km
  if (/\bm\b/i.test(txt)) return num / 1000; // meters -> km
  return num; // assume km if unit missing
}

const kmText = m => `${(m / 1000).toFixed(1)} km`;
const minText = s => `${Math.round(s / 60)} mins`;

// Fire-and-forget so telemetry never blocks a response
function noBlock(promise, label, ms = 400) {
  Promise.race([
    promise,
    new Promise(resolve => setTimeout(resolve, ms))
  ]).catch(e => logger && logger.warn && logger.warn(`${label} failed`, { msg: e.message }));
}

// simple batching helper (limits concurrent promises)
async function runInBatches(items, batchSize, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const res = await Promise.all(slice.map(worker));
    out.push(...res);
  }
  return out;
}

/* --------- NEW: point and location normalizers --------- */
function normalizePoint(p) {
  if (p && typeof p === 'object') {
    if ('lat' in p && 'lng' in p) return { lat: +p.lat, lng: +p.lng };
    if ('latitude' in p && 'longitude' in p) return { lat: +p.latitude, lng: +p.longitude };
  }
  throw new Error('Bad point: expected {lat,lng} or {latitude,longitude}');
}
function dedupeConsecutiveLocations(locs) {
  if (!Array.isArray(locs) || locs.length === 0) return [];
  const out = [locs[0]];
  for (let i = 1; i < locs.length; i++) {
    const a = out[out.length - 1], b = locs[i];
    if (a.latitude !== b.latitude || a.longitude !== b.longitude) out.push(b);
  }
  return out;
}

/* --------- normalize departure & cache bucket helpers --------- */
function normalizeDeparture(epoch) {
  const now = Math.floor(Date.now() / 1000);
  if (!epoch || epoch < now - 600) return now;        // clamp past to "now"
  const maxAhead = 24 * 3600;                         // cap future to 24h
  return Math.min(epoch, now + maxAhead);
}
function departureBucket(epoch, minutes = 15) {
  const e = normalizeDeparture(epoch);
  return Math.floor(e / (minutes * 60));
}

/* ---------------- WEATHER HELPERS (OpenWeather) ---------------- */
function wKey(lat, lng, units) {
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('Invalid lat/lng for weather key');
  return `weather:${units}:${la.toFixed(2)},${lo.toFixed(2)}`;
}
async function fetchWeatherPoint(lat, lng, units = WEATHER_UNITS_DEFAULT) {
  if (!OPENWEATHER_API_KEY) throw new Error('OPENWEATHER_API_KEY missing');
  const key = wKey(lat, lng, units);
  const cached = await getJSON(key);
  if (cached) return cached;

  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_API_KEY}&units=${units}`;
  const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
  const d = resp.data || {};
  const out = {
    lat: +lat,
    lng: +lng,
    at: Math.floor(Date.now() / 1000),
    units,
    temp: d.main?.temp ?? null,
    feelsLike: d.main?.feels_like ?? null,
    humidity: d.main?.humidity ?? null,
    windSpeed: d.wind?.speed ?? null,
    windDir: d.wind?.deg ?? null,
    condition: (d.weather && d.weather[0]?.main) || null,
    icon: (d.weather && d.weather[0]?.icon) || null,
    precip1h: (d.rain && (d.rain['1h'] || 0)) || (d.snow && (d.snow['1h'] || 0)) || 0
  };
  await setJSON(key, out, WEATHER_CACHE_TTL);
  return out;
}

// Parallel + resilient weather fetch with concurrency limit
async function getWeatherAlongRoute(points, { units = WEATHER_UNITS_DEFAULT, maxPoints = WEATHER_MAX_POINTS_DEFAULT } = {}) {
  const use = Array.isArray(points) ? points.slice(0, maxPoints) : [];
  if (!use.length) {
    return { pointsWeather: [], summary: { minTemp: null, maxTemp: null, distinctConditions: [], points: 0 }, units };
  }

  const results = await runInBatches(use, WEATHER_CONCURRENCY, async (p) => {
    try {
      return await fetchWeatherPoint(p.lat, p.lng, units);
    } catch (e) {
      logger.warn('weather fetch failed at point', {
        point: p,
        status: e?.response?.status,
        data: e?.response?.data,
        msg: e?.message || String(e)
      });
      return null;
    }
  });

  const ok = results.filter(Boolean);
  const temps = ok.map(r => r.temp).filter(v => typeof v === 'number');
  const conds = new Set(ok.map(r => r.condition).filter(Boolean));
  const summary = {
    minTemp: temps.length ? Math.min(...temps) : null,
    maxTemp: temps.length ? Math.max(...temps) : null,
    distinctConditions: Array.from(conds),
    points: ok.length
  };
  return { pointsWeather: ok, summary, units };
}

/* ------------------ ROUTING (Google / OSRM) ------------------ */
async function fetchRouteGoogle(locations, { includeTraffic = false, departureTimeEpoch = 0 } = {}) {
  locations = dedupeConsecutiveLocations(locations);

  const origin = locations[0];
  const dest = locations[locations.length - 1];
  const waypoints = locations.length > 2
    ? locations.slice(1, -1).map(l => `${l.latitude},${l.longitude}`).join('|')
    : '';

  const params = [
    `origin=${origin.latitude},${origin.longitude}`,
    `destination=${dest.latitude},${dest.longitude}`,
    waypoints ? `waypoints=${waypoints}` : '',
    `mode=driving`,
    `key=${GOOGLE_API_KEY}`
  ];

  if (includeTraffic) {
    const dep = normalizeDeparture(departureTimeEpoch);
    params.push('region=IN');
    params.push('departure_time=' + dep);
    params.push('traffic_model=best_guess');
  }

  const url = `https://maps.googleapis.com/maps/api/directions/json?${params.filter(Boolean).join('&')}`;
  const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
  const data = resp?.data || {};
  if (data.status !== 'OK') {
    const err = new Error(`Google error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
    logger.error('Google Directions failed', {
      status: data.status,
      error_message: data.error_message,
      waypointCount: locations.length,
      includeTraffic,
      departureTimeEpoch
    });
    throw err;
  }
  const r0 = data.routes[0] || {};
  const legs = r0.legs || [];
  const poly = r0.overview_polyline?.points || '';
  const decoded = poly ? polyline.decode(poly).map(([lat, lng]) => ({ lat, lng })) : [];

  const mappedLegs = legs.map((leg, i) => {
    const base = {
      start: {
        address: leg.start_address,
        latitude: locations[i].latitude,
        longitude: locations[i].longitude
      },
      end: {
        address: leg.end_address,
        latitude: locations[i + 1].latitude,
        longitude: locations[i + 1].longitude
      },
      distance: leg.distance?.text || '',
      duration: leg.duration?.text || ''
    };

    if (includeTraffic && leg.duration_in_traffic?.value != null) {
      const normalSec = leg.duration?.value || 0;
      const trafficSec = leg.duration_in_traffic.value;
      base.durationInTraffic = leg.duration_in_traffic?.text || base.duration;
      base.trafficDelaySec = Math.max(0, trafficSec - normalSec);
      base.traffic = {
        durationInTrafficSec: trafficSec,
        normalDurationSec: normalSec,
        delaySec: Math.max(0, trafficSec - normalSec)
      };
    }

    return base;
  });

  if (includeTraffic && legs.some(l => l?.duration_in_traffic?.value == null)) {
    logger.warn('Google: duration_in_traffic missing for some legs', {
      legCount: legs.length
    });
  }

  let trafficSummary = null;
  if (includeTraffic) {
    const delays = mappedLegs.map(l => +l.trafficDelaySec || 0);
    const totalDelaySec = delays.reduce((s, n) => s + n, 0);
    const avgDelay = mappedLegs.length ? Math.round(totalDelaySec / mappedLegs.length) : 0;
    const congestion = totalDelaySec > 3600 ? 'high' : totalDelaySec > 900 ? 'medium' : 'low';
    trafficSummary = {
      trafficAt: normalizeDeparture(departureTimeEpoch),
      totalDelaySec,
      avgDelayPerLegSec: avgDelay,
      congestion
    };
  }

  return { legs: mappedLegs, shape: decoded, trafficSummary };
}

async function fetchRouteOSRM(locations) {
  locations = dedupeConsecutiveLocations(locations);

  const coords = locations.map(p => `${p.longitude},${p.latitude}`).join(';');
  const url = `${cfg.osrmBaseUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
  const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
  if (resp.data.code !== 'Ok') {
    throw new Error(`OSRM error: ${resp.data.code}`);
  }
  const route = resp.data.routes[0];
  const decoded = polyline.decode(route.geometry)
    .map(([lat, lng]) => ({ lat, lng }));

  const legs = (route.legs || []).map((leg, i) => ({
    start: {
      address: '',
      latitude: locations[i].latitude,
      longitude: locations[i].longitude
    },
    end: {
      address: '',
      latitude: locations[i + 1].latitude,
      longitude: locations[i + 1].longitude
    },
    distance: kmText(leg.distance || 0),
    duration: minText(leg.duration || 0)
  }));

  return { legs, shape: decoded, trafficSummary: null };
}

/**
 * Core helper that:
 *  - checks Redis cache
 *  - fetches route from provider (Google or OSRM)
 *  - computes sampled points every ~N km
 *  - returns { optimizedRoute[], sampledCoords[], trafficSummary }
 */
async function getOptimizedRouteWithLoad(locations, shipmentLoads, {
  includeTraffic = false,
  departureTimeEpoch = 0,
  sampleEveryKm = WEATHER_SAMPLE_EVERY_KM_DEFAULT,
  maxSamplePoints = Infinity
} = {}) {
  if (!Array.isArray(locations) || locations.length < 2) {
    throw new Error('Need at least origin and destination');
  }

  locations = dedupeConsecutiveLocations(locations);

  const depBucket = includeTraffic ? departureBucket(departureTimeEpoch) : 0;
  const cacheKey = `route:${cfg.routingProvider}:${includeTraffic ? 'T' : 'N'}:${depBucket}:${buildRouteKey(locations)}:${sampleEveryKm}:${maxSamplePoints}`;
  const cached = await getJSON(cacheKey);
  let optimizedRoute, sampledCoords, trafficSummary, shape;

  if (cached) {
    optimizedRoute = cached.optimizedRoute;
    trafficSummary = cached.trafficSummary || null;
    shape = cached.shape || null;
    if (shape && Array.isArray(shape)) {
      sampledCoords = sampleRoutePoints(shape, sampleEveryKm, maxSamplePoints);
    } else {
      sampledCoords = cached.sampledCoords || [];
    }
  } else {
    let legs, trafficSummaryLocal = null, shapeLocal = [];
    if (cfg.routingProvider === 'osrm') {
      ({ legs, shape: shapeLocal, trafficSummary: trafficSummaryLocal } = await fetchRouteOSRM(locations));
    } else {
      ({ legs, shape: shapeLocal, trafficSummary: trafficSummaryLocal } = await fetchRouteGoogle(locations, { includeTraffic, departureTimeEpoch }));
    }

    const builtRoute = [];
    let currentLoad = 0;
    legs.forEach((leg, i) => {
      const load = shipmentLoads[i] || 0;
      currentLoad += load;
      if (
        leg.start.latitude !== leg.end.latitude ||
        leg.start.longitude !== leg.end.longitude
      ) {
        builtRoute.push({ ...leg, loadAfterStop: currentLoad });
      }
    });

    optimizedRoute = builtRoute;
    shape = shapeLocal || [];
    sampledCoords = sampleRoutePoints(shape, sampleEveryKm, maxSamplePoints);
    trafficSummary = trafficSummaryLocal;

    await setJSON(cacheKey, { optimizedRoute, shape, trafficSummary }, ROUTE_CACHE_TTL);
  }

  let currentLoad = 0;
  const recomputed = optimizedRoute.map((leg, i) => {
    currentLoad += (shipmentLoads[i] || 0);
    return { ...leg, loadAfterStop: currentLoad };
  });

  return { optimizedRoute: recomputed, sampledCoords, trafficSummary };
}

/* ------------------- bearing / clustering ------------------- */
function getBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(to1(lat1)) * Math.sin(to1(lat2)) -
    Math.sin(to1(lat1)) * Math.cos(to1(lat2)) * Math.cos(toRad(lon2 - lon1));
  function to1(d){return d*Math.PI/180}
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function getDirection8(b) {
  if (b < 22.5 || b >= 337.5) return 'N';
  if (b < 67.5) return 'NE';
  if (b < 112.5) return 'E';
  if (b < 157.5) return 'SE';
  if (b < 202.5) return 'S';
  if (b < 247.5) return 'SW';
  if (b < 292.5) return 'W';
  return 'NW';
}
function isDirectionCompatible(a, b) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  let iA = dirs.indexOf(a), iB = dirs.indexOf(b);
  if (iA < 0 || iB < 0) return false;
  let d = Math.abs(iA - iB);
  if (d > 4) d = 8 - d;
  return d <= 1;
}
function groupPackagesByDirection(pkgs) {
  const visited = new Set(), groups = [];
  for (let i = 0; i < pkgs.length; i++) {
    if (visited.has(i)) continue;
    const queue = [i], cluster = [pkgs[i]];
    visited.add(i);
    while (queue.length) {
      const idx = queue.shift();
      for (let j = 0; j < pkgs.length; j++) {
        if (!visited.has(j) && isDirectionCompatible(pkgs[idx].direction8, pkgs[j].direction8)) {
          visited.add(j);
          queue.push(j);
          cluster.push(pkgs[j]);
        }
      }
    }
    groups.push(cluster);
  }
  return groups;
}

/* ---------------------- DB helpers ----------------------- */
function isVehicleValid(v) {
  const t = new Date(), from = new Date(v.transportation_details.validity_from),
    to = new Date(v.transportation_details.validity_to);
  return t >= from && t <= to;
}
function isVehicleDown(v) {
  if (!v.downtimes.downtime_starts_from) return false;
  const now = new Date(),
    s = new Date(v.downtimes.downtime_starts_from),
    e = new Date(v.downtimes.downtime_ends_from);
  return now >= s && now <= e;
}
async function getLocationById(loc_ID) {
  const [rows] = await db.query(`
    SELECT latitude, longitude, loc_desc
    FROM master_locations WHERE loc_ID=?`, [loc_ID]);
  if (!rows.length) throw new Error(`Location not found: ${loc_ID}`);
  return {
    latitude: parseFloat(rows[0].latitude) || 0,
    longitude: parseFloat(rows[0].longitude) || 0,
    loc_desc: rows[0].loc_desc || ''
  };
}
function safeJsonParse(val, def = []) {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return def; }
  }
  return val || def;
}
function getPackageSpecialFlags(pkg, productMap) {
  let f = 0, d = 0, h = 0, t = 0;
  for (const pr of pkg.products) {
    const info = productMap[pr.prod_ID];
    if (!info) continue;
    if (info.fragile_goods) f = 1;
    if (info.dangerous_goods) d = 1;
    if (info.hazardous) h = 1;
    if (info.temp_controlled) t = 1;
  }
  return { fragile: f, dangerous: d, hazardous: h, tempCtrl: t };
}
function getVehicleSpecialFlags(v) {
  return {
    fragile_vehicle: v.fragile_vehicle || 0,
    danger_proof: v.danger_proof || 0,
    hazardous_proof: v.hazardous_proof || 0,
    temp_controlled_vehicle: v.temp_controlled_vehicle || 0
  };
}
function checkPackageVehicleCompatibility(pkgF, vehF) {
  const pkgIsNormal = !pkgF.fragile && !pkgF.dangerous && !pkgF.hazardous && !pkgF.tempCtrl;
  if (pkgIsNormal) {
    return !vehF.fragile_vehicle &&
      !vehF.danger_proof &&
      !vehF.hazardous_proof &&
      !vehF.temp_controlled_vehicle;
  }
  if (pkgF.fragile && !vehF.fragile_vehicle) return false;
  if (pkgF.dangerous && !vehF.danger_proof) return false;
  if (pkgF.hazardous && !vehF.hazardous_proof) return false;
  if (pkgF.tempCtrl && !vehF.temp_controlled_vehicle) return false;
  return true;
}

/* ---------- packaging helpers (ONLY master_products.packaging_type) --------- */
function normalizePacId(pac) {
  if (!pac) return null;
  const s = String(pac).trim();
  const m = s.match(/^PKG(\d+)$/i);
  if (!m) return s;
  return 'PKG' + m[1].padStart(6, '0');
}
function resolvePacIdsFromProduct(prodRow) {
  if (!prodRow) return [];
  let pt = prodRow.packaging_type;
  if (typeof pt === 'string') {
    try { pt = JSON.parse(pt); } catch { pt = null; }
  }
  if (!Array.isArray(pt)) return [];
  return pt
    .filter(x => x && x.pac_ID)
    .map(x => normalizePacId(x.pac_ID))
  .filter(Boolean);
}
async function loadAllPackageInfo(pacIDs) {
  if (!pacIDs.length) return {};
  const ph = pacIDs.map(_ => '?').join(',');
  const [rows] = await db.query(`
    SELECT * FROM master_package_info WHERE pac_ID IN (${ph})`, pacIDs);
  return rows.reduce((m, r) => { m[r.pac_ID] = r; return m; }, {});
}
function collectAllPacIDs(packagesData, productMap) {
  const ids = new Set();
  for (const pkg of packagesData) {
    for (const line of (pkg.products || [])) {
      const pacIds = resolvePacIdsFromProduct(productMap[line.prod_ID]);
      pacIds.forEach(id => id && ids.add(id));
    }
  }
  return [...ids];
}
async function sumPackageWeightVolume(pkg, productMap, pkgInfoMap) {
  let totalW = 0, totalV = 0;
  for (const line of pkg.products) {
    const prod = productMap[line.prod_ID];
    if (!prod) continue;
    totalW += parseWeightAndUOM(prod.weight, prod.weight_uom) * line.quantity;

    const pacIds = resolvePacIdsFromProduct(prod);
    let info = pacIds.length ? (pkgInfoMap[pacIds[0]] || null) : null;
    if (info) {
      totalV += parseVolumeAndUOM(info.pack_volume, info.pack_volume_uom) * line.quantity;
    } else {
      // fallback: derive from product volume so we never drop items
      const vol = parseVolumeAndUOM(prod.volume, prod.volume_uom);
      if (vol > 0) totalV += vol * line.quantity;
    }
  }
  return { totalW, totalV };
}

/* ---------------- backtracking cost solver ---------------- */
async function findMinCostArrangement(cluster, vehicles, sourceLoc) {
  vehicles = vehicles.slice().sort((a, b) => a.cost_per_ton - b.cost_per_ton);

  let best = {
    cost: Infinity,
    allocations: [],
    unallocated: cluster.map(p => p.pack_ID),
    placedCount: 0
  };

  function snapshot(used, remaining) {
    return {
      cost: used.reduce((s, a) => s + a.cost, 0),
      allocations: JSON.parse(JSON.stringify(used)),
      unallocated: remaining.map(r => r.pack_ID),
      placedCount: cluster.length - remaining.length
    };
  }

  async function backtrack(rem, iVeh, used) {
    if (!rem.length) {
      const shot = snapshot(used, rem);
      if (shot.placedCount > best.placedCount ||
          (shot.placedCount === best.placedCount && shot.cost < best.cost)) best = shot;
      return;
    }
    if (iVeh >= vehicles.length) {
      const shot = snapshot(used, rem);
      if (shot.placedCount > best.placedCount ||
          (shot.placedCount === best.placedCount && shot.cost < best.cost)) best = shot;
      return;
    }

    const v = vehicles[iVeh];
    const subsets = [];

    function buildSub(idx, chosen, sumW, sumV, flags) {
      if (idx === rem.length) {
        subsets.push({ chosen, sumW, sumV, flags });
        return;
      }
      buildSub(idx + 1, chosen, sumW, sumV, flags);
      const pkg = rem[idx];
      const newW = sumW + pkg.totalWeight;
      const newV = sumV + pkg.totalVolume;
      if (newW <= v.weightCapKg && newV <= v.usableVol) {
        const nf = { ...flags };
        nf.fragile ||= pkg.specialFlags.fragile;
        nf.dangerous ||= pkg.specialFlags.dangerous;
        nf.hazardous ||= pkg.specialFlags.hazardous;
        nf.tempCtrl ||= pkg.specialFlags.tempCtrl;
        if (checkPackageVehicleCompatibility(nf, getVehicleSpecialFlags(v))) {
          buildSub(idx + 1, [...chosen, pkg], newW, newV, nf);
        }
      }
    }

    buildSub(0, [], 0, 0, { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 });

    for (const { chosen, sumW } of subsets) {
      if (!chosen.length) continue;

      chosen.sort((a, b) => a.distFromSource - b.distFromSource);
      const locs = [sourceLoc, ...chosen.map(x => x.destination)];
      const shipments = new Array(chosen.length).fill(1);

      const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(locs, shipments);

      const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
      const tons = sumW / 1000;
      const cost = tons * v.cost_per_ton * totalDist;

      let loadArr = [], remainIDs = chosen.map(x => x.pack_ID);
      optimizedRoute.forEach((leg, i) => {
        const stop = i + 1, matches = [];
        for (const id of remainIDs) {
          const pObj = chosen.find(x => x.pack_ID === id);
          if (pObj &&
              pObj.destination.latitude === leg.end.latitude &&
              pObj.destination.longitude === leg.end.longitude) {
            matches.push(id);
          }
        }
        if (matches.length) {
          matches.forEach(m => remainIDs.splice(remainIDs.indexOf(m), 1));
          loadArr.push({ stop, location: leg.end.address, packages: matches });
        }
      });

      used.push({
        vehicle_ID: v.vehicle_ID,
        totalWeightCapacity: v.totalWeightCapacity,
        totalVolumeCapacity: v.totalVolumeCapacity,
        occupiedWeight: sumW,
        occupiedVolume: chosen.reduce((s, p) => s + p.totalVolume, 0),
        leftoverWeight: v.weightCapKg - sumW,
        leftoverVolume: v.volumeCapM3 - chosen.reduce((s, p) => s + p.totalVolume, 0),
        cost,
        packages: chosen.map(x => x.pack_ID),
        route: optimizedRoute,
        loadArrangement: loadArr,
        sampledRoutePoints: sampledCoords
      });

      await backtrack(rem.filter(r => !chosen.includes(r)), iVeh + 1, used);
      used.pop();
    }
    await backtrack(rem, iVeh + 1, used);
  }

  await backtrack(cluster, 0, []);
  return (best.placedCount > 0)
    ? { cost: best.cost, allocations: best.allocations, unallocated: best.unallocated }
    : { cost: 0, allocations: [], unallocated: best.unallocated };
}

function generateUnallocationReason(pkgInfo, vehicles) {
  if (!vehicles.length) return 'No vehicles after filters.';
  const fleet = vehicles.map(getVehicleSpecialFlags);
  if (pkgInfo.specialFlags.tempCtrl && !fleet.some(v => v.temp_controlled_vehicle))
    return 'Needs temperature-controlled truck.';
  if (pkgInfo.specialFlags.fragile && !fleet.some(v => v.fragile_vehicle))
    return 'Needs fragile-goods truck.';
  if (pkgInfo.specialFlags.dangerous && !fleet.some(v => v.danger_proof))
    return 'Needs dangerous-goods truck.';
  if (pkgInfo.specialFlags.hazardous && !fleet.some(v => v.hazardous_proof))
    return 'Needs hazardous-goods truck.';

  const maxW = Math.max(...vehicles.map(v => v.weightCapKg));
  const maxV = Math.max(...vehicles.map(v => v.volumeCapM3));
  if (pkgInfo.totalWeight > maxW) return 'Package too heavy for any truck.';
  if (pkgInfo.totalVolume > maxV) return 'Package too large for any truck.';
  return 'Could not allocate package.';
}

/* ---------------- allocation orchestration ---------------- */
async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap, extra = {}) {
  const {
    includeTraffic = false,
    departureTimeEpoch = 0,
    weatherOpts = {}
  } = extra;

  const allocations = [], unallocatedPackages = [];
  let totalCost = 0;
  const pkgInfos = [];

  for (const pkg of packagesData) {
    const { totalW, totalV } = await sumPackageWeightVolume(pkg, productMap, packagingInfoMap);
    const destLoc = await getLocationById(pkg.ship_to);
    const bearing = getBearing(sourceLocation.latitude, sourceLocation.longitude, destLoc.latitude, destLoc.longitude);
    const dir8 = getDirection8(bearing);
    const distKM = distanceBetweenCoords(sourceLocation.latitude, sourceLocation.longitude, destLoc.latitude, destLoc.longitude);
    const flags = getPackageSpecialFlags(pkg, productMap);
    pkgInfos.push({
      pack_ID: pkg.pack_ID,
      totalWeight: totalW,
      totalVolume: totalV,
      destination: destLoc,
      direction8: dir8,
      distFromSource: distKM,
      specialFlags: flags
    });
  }

  const groups = groupPackagesByDirection(pkgInfos);
  for (const group of groups) {
    const sumW = group.reduce((s, g) => s + g.totalWeight, 0);
    const sumV = group.reduce((s, g) => s + g.totalVolume, 0);
    const combinedFlags = group.reduce((f, g) => ({
      fragile: f.fragile || g.specialFlags.fragile,
      dangerous: f.dangerous || g.specialFlags.dangerous,
      hazardous: f.hazardous || g.specialFlags.hazardous,
      tempCtrl: f.tempCtrl || g.specialFlags.tempCtrl
    }), { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 });

    let feasible = vehicles.filter(v =>
      v.weightCapKg >= sumW &&
      v.usableVol >= sumV &&
      checkPackageVehicleCompatibility(combinedFlags, getVehicleSpecialFlags(v))
    );

    if (feasible.length) {
      feasible.sort((a, b) => a.cost_per_ton - b.cost_per_ton);
      const chosen = feasible[0];

      group.sort((a, b) => a.distFromSource - b.distFromSource);
      const routeLocs = [sourceLocation, ...group.map(g => g.destination)];
      const shipments = new Array(group.length).fill(1);

      const { optimizedRoute, sampledCoords, trafficSummary } =
        await getOptimizedRouteWithLoad(routeLocs, shipments, {
          includeTraffic,
          departureTimeEpoch,
          sampleEveryKm: weatherOpts.sampleEveryKm || WEATHER_SAMPLE_EVERY_KM_DEFAULT,
          maxSamplePoints: weatherOpts.maxPoints || WEATHER_MAX_POINTS_DEFAULT
        });

      const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
      const tons = sumW / 1000;
      const cost = tons * chosen.cost_per_ton * totalDist;
      totalCost += cost;

      let loadArr = [], remainIDs = group.map(g => g.pack_ID);
      optimizedRoute.forEach((leg, i) => {
        const stop = i + 1, using = [];
        remainIDs.forEach(id => {
          const pkg = group.find(g => g.pack_ID === id);
          if (pkg &&
              pkg.destination.latitude === leg.end.latitude &&
              pkg.destination.longitude === leg.end.longitude) {
            using.push(id);
          }
        });
        if (using.length) {
          using.forEach(id => remainIDs.splice(remainIDs.indexOf(id), 1));
          loadArr.push({ stop, location: leg.end.address, packages: using });
        }
      });

      allocations.push({
        vehicle_ID: chosen.vehicle_ID,
        totalWeightCapacity: chosen.totalWeightCapacity,
        totalVolumeCapacity: chosen.totalVolumeCapacity,
        occupiedWeight: sumW,
        occupiedVolume: group.reduce((s, g) => s + g.totalVolume, 0),
        leftoverWeight: chosen.weightCapKg - sumW,
        leftoverVolume: chosen.volumeCapM3 - group.reduce((s, g) => s + g.totalVolume, 0),
        cost,
        packages: group.map(g => g.pack_ID),
        pkgVolumes: group.map(g => g.totalVolume),
        route: optimizedRoute,
        trafficSummary,
        loadArrangement: loadArr,
        sampledRoutePoints: sampledCoords
      });

    } else {
      const { cost, allocations: subAllocs, unallocated } =
        await findMinCostArrangement(group, vehicles, sourceLocation);
      totalCost += cost;
      allocations.push(...subAllocs);
      unallocated.forEach(id => {
        const info = pkgInfos.find(p => p.pack_ID === id);
        unallocatedPackages.push({
          pack_ID: id,
          reason: generateUnallocationReason(info, vehicles)
        });
      });
    }
  }

  return { allocations, totalCost, unallocated: unallocatedPackages };
}

/* ------------------- dimension + 3D placement ------------------- */
function parseDimension(str = '') {
  if (typeof str === 'number') return +str || 0;
  const m = String(str).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  return /cm/i.test(str) ? val / 100 : val;
}
function r3(n) { return Math.round(n * 1000) / 1000; }

/* ---------- deterministic color (hash-based) so legend === 3D ---------- */
function _fnv1a32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function _hslToRgbHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = v => {
    const n = Math.round((v + m) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function colorHexForKey(key) {
  const h = _fnv1a32(String(key));
  const hue = h % 360;
  const sat = 60 + ((h >> 3) % 20);
  const light = 45 + ((h >> 7) % 20);
  return _hslToRgbHex(hue, sat, light);
}

/** color map keyed by "prod|pkg" so legend colors match placements */
function buildColorMapByProdPkg(packageInfoDetails) {
  const colorByKey = {};
  for (const p of packageInfoDetails) {
    const pkg_ID = p.pkg_ID;
    for (const l of (p.lines || [])) {
      if (!l?.prod_ID) continue;
      const key = `${l.prod_ID}|${pkg_ID}`;
      if (!colorByKey[key]) colorByKey[key] = colorHexForKey(key);
    }
  }
  return colorByKey;
}

/** derive a cube from per-unit volume (m³) when no packaging dims exist */
function deriveDimsFromVolumeM3(volM3) {
  if (!volM3 || volM3 <= 0) return null;
  const side = Math.cbrt(Number(volM3));
  return { lengthM: side, widthM: side, heightM: side };
}

/** tallest pack height helper */
function getMaxBoxHeight(packageInfoDetails) {
  let h = 0;
  for (const p of packageInfoDetails) {
    for (const l of (p.lines || [])) {
      if (l?.packagingDimensions?.heightM) {
        h = Math.max(h, +l.packagingDimensions.heightM);
      }
    }
  }
  return h || 0.5;
}

/* ========= FIXED: 3D placement (FILO, row-by-row, SF-aware) =========
   - Packs each stop in a "slice" of truck length.
   - Fills rows across width (Z). Only advances X when a stop is done.
   - Respects per-line stacking factor and truck height.
   - position = [x, y, z]; dimensions = [length, height, width]
*/
function computeBoxPlacements(loadArrangement, packageInfoDetails, vehicleDimensions, opts = {}) {
  const truck = {
    interiorWidthM: Number(vehicleDimensions?.interiorWidthM || 0),
    interiorLengthM: Number(vehicleDimensions?.interiorLengthM || 0),
    interiorHeightM: Number(vehicleDimensions?.interiorHeightM || 0)
  };

  const Z_GUTTER = Number(opts.zGutter ?? 0.0);
  const FRONT_GUTTER_X = Number(opts.frontGutter ?? 0.0);
  const LAYER_GAP = Number(opts.layerGap ?? 0.02);
  const allowedGlobalLayers = Math.max(1, Number(opts.maxLayers || 1));
  const EPS = 1e-9;

  const colorByKey = opts.colorByProdPkg || buildColorMapByProdPkg(packageInfoDetails);
  const pkgMap = new Map(packageInfoDetails.map(p => [p.pkg_ID, p]));

  // FILO: last drop (highest stop) packed first (deepest)
  const stopsDesc = [...loadArrangement].sort((a, b) => b.stop - a.stop);

  const placements = [];
  let maxLayersUsed = 1;

  const W = truck.interiorWidthM;
  const L = truck.interiorLengthM;
  const H = truck.interiorHeightM;

  let cursorX = 0; // front-to-back (0 is deepest), door is near L

  function expandStopLines(stop) {
    const items = [];
    for (const pkgId of (stop.packages || [])) {
      const pkg = pkgMap.get(pkgId);
      if (!pkg) continue;
      for (const line of (pkg.lines || [])) {
        const dims = line.packagingDimensions || null;
        if (!dims || !(+dims.lengthM > 0 && +dims.widthM > 0 && +dims.heightM > 0)) continue;

        const Lp = +dims.lengthM, Wp = +dims.widthM, Hp = +dims.heightM;
        const qty = Number(line.quantity || 0);
        if (!(Lp > 0 && Wp > 0 && Hp > 0) || qty <= 0) continue;

        // vertical layers allowed by truck height & product SF
        const hCap = Math.max(1, Math.floor(H / Hp));
        const lineSfCap = Math.max(1, Number(line.sfCap || line.stacking_factor || line.allowedLayers || 1));
        const perStackMax = Math.min(hCap, lineSfCap, allowedGlobalLayers);

        items.push({
          pkg_ID: pkgId,
          prod_ID: line.prod_ID,
          qty,
          L: Lp,
          W: Wp,
          H: Hp,
          perStackMax,
          color: colorByKey[`${line.prod_ID}|${pkgId}`] || '#999'
        });
      }
    }

    // pack largest footprints first (then taller)
    items.sort((a, b) => {
      const fa = a.L * a.W, fb = b.L * b.W;
      if (fb !== fa) return fb - fa;
      if (b.H !== a.H) return b.H - a.H;
      return String(a.prod_ID).localeCompare(String(b.prod_ID));
    });

    return items;
  }

  function placeStopSlice(items) {
    // Row-based packing across Z; track deepest length used by any row in this stop.
    let rowZ = 0;
    let rowWidthUsed = 0;
    let sliceDepthX = 0; // how much length this stop consumes
    let rows = 0;

    // helper to start a new row within current stop slice
    function newRow() {
      rowZ = 0;
      rowWidthUsed = 0;
      rows += 1;
    }
    newRow();

    for (const it of items) {
      let remaining = it.qty;

      while (remaining > 0) {
        // prefer orientation that uses less length (helps keep slice shallow)
        const o1 = { l: it.L, w: it.W };
        const o2 = { l: it.W, w: it.L };
        const candidates = [o1, o2].sort((a, b) => a.l - b.l);

        let chosen = null;
        // Try to fit in current row; if width overflow, start a new row and retry
        for (let attempt = 0; attempt < 2 && !chosen; attempt++) {
          if (rowWidthUsed + Math.min(o1.w, o2.w) > W + EPS) {
            // width is full -> start a new row in same slice
            newRow();
          }
          for (const o of candidates) {
            const nextRowLen = Math.max(sliceDepthX, o.l);
            // Check width fit and length headroom
            if (rowWidthUsed + o.w <= W + EPS && cursorX + nextRowLen <= L + EPS) {
              chosen = o;
              break;
            }
          }
        }

        if (!chosen) {
          // No orientation could fit within remaining truck length -> stop packing this stop
          return { placedAll: false, sliceDepthX };
        }

        // number of units we can stack here vertically
        const stackCount = Math.min(it.perStackMax, remaining);

        // place the stack
        for (let h = 0; h < stackCount; h++) {
          placements.push({
            pkg_ID: it.pkg_ID,
            prod_ID: it.prod_ID,
            color: it.color,
            position: [r3(cursorX), r3(h * (it.H + LAYER_GAP)), r3(rowZ)],
            dimensions: [r3(chosen.l), r3(it.H), r3(chosen.w)]
          });
        }
        maxLayersUsed = Math.max(maxLayersUsed, stackCount);

        // advance row Z and update depth used by this stop-slice
        rowZ = r3(rowZ + chosen.w + Z_GUTTER);
        rowWidthUsed = rowZ; // since rowZ starts at 0, rowWidthUsed mirrors it (plus gutter)
        sliceDepthX = Math.max(sliceDepthX, chosen.l);

        remaining -= stackCount;
      }
    }

    return { placedAll: true, sliceDepthX };
  }

  for (const stop of stopsDesc) {
    const items = expandStopLines(stop);
    if (!items.length) continue;

    const { placedAll, sliceDepthX } = placeStopSlice(items);
    // advance X for next (earlier) stop
    cursorX = r3(cursorX + FRONT_GUTTER_X + sliceDepthX);

    // If we already ran out of length, we can't place further stops
    if (cursorX > L + EPS || !placedAll) break;
  }

  return {
    placements,
    total: placements.length,
    placed: placements.length,
    layersUsed: Math.max(1, maxLayersUsed)
  };
}

function generatePackageBlocks(boxPlacements) {
  return boxPlacements.map(b => ({
    pkg_ID: b.pkg_ID,
    prod_ID: b.prod_ID,
    color: b.color || '#999',
    position: b.position,
    dimensions: b.dimensions
  }));
}

/** legend with correct top-level color */
function buildProductLegend(loadArrangement, packageInfoDetails, colorByProdPkg) {
  const byProd = {};
  for (const stopEntry of loadArrangement) {
    const stop = stopEntry.stop;
    for (const pkg_ID of stopEntry.packages) {
      const p = packageInfoDetails.find(x => x.pkg_ID === pkg_ID);
      if (!p) continue;
      for (const l of (p.lines || [])) {
        if (!l?.prod_ID) continue;
        const key = `${l.prod_ID}|${pkg_ID}`;
        const lineColor = colorByProdPkg[key] || '#999';
        const rec = (byProd[l.prod_ID] ||= {
          prod_ID: l.prod_ID, color: lineColor, totalQty: 0, byPackage: {}, byStop: {}
        });
        if (rec.color === '#999' && lineColor !== '#999') rec.color = lineColor;

        const q = Number(l.quantity || 0);
        rec.totalQty += q;
        const prev = rec.byPackage[pkg_ID] || { qty: 0, color: lineColor };
        rec.byPackage[pkg_ID] = { qty: prev.qty + q, color: prev.color };
        rec.byStop[stop] = (rec.byStop[stop] || 0) + q;
      }
    }
  }
  return Object.values(byProd).map(r => ({
    prod_ID: r.prod_ID,
    color: r.color,
    totalQty: r.totalQty,
    byPackage: Object.entries(r.byPackage).map(([pack_ID, v]) => ({ pack_ID, qty: v.qty, color: v.color })),
    byStop: Object.entries(r.byStop).map(([stop, qty]) => ({ stop: Number(stop), qty })).sort((a, b) => a.stop - b.stop)
  }));
}

/** Build expected counts and compare with placements (sanity) */
function buildPlacementAudit(packagesData, allocationBoxPlacements, packageIDs) {
  const expect = new Map(); // key: pack|prod -> qty
  const wantPacks = new Set(packageIDs || packagesData.map(p => p.pack_ID));
  for (const pkg of packagesData) {
    if (!wantPacks.has(pkg.pack_ID)) continue;
    for (const line of (pkg.products || [])) {
      const k = `${pkg.pack_ID}|${line.prod_ID}`;
      expect.set(k, (expect.get(k) || 0) + Number(line.quantity || 0));
    }
  }
  const got = new Map();
  for (const b of allocationBoxPlacements || []) {
    const k = `${b.pkg_ID}|${b.prod_ID}`;
    got.set(k, (got.get(k) || 0) + 1);
  }
  const missing = [];
  const extra = [];
  for (const [k, q] of expect.entries()) {
    const g = got.get(k) || 0;
    if (g < q) {
      const [pack_ID, prod_ID] = k.split('|');
      missing.push({ pack_ID, prod_ID, expected: q, placed: g, delta: q - g });
    }
  }
  for (const [k, g] of got.entries()) {
    const q = expect.get(k) || 0;
    if (g > q) {
      const [pack_ID, prod_ID] = k.split('|');
      extra.push({ pack_ID, prod_ID, expected: q, placed: g, delta: g - q });
    }
  }
  return { missing, extra };
}

/* -------------------------- ROUTES --------------------------- */

// Create order (allocations) with optional traffic + weather
router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const { packages: packageIDs, filters } = req.body;
    if (!packageIDs?.length) return res.status(400).json({ error: 'No packages provided.' });

    const includeTraffic = !!filters?.includeTraffic;
    const departureTimeEpoch = Number(filters?.traffic?.departureTimeEpoch || 0);

    const includeWeather = (typeof filters?.includeWeather === 'boolean')
      ? !!filters.includeWeather
      : !!OPENWEATHER_API_KEY;

    const weatherOpts = {
      units: (filters?.weather?.units || WEATHER_UNITS_DEFAULT),
      sampleEveryKm: Number(filters?.weather?.sampleEveryKm || WEATHER_SAMPLE_EVERY_KM_DEFAULT),
      maxPoints: Number(filters?.weather?.maxPoints || WEATHER_MAX_POINTS_DEFAULT)
    };

    // 1) fetch packages & validate same origin/date
    const packagesData = await getPackagesByIds(packageIDs);
    const origin = packagesData[0].ship_from;
    const pickupDate = packagesData[0].pickup_date_time.split('T')[0];
    packagesData.forEach(p => {
      if (p.ship_from !== origin) throw new Error('All packages must share ship_from');
      if (p.pickup_date_time.split('T')[0] !== pickupDate)
        throw new Error('All packages must share pickup date');
    });

    // 2) products
    const allLines = packagesData.flatMap(p => p.products || []);
    const prodIDs = [...new Set(allLines.map(l => l.prod_ID))];
    if (!prodIDs.length)
      return res.status(400).json({ error: 'No product lines in packages' });

    const [prodRows] = await db.query(
      `SELECT product_ID, weight, weight_uom, volume, volume_uom,
       fragile_goods, dangerous_goods, hazardous, temp_controlled,
       packaging_type, stacking_factor
       FROM master_products
       WHERE product_ID IN (?)`,
      [prodIDs]
    );
    const productMap = prodRows.reduce((m, r) => (m[r.product_ID] = r, m), {});

    // 3) packaging info (STRICTLY from master_products.packaging_type)
    const allPacIDs = collectAllPacIDs(packagesData, productMap);
    const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

    // tallest package height from product packaging_type (fallback to derived cube if needed)
    const heights = allLines.map(l => {
      const prod = productMap[l.prod_ID];
      const pacIds = resolvePacIdsFromProduct(prod);
      const info = pacIds[0] ? packagingInfoMap[pacIds[0]] : null;
      if (info) return parseDimension(`${info.pack_height} ${info.dimensions_uom}`);
      // derived cube from product volume
      const vol = parseVolumeAndUOM(prod.volume, prod.volume_uom);
      const cube = deriveDimsFromVolumeM3(vol);
      return cube?.heightM || 0;
    }).filter(Boolean);
    const maxPkgH = heights.length ? Math.max(...heights) : 0;

    // global stacking factor cap (from master_products.stacking_factor)
    const sfCaps = allLines.map(l => {
      const raw = productMap[l.prod_ID]?.stacking_factor;
      if (raw === null || raw === undefined || raw === '') return 1;
      const n = Number(raw);
      return (isNaN(n) || n <= 1) ? 1 : n;
    });
    const globalSfCap = sfCaps.length ? Math.max(...sfCaps) : 1;

    // 4) vehicles near origin
    const [dbVehicles] = await db.query(
      `SELECT * FROM master_resources WHERE JSON_CONTAINS(loc_ID, ?)`,
      [JSON.stringify(origin)]
    );

    let fleet = dbVehicles.map(v => {
      const caps = safeJsonParse(v.capacity, {});
      const W = parseDimension(caps.interior_width);
      const L = parseDimension(caps.interior_length);
      const H = parseDimension(caps.interior_height);

      const rawVolDims = (W && L && H) ? (W * L * H) : parseVolumeAndUOM(caps.cubic_capacity, caps.cubic_capacity_unit);
      const rawM3 = rawVolDims || 0;

      const maxLayersByHeight = (maxPkgH > 0 && H > 0) ? Math.max(1, Math.floor(H / maxPkgH)) : 1;
      const truckAllowedLayers = Math.min(maxLayersByHeight, globalSfCap);
      const oneLayerM3 = (maxPkgH > 0 && W > 0 && L > 0) ? (W * L * maxPkgH) : 0;
      const usableVol = oneLayerM3 * truckAllowedLayers;

      const weightCapKg = parseWeightAndUOM(caps.payload_weight, caps.payload_weight_unit);

      return {
        ...v,
        transportation_details: safeJsonParse(v.transportation_details, {}),
        downtimes: safeJsonParse(v.downtimes, {}),
        capacity: caps,
        weightCapKg,
        totalWeightCapacity: weightCapKg,
        totalVolumeCapacity: rawM3,
        volumeCapM3: rawM3,
        oneLayerM3,
        usableVol,
        maxLayersByHeight,
        maxLayers: maxLayersByHeight,
        allowedLayers: truckAllowedLayers,
        cost_per_ton: +safeJsonParse(v.additional_details, {}).cost_per_ton || 0
      };
    });

    // 5) filters/sorts
    if (filters?.checkValidity) fleet = fleet.filter(isVehicleValid);
    if (filters?.checkDowntime) fleet = fleet.filter(v => !isVehicleDown(v));
    if (filters?.sortUnlimitedUsage) fleet.sort((a, b) => (a.unlimited_usage || 0) - (b.unlimited_usage || 0));
    if (filters?.sortOwnership) fleet.sort((a, b) => (a.individual_resource || '').localeCompare(b.individual_resource || ''));
    fleet.sort((a, b) => a.cost_per_ton - b.cost_per_ton);

    // 6) origin coords
    const sourceLoc = await getLocationById(origin);

    // 7) allocate (with toggles)
    const { allocations, totalCost, unallocated } = await allocatePackages(
      packagesData,
      fleet,
      sourceLoc,
      productMap,
      packagingInfoMap,
      {
        includeTraffic,
        departureTimeEpoch,
        weatherOpts
      }
    );

    // 8) enrich for FE (3D packing etc.)
    const enriched = await Promise.all(allocations.map(async a => {
      const v = fleet.find(x => x.vehicle_ID === a.vehicle_ID) || {};
      const caps = v.capacity || {};

      const widthM = parseDimension(caps.interior_width);
      const lengthM = parseDimension(caps.interior_length);
      const heightM = parseDimension(caps.interior_height);

      const packageInfoDetails = a.packages.map(pkgID => {
        const pkgRecord = packagesData.find(p => p.pack_ID === pkgID);
        const lines = (pkgRecord?.products || []).map(line => {
          const prod = productMap[line.prod_ID];

          // CHOOSE PAC STRICTLY FROM master_products.packaging_type
          const prodPacList = resolvePacIdsFromProduct(prod);
          const chosenPac = prodPacList.find(pac => packagingInfoMap[pac]) || prodPacList[0] || null;
          const packInfo = chosenPac ? packagingInfoMap[chosenPac] : null;

          const sfRaw = prod?.stacking_factor;
          const stacking_factor = (sfRaw === '' ? null : sfRaw);
          const sfNum = Number(stacking_factor);
          const sfCap = (!sfNum || isNaN(sfNum) || sfNum <= 1) ? 1 : sfNum;

          let dims = null;
          if (packInfo) {
            dims = {
              lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
              widthM:  parseDimension(`${packInfo.pack_width}  ${packInfo.dimensions_uom}`),
              heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
            };
          } else {
            // fallback from product volume (cube) — prevents skipping
            const vol = parseVolumeAndUOM(prod.volume, prod.volume_uom);
            const derived = deriveDimsFromVolumeM3(vol);
            if (derived) dims = derived;
          }

          let allowedLayers = 1;
          if (dims?.heightM && heightM) {
            const heightCap = Math.max(1, Math.floor(heightM / dims.heightM));
            allowedLayers = Math.min(heightCap, sfCap);
          }

          return {
            prod_ID: line.prod_ID,
            quantity: line.quantity,
            pac_ID: chosenPac,
            stacking_factor,
            sfCap,
            package_info: packInfo,
            packagingDimensions: dims,
            allowedLayers
          };
        });

        return { pkg_ID: pkgID, lines };
      });

      // layer caps summary
      const perLineLayers = [];
      packageInfoDetails.forEach(p => {
        (p.lines || []).forEach(l => {
          if (l.packagingDimensions) {
            perLineLayers.push({
              prod_ID: l.prod_ID,
              pac_ID: l.pac_ID,
              allowedLayers: l.allowedLayers
            });
          }
        });
      });

      const occupied = a.occupiedVolume;
      const rawM3 = v.totalVolumeCapacity || 0;
      const usableM3 = v.usableVol || rawM3;

      const occupiedPercentRaw    = rawM3    ? +((occupied / rawM3)    * 100).toFixed(2) : 0;
      const occupiedPercentUsable = usableM3 ? +((occupied / usableM3) * 100).toFixed(2) : 0;

      const packageDetails = a.packages.map((pkg_ID, idx) => {
        const vol = (a.pkgVolumes && a.pkgVolumes[idx]) || 0;
        const percentOfTruckRaw    = rawM3    ? +(vol / rawM3    * 100).toFixed(2) : 0;
        const percentOfUsableRules = usableM3 ? +(vol / usableM3 * 100).toFixed(2) : 0;
        return {
          pkg_ID,
          volumeM3: vol,
          percentOfTruck: percentOfTruckRaw,
          percentOfUsable: percentOfUsableRules
        };
      });

      // one true color map, order-independent
      const colorByProdPkg = buildColorMapByProdPkg(packageInfoDetails);
      const tallestH = getMaxBoxHeight(packageInfoDetails);

      const { placements: rawPlacements, layersUsed } = computeBoxPlacements(
        a.loadArrangement,
        packageInfoDetails,
        { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
        {
          maxLayers: Math.max(1, v.allowedLayers || 1),
          zGutter: 0.0,
          frontGutter: 0.0,
          layerGap: 0.02,
          layerHeight: tallestH,
          // pass the shared color map so legend == 3D
          colorByProdPkg
        }
      );

      const boxPlacements = generatePackageBlocks(rawPlacements);
      const productLegend = buildProductLegend(a.loadArrangement, packageInfoDetails, colorByProdPkg);

      // audit: verify no missing items in placements
      const placementAudit = buildPlacementAudit(
        packagesData.filter(p => a.packages.includes(p.pack_ID)),
        boxPlacements,
        a.packages
      );

      // Attach weather if requested
      let weatherAlongRoute = undefined;
      let weatherSummary = undefined;
      if (includeWeather) {
        if (!OPENWEATHER_API_KEY) {
          logger.warn('OPENWEATHER_API_KEY missing: skipping weather');
        } else if (a.sampledRoutePoints?.length) {
          const normalized = a.sampledRoutePoints.map(normalizePoint);
          const { pointsWeather, summary } = await getWeatherAlongRoute(
            normalized,
            { units: weatherOpts.units, maxPoints: weatherOpts.maxPoints }
          );
          weatherAlongRoute = pointsWeather;
          weatherSummary = summary;
        } else {
          weatherAlongRoute = [];
          weatherSummary = { minTemp: null, maxTemp: null, distinctConditions: [], points: 0 };
        }
      }

      let trafficSummary = a.trafficSummary || null;
      if (includeTraffic && !trafficSummary && Array.isArray(a.route)) {
        const delays = a.route.map(l => +l.trafficDelaySec || 0);
        const totalDelaySec = delays.reduce((s, n) => s + n, 0);
        const avgDelay = a.route.length ? Math.round(totalDelaySec / a.route.length) : 0;
        const congestion = totalDelaySec > 3600 ? 'high' : totalDelaySec > 900 ? 'medium' : 'low';
        trafficSummary = {
          trafficAt: normalizeDeparture(departureTimeEpoch),
          totalDelaySec,
          avgDelayPerLegSec: avgDelay,
          congestion
        };
      }

      return {
        ...a,
        boxPlacements,
        placementAudit,
        vehicleDimensions: { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
        packageInfoDetails,

        occupiedPercent: occupiedPercentRaw,
        occupiedPercentRaw,
        occupiedPercentUsable,

        packageDetails,
        productLegend,
        truckCapacity: {
          rawM3: v.totalVolumeCapacity,
          oneLayerM3: v.oneLayerM3,
          usableM3: v.usableVol,
          maxLayersByHeight: v.maxLayersByHeight,
          allowedLayers: v.allowedLayers,
          allowedByHeight: v.maxLayersByHeight,
          allowedBySF: globalSfCap,
          layersUsed,
          perLineLayers
        },

        weatherAlongRoute,
        weatherSummary,
        trafficSummary
      };
    }));

    // metrics + event
    const ms = Date.now() - t0;
    await logApiPerf('/create-order', ms, true);
    await logSolverPerf(packagesData.length, fleet.length, ms, totalCost);
    try { await emit('plan.optimized', { totalCost, allocations: enriched, at: Date.now() }); } catch {}

    return res.status(200).json({
      message: enriched.length ? 'Best Combinational Scenario' : 'No suitable vehicles found',
      totalCost: enriched.length ? totalCost : null,
      allocations: enriched,
      unallocatedPackages: unallocated
    });

  } catch (err) {
    const ms = Date.now() - t0;
    try { await logApiPerf('/create-order', ms, false); } catch {}
    logger.error('Error creating order:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ---- Sample route ---- */
async function getPackagesByIds(packageIDs) {
  const ph = packageIDs.map(_ => '?').join(',');
  const [rows] = await db.query(`
    SELECT * FROM packages WHERE pack_ID IN (${ph})`, packageIDs);
  if (!rows.length) throw new Error('No matching packages');
  return rows.map(r => ({
    pack_ID: r.pack_ID,
    ship_from: r.ship_from,
    ship_to: r.ship_to,
    products: safeJsonParse(r.product_ID),
    pickup_date_time: r.pickup_date_time
  }));
}

router.post('/sample-route', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const { locations } = req.body;
    if (!Array.isArray(locations) || locations.length < 2) {
      return res.status(400).json({ error: 'Provide at least origin and destination.' });
    }

    const shipments = new Array(Math.max(0, locations.length - 1)).fill(0);
    const { sampledCoords } = await getOptimizedRouteWithLoad(locations, shipments);

    res.status(200).json({ sampledRoutePoints: sampledCoords });

    noBlock(logApiPerf('/sample-route', Date.now() - t0, true), 'logApiPerf(/sample-route)');
    noBlock(emit('route.sampled', { points: sampledCoords, at: Date.now() }), 'emit(route.sampled)');
  } catch (err) {
    res.status(500).json({ error: err.message });
    noBlock(logApiPerf('/sample-route', Date.now() - t0, false), 'logApiPerf(/sample-route)');
    logger.error('Error sampling route:', err);
  }
});

/* ---------------- helper endpoints ---------------- */

// Traffic: returns legs + summary (Google only)
router.post('/route/traffic', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const { locations, departureTimeEpoch = 0 } = req.body || {};
    if (!Array.isArray(locations) || locations.length < 2) {
      return res.status(400).json({ error: 'Provide at least origin and destination.' });
    }
    if (cfg.routingProvider !== 'google') {
      return res.status(400).json({ error: 'Traffic is supported only when ROUTING_PROVIDER=google' });
    }
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: 'Google API key missing' });
    }

    const depBucket = departureBucket(departureTimeEpoch);
    const keyLocs = dedupeConsecutiveLocations(locations);
    const cacheKey = `traffic:${cfg.routingProvider}:${depBucket}:${buildRouteKey(keyLocs)}`;

    const cached = await getJSON(cacheKey);
    if (cached) {
      res.status(200).json(cached);
      noBlock(logApiPerf('/route/traffic', Date.now() - t0, true), 'logApiPerf(/route/traffic)');
      return;
    }

    const { legs, trafficSummary } = await fetchRouteGoogle(keyLocs, {
      includeTraffic: true,
      departureTimeEpoch
    });

    const payload = { provider: 'google', legs, summary: trafficSummary };

    res.status(200).json(payload);

    noBlock(setJSON(cacheKey, payload, TRAFFIC_CACHE_TTL), 'traffic cache set');
    noBlock(logApiPerf('/route/traffic', Date.now() - t0, true), 'logApiPerf(/route/traffic)');
    noBlock(emit('route.traffic', { legs, summary: trafficSummary, at: Date.now() }), 'emit(route.traffic)');
  } catch (err) {
    res.status(500).json({ error: err.message });
    noBlock(logApiPerf('/route/traffic', Date.now() - t0, false), 'logApiPerf(/route/traffic)');
    logger.error('Error on /route/traffic:', err);
  }
});

// Weather: accepts points[] or locations[] and samples along polyline
router.post('/route/weather', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    if (!OPENWEATHER_API_KEY) {
      return res.status(500).json({ error: 'OPENWEATHER_API_KEY missing' });
    }
    const { points, locations, units = WEATHER_UNITS_DEFAULT, sampleEveryKm = WEATHER_SAMPLE_EVERY_KM_DEFAULT, maxPoints = WEATHER_MAX_POINTS_DEFAULT } = req.body || {};

    let usePoints = Array.isArray(points) ? points : null;
    if ((!usePoints || !usePoints.length) && Array.isArray(locations) && locations.length >= 2) {
      const shipments = new Array(Math.max(0, locations.length - 1)).fill(0);
      const { sampledCoords } = await getOptimizedRouteWithLoad(locations, shipments, {
        sampleEveryKm,
        maxSamplePoints: maxPoints
      });
      usePoints = sampledCoords;
    }

    if (!usePoints || !usePoints.length) {
      return res.status(400).json({ error: 'Provide points[] or locations[] (>=2)' });
    }

    const normalized = usePoints.map(normalizePoint);

    const { pointsWeather, summary } = await getWeatherAlongRoute(normalized, { units, maxPoints });

    const payload = { units, pointsWeather, summary };
    res.status(200).json(payload);

    noBlock(logApiPerf('/route/weather', Date.now() - t0, true), 'logApiPerf(/route/weather)');
    noBlock(emit('route.weather', { count: pointsWeather.length, at: Date.now() }), 'emit(route.weather)');
  } catch (err) {
    res.status(500).json({ error: err.message });
    noBlock(logApiPerf('/route/weather', Date.now() - t0, false), 'logApiPerf(/route/weather)');
    logger.error('Error on /route/weather:', err);
  }
});

module.exports = router;
