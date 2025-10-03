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

// /** color map keyed by "prod|pkg" so legend colors match placements */
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

// /** tallest pack height helper (kept — sometimes used for UI summaries) */
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

// /** (legacy helper not used by new algorithm — safe to keep) */
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

// /* ====== NEW: guaranteed-dimensions fallback (never drop a line) ====== */
// function deriveDimsFromFallback(prodRow, truckHeightM) {
//   // Try product.volume first
//   const volM3 = parseVolumeAndUOM(prodRow?.volume, prodRow?.volume_uom) || 0;
//   if (volM3 > 0) {
//     const H = Math.min(Math.max(0.2, Math.cbrt(volM3)), Math.max(0.2, truckHeightM || 0.6));
//     const base = Math.sqrt(Math.max(volM3 / H, 0.04)); // >= 0.2m x 0.2m
//     return { lengthM: r3(base), widthM: r3(base), heightM: r3(H) };
//   }
//   // Last resort tiny placeholder – so the box/color still appears
//   return { lengthM: 0.25, widthM: 0.25, heightM: Math.min(0.25, Math.max(0.2, truckHeightM || 0.6)) };
// }

// /* ========= stop-wise, vertical-first stacking algorithm =========
//    Axes assumption (consistent with your renderer):
//      X → along truck length (tailgate → cab)
//      Y → vertical (stacking)
//      Z → across truck width
//    FILO: last stop placed first at small X. */
// function computeBoxPlacements(loadArrangement, packageInfoDetails, vehicleDimensions, opts = {}) {
//   const truck = {
//     interiorWidthM: Number(vehicleDimensions?.interiorWidthM || 0),
//     interiorLengthM: Number(vehicleDimensions?.interiorLengthM || 0),
//     interiorHeightM: Number(vehicleDimensions?.interiorHeightM || 0)
//   };
//   const Z_GUTTER = Number(opts.zGutter ?? 0.0);
//   const FRONT_GUTTER_X = Number(opts.frontGutter ?? 0.0);
//   const LAYER_GAP = Number(opts.layerGap ?? 0.02);
//   const EPS = 1e-9;

//   // Global layer cap from vehicle (already derived from height & SF earlier)
//   const allowedGlobalLayers = Math.max(1, Number(opts.maxLayers || 1));

//   const colorByKey = buildColorMapByProdPkg(packageInfoDetails);
//   const pkgMap = new Map(packageInfoDetails.map(p => [p.pkg_ID, p]));

//   // FILO: place highest stop number first (goes deepest at small X)
//   const stopsDesc = [...loadArrangement].sort((a, b) => b.stop - a.stop);

//   const colorFor = (prod_ID, pkg_ID) => colorByKey[`${prod_ID}|${pkg_ID}`] || '#999';

//   function expandStopLines(stop) {
//     const items = [];
//     for (const pkgId of (stop.packages || [])) {
//       const pkg = pkgMap.get(pkgId);
//       if (!pkg) continue;
//       for (const line of (pkg.lines || [])) {
//         const dims = line.packagingDimensions || {};
//         const L = +dims.lengthM || 0;
//         const W = +dims.widthM || 0;
//         const H = +dims.heightM || 0;
//         const qty = Number(line.quantity || 0);
//         if (!(L > 0 && W > 0 && H > 0) || qty <= 0) continue;

//         // per-line layer cap: min(vehicle global cap, height cap, stacking factor cap)
//         const heightCap = (truck.interiorHeightM > 0 && H > 0)
//           ? Math.max(1, Math.floor(truck.interiorHeightM / H))
//           : 1;
//         const lineSfCap = Math.max(1, Number(line.sfCap || line.stacking_factor || line.allowedLayers || 1));
//         const perLineCap = Math.max(1, Math.min(heightCap, lineSfCap, allowedGlobalLayers));

//         items.push({
//           pkg_ID: pkgId,
//           prod_ID: line.prod_ID,
//           qty,
//           L, W, H,
//           maxLayers: perLineCap,
//           color: colorFor(line.prod_ID, pkgId)
//         });
//       }
//     }
//     // Sort: bigger footprint first to avoid slivers; tie by height then prod
//     items.sort((a, b) => {
//       const va = a.L * a.W * a.H;
//       const vb = b.L * b.W * b.H;
//       if (vb !== va) return vb - va;
//       if (b.H !== a.H) return b.H - a.H;
//       return String(a.prod_ID).localeCompare(String(b.prod_ID));
//     });
//     return items;
//   }

//   const placements = [];
//   let globalLayersUsed = 0;

//   // Truck cursors
//   const Wmax = truck.interiorWidthM;
//   const Lmax = truck.interiorLengthM;

//   let cursorX = FRONT_GUTTER_X; // along length
//   let cursorZ = 0;              // across width
//   let sliceDepth = 0;           // deepest L used in current Z-row

//   function advanceToNextSlice() {
//     cursorZ = 0;
//     cursorX = Math.min(Lmax, r3(cursorX + sliceDepth + FRONT_GUTTER_X));
//     sliceDepth = 0;
//   }

//   // Iterate stops (FILO)
//   for (const stop of stopsDesc) {
//     const items = expandStopLines(stop);
//     if (!items.length) {
//       advanceToNextSlice(); // keep bays separate per stop
//       continue;
//     }

//     for (const it of items) {
//       let remaining = it.qty;

//       while (remaining > 0) {
//         // remaining row width
//         const remWidth = Wmax - cursorZ;

//         // try floor-plane rotation if it helps
//         let placeL = it.L, placeW = it.W;
//         if (placeW > remWidth + EPS && placeL <= remWidth + EPS && placeL <= Wmax + EPS) {
//           const tmp = placeL; placeL = it.W; placeW = it.L;
//         }

//         // width wrap after rotation attempt
//         if (cursorZ + placeW > Wmax + EPS) {
//           advanceToNextSlice();
//         }
//         // length overflow => stop placing further items
//         if (cursorX + placeL > Lmax + EPS) {
//           remaining = 0;
//           break;
//         }

//         // Build one vertical stack at this floor slot
//         const layersHere = Math.min(it.maxLayers, remaining);
//         for (let h = 0; h < layersHere; h++) {
//           placements.push({
//             pkg_ID: it.pkg_ID,
//             prod_ID: it.prod_ID,
//             color: it.color,
//             position: [r3(cursorX), r3(h * (it.H + LAYER_GAP)), r3(cursorZ)],
//             dimensions: [r3(placeL), r3(it.H), r3(placeW)]
//           });
//         }
//         globalLayersUsed = Math.max(globalLayersUsed, layersHere);
//         remaining -= layersHere;

//         // Update row bookkeeping
//         sliceDepth = Math.max(sliceDepth, placeL);
//         cursorZ = r3(cursorZ + placeW + Z_GUTTER);
//       }
//     }

//     // After finishing a stop, start a fresh X slice so stops don't interleave
//     advanceToNextSlice();
//     if (cursorX >= Lmax - 1e-9) break; // truck full in length
//   }

//   return {
//     placements,
//     total: placements.length,
//     placed: placements.length,
//     layersUsed: Math.max(1, globalLayersUsed)
//   };
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

//       const packageInfoDetails = a.packages.map((pkgID) => {
//         const pkgRecord = packagesData.find(p => p.pack_ID === pkgID);

//         const lines = (pkgRecord?.products || []).map(line => {
//           const prod = productMap[line.prod_ID];
//           const pacIds = resolvePacIdsFromProduct(prod);
//           const firstPac = pacIds[0] || null;
//           const packInfo = firstPac ? packagingInfoMap[firstPac] : null;

//           let dims;
//           if (packInfo && packInfo.pack_length && packInfo.pack_width && packInfo.pack_height) {
//             dims = {
//               lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
//               widthM:  parseDimension(`${packInfo.pack_width}  ${packInfo.dimensions_uom}`),
//               heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
//             };
//           } else {
//             // ✅ guaranteed – never drop the line
//             dims = deriveDimsFromFallback(prod, heightM);
//             logger.warn('Using fallback dims for product line', { prod_ID: line.prod_ID, pack_ID: pkgRecord?.pack_ID });
//           }

//           const sfRaw = prod?.stacking_factor;
//           const stacking_factor = (sfRaw === '' ? null : sfRaw);
//           const sfNum = Number(stacking_factor);
//           const sfCap = (!sfNum || isNaN(sfNum) || sfNum <= 1) ? 1 : sfNum;

//           let allowedLayers = 1;
//           if (dims?.heightM && heightM) {
//             const heightCap = Math.max(1, Math.floor(heightM / dims.heightM));
//             allowedLayers = Math.min(heightCap, Math.max(1, v.allowedLayers || 1), sfCap);
//           }

//           return {
//             prod_ID: line.prod_ID,
//             quantity: line.quantity,
//             pac_ID: firstPac,
//             stacking_factor,
//             sfCap,
//             package_info: packInfo,
//             packagingDimensions: dims, // ✅ always present
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
//           maxLayers: Math.max(1, v.allowedLayers || 1), // global per-truck cap
//           zGutter: 0.0,
//           frontGutter: 0.0,
//           layerGap: 0.02,
//           layerHeight: tallestH
//         }
//       );

//       const boxPlacements = generatePackageBlocks(rawPlacements);

//       // ✅ sanity: input vs output count
//       const expectedCount = packageInfoDetails.reduce((s,p)=>
//         s + (p.lines||[]).reduce((ss,l)=> ss + Number(l.quantity||0), 0), 0
//       );
//       const actualCount = boxPlacements.length;
//       if (expectedCount !== actualCount) {
//         logger.warn('Box placement count mismatch', {
//           vehicle_ID: v.vehicle_ID,
//           expected: expectedCount,
//           actual: actualCount,
//           stops: a.loadArrangement?.length || 0
//         });
//       }

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
function parseDistanceText(txt) {
  return parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
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
// hardened: validate numbers so toFixed never gets undefined
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

  // NOTE: OpenWeather expects "lon", not "lng"
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
      // p is already normalized to {lat,lng} by callers that accept mixed shapes
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
  // ensure no consecutive dupes to avoid zero-length legs
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

  // request traffic metrics when asked
  if (includeTraffic) {
    const dep = normalizeDeparture(departureTimeEpoch);
    params.push('region=IN'); // helps with routing in India; harmless elsewhere
    params.push('departure_time=' + dep);
    params.push('traffic_model=best_guess'); // requires "departure_time" for duration_in_traffic
  }

  const url = `https://maps.googleapis.com/maps/api/directions/json?${params.filter(Boolean).join('&')}`;
  const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
  const data = resp?.data || {};
  if (data.status !== 'OK') {
    const err = new Error(`Google error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
    // log diagnostics
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

  // warn if traffic requested but missing (can happen on tiny/zero legs; we de-dupe to reduce this)
  if (includeTraffic && legs.some(l => l?.duration_in_traffic?.value == null)) {
    logger.warn('Google: duration_in_traffic missing for some legs', {
      legCount: legs.length
    });
  }

  // route-level traffic summary if requested
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
  // de-dupe to keep parity with Google path
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

  // NEW: de-dupe consecutive identical coords to avoid zero legs
  locations = dedupeConsecutiveLocations(locations);

  // cache key includes provider + traffic toggle + DEPARTURE BUCKET + coordinates
  // also include sampling params only for fallback; we'll resample if 'shape' is cached.
  const depBucket = includeTraffic ? departureBucket(departureTimeEpoch) : 0;
  const cacheKey = `route:${cfg.routingProvider}:${includeTraffic ? 'T' : 'N'}:${depBucket}:${buildRouteKey(locations)}:${sampleEveryKm}:${maxSamplePoints}`;
  const cached = await getJSON(cacheKey);
  let optimizedRoute, sampledCoords, trafficSummary, shape;

  if (cached) {
    // Backward compatibility if old cache had no 'shape'
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

    // Build optimizedRoute while computing cumulative load
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

    // Store 'shape' so future callers can resample differently
    await setJSON(cacheKey, { optimizedRoute, shape, trafficSummary }, cfg.redisTTL);
  }

  // Recompute loadAfterStop for the caller's shipments (in case cache came from different loads)
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
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
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

/* ---------- packaging helpers (ONLY from master_products) --------- */
function resolvePacIdsFromProduct(prodRow) {
  if (!prodRow) return [];
  let pt = prodRow.packaging_type;
  if (typeof pt === 'string') {
    try { pt = JSON.parse(pt); } catch { pt = null; }
  }
  if (!Array.isArray(pt)) return [];
  return pt.filter(x => x && x.pac_ID).map(x => x.pac_ID);
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
    for (const line of pkg.products) {
      const pacIds = resolvePacIdsFromProduct(productMap[line.prod_ID]);
      pacIds.forEach(id => ids.add(id));
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
    if (pacIds.length) {
      const info = pkgInfoMap[pacIds[0]];
      if (info) totalV += parseVolumeAndUOM(info.pack_volume, info.pack_volume_uom) * line.quantity;
    }
  }
  return { totalW, totalV };
}

/* --------------- NEW: floor-fit feasibility helpers --------------- */
function parseDimension(str = '') {
  if (typeof str === 'number') return +str || 0;
  const m = String(str).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  return /cm/i.test(str) ? val / 100 : val;
}
function r3(n) { return Math.round(n * 1000) / 1000; }

function parseTruckDims(cap) {
  const W = parseDimension(cap?.interior_width);
  const L = parseDimension(cap?.interior_length);
  const H = parseDimension(cap?.interior_height);
  return { widthM: W || 0, lengthM: L || 0, heightM: H || 0 };
}
function sfCapFromProduct(prodRow) {
  const raw = prodRow?.stacking_factor;
  const n = Number(raw);
  if (!isFinite(n) || n <= 1) return 1;
  return n;
}
function pickFirstPackInfo(prodRow, packagingInfoMap) {
  const pacIds = resolvePacIdsFromProduct(prodRow);
  const firstPac = pacIds[0] || null;
  return firstPac ? packagingInfoMap[firstPac] : null;
}
function lineDimsForVehicle(prodRow, packInfo, truckHeightM) {
  if (packInfo && packInfo.pack_length && packInfo.pack_width && packInfo.pack_height) {
    return {
      L: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
      W: parseDimension(`${packInfo.pack_width} ${packInfo.dimensions_uom}`),
      H: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
    };
  }
  // fallback via product volume or tiny placeholder
  const volM3 = parseVolumeAndUOM(prodRow?.volume, prodRow?.volume_uom) || 0;
  if (volM3 > 0) {
    const H = Math.min(Math.max(0.2, Math.cbrt(volM3)), Math.max(0.2, truckHeightM || 0.6));
    const base = Math.sqrt(Math.max(volM3 / H, 0.04)); // >= 0.2m^2 base
    return { L: r3(base), W: r3(base), H: r3(H) };
  }
  return { L: 0.25, W: 0.25, H: Math.min(0.25, Math.max(0.2, truckHeightM || 0.6)) };
}
function allowedLayersFor(truckH, boxH, prodSf) {
  const byHeight = (truckH > 0 && boxH > 0) ? Math.max(1, Math.floor(truckH / boxH)) : 1;
  return Math.max(1, Math.min(byHeight, prodSf || 1));
}

/**
 * Compute required length along X for a *single package/stop* on the truck floor,
 * respecting per-line layer caps and rotation to fit truck width.
 */
function requiredLengthForPackageStop(pkgRecord, productMap, packagingInfoMap, truckDims, fudge = 1.08) {
  const Wmax = truckDims.widthM, Lmax = truckDims.lengthM, Htruck = truckDims.heightM;
  let area = 0;       // sum of footprint areas across required stacks
  let maxPlaceL = 0;  // the longest single piece along length (after width-constrained rotation)

  for (const line of (pkgRecord.products || [])) {
    const prod = productMap[line.prod_ID];
    if (!prod) continue;

    const packInfo = pickFirstPackInfo(prod, packagingInfoMap);
    const dims = lineDimsForVehicle(prod, packInfo, Htruck);
    const sfCap = sfCapFromProduct(prod);
    const perLineLayers = allowedLayersFor(Htruck, dims.H, sfCap);
    const stacks = Math.ceil((Number(line.quantity) || 0) / perLineLayers);

    // choose an orientation that fits truck width
    let placeW, placeL;
    if (Math.min(dims.W, dims.L) > Wmax + 1e-9) {
      return { ok: false, lengthM: Infinity }; // cannot fit across width in any rotation
    }
    if (dims.W <= Wmax && dims.L <= Wmax) {
      // pick the orientation that MINIMIZES length usage (width = larger side)
      if (dims.W >= dims.L) {
        placeW = dims.W; placeL = dims.L;
      } else {
        placeW = dims.L; placeL = dims.W;
      }
    } else if (dims.W <= Wmax) {
      placeW = dims.W; placeL = dims.L;
    } else {
      placeW = dims.L; placeL = dims.W;
    }

    if (placeL > Lmax + 1e-9) {
      return { ok: false, lengthM: Infinity }; // too long even in best rotation
    }

    area += stacks * (placeW * placeL);
    maxPlaceL = Math.max(maxPlaceL, placeL);
  }

  const lengthByArea = area > 0 && Wmax > 0 ? (area / Wmax) : 0;
  const requiredLength = Math.max(maxPlaceL, lengthByArea * fudge);
  return { ok: true, lengthM: requiredLength };
}

/**
 * Stop-wise feasibility: sum required length per stop (each package is a stop),
 * ensure total required length <= truck length, and each line can be placed.
 */
function canFitGroupOnVehicleFloor(groupPkgIDs, packagesById, productMap, packagingInfoMap, vehicle) {
  const { widthM, lengthM, heightM } = parseTruckDims(vehicle.capacity || {});
  if (!(widthM > 0 && lengthM > 0 && heightM > 0)) return false;

  let totalLen = 0;
  for (const pkg_ID of groupPkgIDs) {
    const pkgRecord = packagesById[pkg_ID];
    const { ok, lengthM: need } = requiredLengthForPackageStop(pkgRecord, productMap, packagingInfoMap, { widthM, lengthM, heightM });
    if (!ok) return false;
    totalLen += need;
    if (totalLen > lengthM + 1e-9) return false; // early exit
  }
  return true;
}

/* ---------------- backtracking cost solver ---------------- */
async function findMinCostArrangement(cluster, vehicles, sourceLoc, {
  packagesById, productMap, packagingInfoMap
}) {
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
        // Floor-fit feasibility for this subset + vehicle
        const ids = chosen.map(x => x.pack_ID);
        if (ids.length &&
            sumW <= v.weightCapKg &&
            checkPackageVehicleCompatibility(flags, getVehicleSpecialFlags(v)) &&
            canFitGroupOnVehicleFloor(ids, packagesById, productMap, packagingInfoMap, v)) {
          subsets.push({ chosen, sumW, sumV, flags });
        }
        return;
      }
      // branch: skip current
      buildSub(idx + 1, chosen, sumW, sumV, flags);

      // branch: include current if not immediately overweight (volume is not the gating factor anymore)
      const pkg = rem[idx];
      const newW = sumW + pkg.totalWeight;
      // pessimistic early prune by weight only; real floor-fit checked at leaf
      if (newW <= v.weightCapKg) {
        const nf = { ...flags };
        nf.fragile ||= pkg.specialFlags.fragile;
        nf.dangerous ||= pkg.specialFlags.dangerous;
        nf.hazardous ||= pkg.specialFlags.hazardous;
        nf.tempCtrl ||= pkg.specialFlags.tempCtrl;
        buildSub(idx + 1, [...chosen, pkg], newW, sumV + pkg.totalVolume, nf);
      }
    }

    buildSub(0, [], 0, 0, { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 });

    for (const { chosen, sumW } of subsets) {
      if (!chosen.length) continue;

      chosen.sort((a, b) => a.distFromSource - b.distFromSource);
      const locs = [sourceLoc, ...chosen.map(x => x.destination)];
      const shipments = new Array(chosen.length).fill(1);

      // traffic off in solver recursion for speed/cost
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

  // map for fast access in floor feasibility checks
  const packagesById = packagesData.reduce((m, p) => (m[p.pack_ID] = p, m), {});

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

    // NEW: strict feasibility — weight + special flags + FLOOR FIT (stop-wise)
    let feasible = vehicles.filter(v =>
      v.weightCapKg >= sumW &&
      checkPackageVehicleCompatibility(combinedFlags, getVehicleSpecialFlags(v)) &&
      canFitGroupOnVehicleFloor(group.map(g => g.pack_ID), packagesById, productMap, packagingInfoMap, v)
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
      // Split across vehicles with the same stricter floor-fit constraint
      const { cost, allocations: subAllocs, unallocated } =
        await findMinCostArrangement(group, vehicles, sourceLocation, {
          packagesById, productMap, packagingInfoMap
        });
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
/** color map keyed by "prod|pkg" so legend colors match placements */
function buildColorMapByProdPkg(packageInfoDetails) {
  const palette = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#0ea5e9', '#6366f1', '#22c55e'];
  const colorByKey = {};
  let i = 0;
  for (const p of packageInfoDetails) {
    const pkg_ID = p.pkg_ID;
    for (const l of (p.lines || [])) {
      if (!l?.prod_ID) continue;
      const key = `${l.prod_ID}|${pkg_ID}`;
      if (!colorByKey[key]) colorByKey[key] = palette[i++ % palette.length];
    }
  }
  return colorByKey;
}

/** tallest pack height helper (kept — sometimes used for UI summaries) */
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

/* ====== NEW: guaranteed-dimensions fallback (never drop a line) ====== */
function deriveDimsFromFallback(prodRow, truckHeightM) {
  // Try product.volume first
  const volM3 = parseVolumeAndUOM(prodRow?.volume, prodRow?.volume_uom) || 0;
  if (volM3 > 0) {
    const H = Math.min(Math.max(0.2, Math.cbrt(volM3)), Math.max(0.2, truckHeightM || 0.6));
    const base = Math.sqrt(Math.max(volM3 / H, 0.04)); // >= 0.2m x 0.2m
    return { lengthM: r3(base), widthM: r3(base), heightM: r3(H) };
  }
  // Last resort tiny placeholder – so the box/color still appears
  return { lengthM: 0.25, widthM: 0.25, heightM: Math.min(0.25, Math.max(0.2, truckHeightM || 0.6)) };
}

/* ========= stop-wise, vertical-first stacking algorithm =========
   Axes assumption (consistent with your renderer):
     X → along truck length (tailgate → cab)
     Y → vertical (stacking)
     Z → across truck width
   FILO: last stop placed first at small X. */
function computeBoxPlacements(loadArrangement, packageInfoDetails, vehicleDimensions, opts = {}) {
  const truck = {
    interiorWidthM: Number(vehicleDimensions?.interiorWidthM || 0),
    interiorLengthM: Number(vehicleDimensions?.interiorLengthM || 0),
    interiorHeightM: Number(vehicleDimensions?.interiorHeightM || 0)
  };
  const Z_GUTTER = Number(opts.zGutter ?? 0.0);
  const FRONT_GUTTER_X = Number(opts.frontGutter ?? 0.0);
  const LAYER_GAP = Number(opts.layerGap ?? 0.02);
  const EPS = 1e-9;

  // Global layer cap from vehicle (already derived from height & SF earlier)
  const allowedGlobalLayers = Math.max(1, Number(opts.maxLayers || 1));

  const colorByKey = buildColorMapByProdPkg(packageInfoDetails);
  const pkgMap = new Map(packageInfoDetails.map(p => [p.pkg_ID, p]));

  // FILO: place highest stop number first (goes deepest at small X)
  const stopsDesc = [...loadArrangement].sort((a, b) => b.stop - a.stop);

  const colorFor = (prod_ID, pkg_ID) => colorByKey[`${prod_ID}|${pkg_ID}`] || '#999';

  function expandStopLines(stop) {
    const items = [];
    for (const pkgId of (stop.packages || [])) {
      const pkg = pkgMap.get(pkgId);
      if (!pkg) continue;
      for (const line of (pkg.lines || [])) {
        const dims = line.packagingDimensions || {};
        const L = +dims.lengthM || 0;
        const W = +dims.widthM || 0;
        const H = +dims.heightM || 0;
        const qty = Number(line.quantity || 0);
        if (!(L > 0 && W > 0 && H > 0) || qty <= 0) continue;

        // per-line layer cap: min(vehicle global cap, height cap, stacking factor cap)
        const heightCap = (truck.interiorHeightM > 0 && H > 0)
          ? Math.max(1, Math.floor(truck.interiorHeightM / H))
          : 1;
        const lineSfCap = Math.max(1, Number(line.sfCap || line.stacking_factor || line.allowedLayers || 1));
        const perLineCap = Math.max(1, Math.min(heightCap, lineSfCap, allowedGlobalLayers));

        items.push({
          pkg_ID: pkgId,
          prod_ID: line.prod_ID,
          qty,
          L, W, H,
          maxLayers: perLineCap,
          color: colorFor(line.prod_ID, pkgId)
        });
      }
    }
    // Sort: bigger footprint first to avoid slivers; tie by height then prod
    items.sort((a, b) => {
      const va = a.L * a.W * a.H;
      const vb = b.L * b.W * b.H;
      if (vb !== va) return vb - va;
      if (b.H !== a.H) return b.H - a.H;
      return String(a.prod_ID).localeCompare(String(b.prod_ID));
    });
    return items;
  }

  // Track how many we *expected* vs *placed* (to surface overflow clearly)
  const expectedByKey = new Map();
  for (const p of packageInfoDetails) {
    for (const l of (p.lines || [])) {
      const q = Number(l.quantity || 0);
      if (!q) continue;
      const k = `${p.pkg_ID}|${l.prod_ID}`;
      expectedByKey.set(k, (expectedByKey.get(k) || 0) + q);
    }
  }
  const placedByKey = new Map();

  const placements = [];
  let globalLayersUsed = 0;

  // Truck cursors
  const Wmax = truck.interiorWidthM;
  const Lmax = truck.interiorLengthM;

  let cursorX = FRONT_GUTTER_X; // along length
  let cursorZ = 0;              // across width
  let sliceDepth = 0;           // deepest L used in current Z-row

  function advanceToNextSlice() {
    cursorZ = 0;
    cursorX = Math.min(Lmax, r3(cursorX + sliceDepth + FRONT_GUTTER_X));
    sliceDepth = 0;
  }

  // Iterate stops (FILO)
  for (const stop of stopsDesc) {
    const items = expandStopLines(stop);
    if (!items.length) {
      advanceToNextSlice(); // keep bays separate per stop
      continue;
    }

    for (const it of items) {
      let remaining = it.qty;

      while (remaining > 0) {
        // remaining row width
        const remWidth = Wmax - cursorZ;

        // try floor-plane rotation if it helps
        let placeL = it.L, placeW = it.W;
        if (placeW > remWidth + EPS && placeL <= remWidth + EPS && placeL <= Wmax + EPS) {
          const tmp = placeL; placeL = it.W; placeW = it.L;
        }

        // width wrap after rotation attempt
        if (cursorZ + placeW > Wmax + EPS) {
          advanceToNextSlice();
        }
        // length overflow => stop placing further items
        if (cursorX + placeL > Lmax + EPS) {
          // can't place further stacks of this item — break out to mark overflow later
          remaining = 0;
          break;
        }

        // Build one vertical stack at this floor slot
        const layersHere = Math.min(it.maxLayers, remaining);
        for (let h = 0; h < layersHere; h++) {
          placements.push({
            pkg_ID: it.pkg_ID,
            prod_ID: it.prod_ID,
            color: it.color,
            position: [r3(cursorX), r3(h * (it.H + LAYER_GAP)), r3(cursorZ)],
            dimensions: [r3(placeL), r3(it.H), r3(placeW)]
          });
        }
        globalLayersUsed = Math.max(globalLayersUsed, layersHere);
        remaining -= layersHere;

        // track placed count
        const key = `${it.pkg_ID}|${it.prod_ID}`;
        placedByKey.set(key, (placedByKey.get(key) || 0) + layersHere);

        // Update row bookkeeping
        sliceDepth = Math.max(sliceDepth, placeL);
        cursorZ = r3(cursorZ + placeW + Z_GUTTER);
      }
    }

    // After finishing a stop, start a fresh X slice so stops don't interleave
    advanceToNextSlice();
    if (cursorX >= Lmax - 1e-9) break; // truck full in length
  }

  // Compute overflow (anything expected but not placed)
  const overflow = [];
  const overflowPkgSet = new Set();
  for (const [key, exp] of expectedByKey.entries()) {
    const got = placedByKey.get(key) || 0;
    if (got < exp) {
      const [pkg_ID, prod_ID] = key.split('|');
      overflow.push({ pkg_ID, prod_ID, missingQty: exp - got });
      overflowPkgSet.add(pkg_ID);
    }
  }

  return {
    placements,
    total: placements.length,
    placed: placements.length,
    layersUsed: Math.max(1, globalLayersUsed),
    overflow,
    overflowPackages: Array.from(overflowPkgSet)
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

function buildProductLegend(loadArrangement, packageInfoDetails, colorByProdPkg) {
  const byProd = {};
  for (const stopEntry of loadArrangement) {
    const stop = stopEntry.stop;
    for (const pkg_ID of stopEntry.packages) {
      const p = packageInfoDetails.find(x => x.pkg_ID === pkg_ID);
      if (!p) continue;
      for (const l of (p.lines || [])) {
        if (!l?.prod_ID) continue;
        const rec = (byProd[l.prod_ID] ||= {
          prod_ID: l.prod_ID, color: '#999', totalQty: 0, byPackage: {}, byStop: {}
        });
        const q = Number(l.quantity || 0);
        rec.totalQty += q;
        const key = `${l.prod_ID}|${pkg_ID}`;
        const prev = rec.byPackage[pkg_ID] || { qty: 0, color: colorByProdPkg[key] || '#999' };
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

/* -------------------------- ROUTES --------------------------- */

// Create order (allocations) with optional traffic + weather
router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const { packages: packageIDs, filters } = req.body;
    if (!packageIDs?.length) return res.status(400).json({ error: 'No packages provided.' });

    const includeTraffic = !!filters?.includeTraffic;
    const departureTimeEpoch = Number(filters?.traffic?.departureTimeEpoch || 0);

    // Default to true if a weather key exists (caller can disable by send includeWeather:false)
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

    // 3) packaging info
    const allPacIDs = collectAllPacIDs(packagesData, productMap);
    const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

    // tallest package height
    const heights = allLines.map(l => {
      const prod = productMap[l.prod_ID];
      const pacIds = resolvePacIdsFromProduct(prod);
      const info = pacIds[0] ? packagingInfoMap[pacIds[0]] : null;
      return info ? parseDimension(`${info.pack_height} ${info.dimensions_uom}`) : 0;
    }).filter(Boolean);
    const maxPkgH = heights.length ? Math.max(...heights) : 0;

    // global stacking factor cap (kept for UI, not used for feasibility anymore)
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
      const oneLayerM3 = (maxPkgH > 0) ? (W * L * maxPkgH) : 0;
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

    // 7) allocate (with toggles) — now strict floor-fit aware
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

      const packageInfoDetails = a.packages.map((pkgID) => {
        const pkgRecord = packagesData.find(p => p.pack_ID === pkgID);

        const lines = (pkgRecord?.products || []).map(line => {
          const prod = productMap[line.prod_ID];
          const pacIds = resolvePacIdsFromProduct(prod);
          const firstPac = pacIds[0] || null;
          const packInfo = firstPac ? packagingInfoMap[firstPac] : null;

          let dims;
          if (packInfo && packInfo.pack_length && packInfo.pack_width && packInfo.pack_height) {
            dims = {
              lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
              widthM:  parseDimension(`${packInfo.pack_width}  ${packInfo.dimensions_uom}`),
              heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
            };
          } else {
            // ✅ guaranteed – never drop the line
            dims = deriveDimsFromFallback(prod, heightM);
            logger.warn('Using fallback dims for product line', { prod_ID: line.prod_ID, pack_ID: pkgRecord?.pack_ID });
          }

          const sfRaw = prod?.stacking_factor;
          const stacking_factor = (sfRaw === '' ? null : sfRaw);
          const sfNum = Number(stacking_factor);
          const sfCap = (!sfNum || isNaN(sfNum) || sfNum <= 1) ? 1 : sfNum;

          let allowedLayers = 1;
          if (dims?.heightM && heightM) {
            const heightCap = Math.max(1, Math.floor(heightM / dims.heightM));
            allowedLayers = Math.min(heightCap, Math.max(1, v.allowedLayers || 1), sfCap);
          }

          return {
            prod_ID: line.prod_ID,
            quantity: line.quantity,
            pac_ID: firstPac,
            stacking_factor,
            sfCap,
            package_info: packInfo,
            packagingDimensions: dims, // ✅ always present
            allowedLayers
          };
        });

        return { pkg_ID: pkgID, lines };
      });

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

      const colorByProdPkg = buildColorMapByProdPkg(packageInfoDetails);
      const tallestH = getMaxBoxHeight(packageInfoDetails);

      const { placements: rawPlacements, layersUsed, overflow, overflowPackages } = computeBoxPlacements(
        a.loadArrangement,
        packageInfoDetails,
        { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
        {
          maxLayers: Math.max(1, v.allowedLayers || 1), // global per-truck cap
          zGutter: 0.0,
          frontGutter: 0.0,
          layerGap: 0.02,
          layerHeight: tallestH
        }
      );

      const boxPlacements = generatePackageBlocks(rawPlacements);

      // ✅ sanity: input vs output count (still keep for telemetry)
      const expectedCount = packageInfoDetails.reduce((s,p)=>
        s + (p.lines||[]).reduce((ss,l)=> ss + Number(l.quantity||0), 0), 0
      );
      const actualCount = boxPlacements.length;
      if (expectedCount !== actualCount) {
        logger.warn('Box placement count mismatch', {
          vehicle_ID: v.vehicle_ID,
          expected: expectedCount,
          actual: actualCount,
          stops: a.loadArrangement?.length || 0,
          overflow
        });
      }

      const productLegend = buildProductLegend(a.loadArrangement, packageInfoDetails, colorByProdPkg);

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

      // Compute traffic summary if route has traffic fields but summary missing
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
        overflow,                // <-- NEW: explicit, per (pkg,prod) missing counts
        overflowPackages,        // <-- NEW: which package IDs had missing blocks
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

        // new optional extras
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

    // respond first
    res.status(200).json({ sampledRoutePoints: sampledCoords });

    // non-blocking telemetry
    noBlock(logApiPerf('/sample-route', Date.now() - t0, true), 'logApiPerf(/sample-route)');
    noBlock(emit('route.sampled', { points: sampledCoords, at: Date.now() }), 'emit(route.sampled)');
  } catch (err) {
    res.status(500).json({ error: err.message });
    noBlock(logApiPerf('/sample-route', Date.now() - t0, false), 'logApiPerf(/sample-route)');
    logger.error('Error sampling route:', err);
  }
});

/* ---------------- helper endpoints ---------------- */

// Traffic: returns legs + summary (Google only) — cached + non-blocking telemetry
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

    // respond immediately
    res.status(200).json(payload);

    // background cache + telemetry
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

    // NEW: normalize potential {latitude,longitude} inputs to {lat,lng}
    const normalized = usePoints.map(normalizePoint);

    const { pointsWeather, summary } = await getWeatherAlongRoute(normalized, { units, maxPoints });

    // respond first
    const payload = { units, pointsWeather, summary };
    res.status(200).json(payload);

    // non-blocking telemetry
    noBlock(logApiPerf('/route/weather', Date.now() - t0, true), 'logApiPerf(/route/weather)');
    noBlock(emit('route.weather', { count: pointsWeather.length, at: Date.now() }), 'emit(route.weather)');
  } catch (err) {
    res.status(500).json({ error: err.message });
    noBlock(logApiPerf('/route/weather', Date.now() - t0, false), 'logApiPerf(/route/weather)');
    logger.error('Error on /route/weather:', err);
  }
});

module.exports = router;
