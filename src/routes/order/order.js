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

// Ground-plane conservative fill ratio
const FLOOR_PACKING_DENSITY = Number(cfg.floorPackingDensity || process.env.FLOOR_PACKING_DENSITY || 0.9);

// Vertical gap between stacked layers (must match 3D placement)
const LAYER_GAP_STACKING = Number(cfg.layerGap || process.env.LAYER_GAP || 0.02);

// *** NEW: small headroom so stacks never touch the roof (meters) ***
const LAYER_HEADROOM = Number(cfg.layerHeadroom || process.env.LAYER_HEADROOM || 0.005);

/* ---------------------- helpers ---------------------- */
function buildRouteKey(locs) { return locs.map(l => `${l.latitude},${l.longitude}`).join('|'); }
function toRadians(d) { return d * Math.PI / 180; }
function distanceBetweenCoords(aLat, aLng, bLat, bLng) {
  const R = 6371, dLat = toRadians(bLat - aLat), dLng = toRadians(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function sampleRoutePoints(coords, intervalKm = 20, maxPoints = Infinity) {
  if (!coords.length) return [];
  const out = [coords[0]];
  let last = coords[0], acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += distanceBetweenCoords(last.lat, last.lng, coords[i].lat, coords[i].lng);
    if (acc >= intervalKm) {
      out.push(coords[i]); last = coords[i]; acc = 0;
      if (out.length >= maxPoints) break;
    }
  }
  if (out[out.length - 1] !== coords[coords.length - 1] && out.length < maxPoints) out.push(coords[coords.length - 1]);
  return out;
}
function parseDistanceText(txt) { return parseFloat(String(txt).replace(/[^\d.]/g, '')) || 0; }
const kmText = m => `${(m / 1000).toFixed(1)} km`;
const minText = s => `${Math.round(s / 60)} mins`;

function noBlock(p, label, ms = 400) {
  Promise.race([p, new Promise(r => setTimeout(r, ms))]).catch(e => logger?.warn?.(`${label} failed`, { msg: e.message }));
}

/* ----------------- NEW: SF + height helpers ----------------- */
// SF parsing: 0 / '', null / undefined / NaN  => Infinity (unbounded)
function parseSfCap(sfRaw) {
  if (sfRaw === '' || sfRaw == null) return Infinity;
  const n = Number(sfRaw);
  if (!Number.isFinite(n) || n < 0) return Infinity;
  if (n === 0) return Infinity;
  if (n <= 1) return 1;
  return n;
}

// Height-aware (gap-aware) cap with headroom: max n s.t. n*H + (n-1)*gap <= (truckH - headroom)
function capLayersByHeight(itemH, truckH, gap = 0, headroom = LAYER_HEADROOM) {
  if (!(itemH > 0) || !(truckH > 0)) return 1;
  const usable = Math.max(0, truckH - headroom);
  const n = Math.floor((usable + gap) / (itemH + gap));
  return Math.max(1, n);
}

/* --------- normalizers --------- */
function normalizePoint(p) {
  if (p && typeof p === 'object') {
    if ('lat' in p && 'lng' in p) return { lat: +p.lat, lng: +p.lng };
    if ('latitude' in p && 'longitude' in p) return { lat: +p.latitude, lng: +p.longitude };
  }
  throw new Error('Bad point: expected {lat,lng} or {latitude,longitude}');
}
function dedupeConsecutiveLocations(locs) {
  if (!Array.isArray(locs) || !locs.length) return [];
  const out = [locs[0]];
  for (let i = 1; i < locs.length; i++) {
    const a = out[out.length - 1], b = locs[i];
    if (a.latitude !== b.latitude || a.longitude !== b.longitude) out.push(b);
  }
  return out;
}

/* --------- departure helpers --------- */
function normalizeDeparture(epoch) {
  const now = Math.floor(Date.now() / 1000);
  if (!epoch || epoch < now - 600) return now;
  const maxAhead = 24 * 3600;
  return Math.min(epoch, now + maxAhead);
}
function departureBucket(epoch, minutes = 15) {
  const e = normalizeDeparture(epoch);
  return Math.floor(e / (minutes * 60));
}

/* ---------------- WEATHER HELPERS (OpenWeather) ---------------- */
function wKey(lat, lng, units) { return `weather:${units}:${(+lat).toFixed(2)},${(+lng).toFixed(2)}`; }
async function fetchWeatherPoint(lat, lng, units = WEATHER_UNITS_DEFAULT) {
  if (!OPENWEATHER_API_KEY) throw new Error('OPENWEATHER_API_KEY missing');
  const key = wKey(lat, lng, units);
  const cached = await getJSON(key);
  if (cached) return cached;

  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_API_KEY}&units=${units}`;
  const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
  const d = resp.data || {};
  const out = {
    lat: +lat, lng: +lng, at: Math.floor(Date.now() / 1000), units,
    temp: d.main?.temp ?? null, feelsLike: d.main?.feels_like ?? null,
    humidity: d.main?.humidity ?? null, windSpeed: d.wind?.speed ?? null, windDir: d.wind?.deg ?? null,
    condition: (d.weather && d.weather[0]?.main) || null, icon: (d.weather && d.weather[0]?.icon) || null,
    precip1h: (d.rain && (d.rain['1h'] || 0)) || (d.snow && (d.snow['1h'] || 0)) || 0
  };
  await setJSON(key, out, WEATHER_CACHE_TTL);
  return out;
}

// --- simple concurrency helper used by getWeatherAlongRoute ---
async function runInBatches(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let i = 0;

  async function runner() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (_) {
        results[idx] = null; // swallow per-point failures
      }
    }
  }

  // spin up N runners
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

async function getWeatherAlongRoute(points, { units = WEATHER_UNITS_DEFAULT, maxPoints = WEATHER_MAX_POINTS_DEFAULT } = {}) {
  const use = Array.isArray(points) ? points.slice(0, maxPoints) : [];
  if (!use.length) return { pointsWeather: [], summary: { minTemp: null, maxTemp: null, distinctConditions: [], points: 0 }, units };
  const results = await runInBatches(use, WEATHER_CONCURRENCY, p => fetchWeatherPoint(p.lat, p.lng, units).catch(() => null));
  const ok = results.filter(Boolean);
  const temps = ok.map(r => r.temp).filter(v => typeof v === 'number');
  const summary = { minTemp: temps.length ? Math.min(...temps) : null, maxTemp: temps.length ? Math.max(...temps) : null, distinctConditions: [...new Set(ok.map(r => r.condition).filter(Boolean))], points: ok.length };
  return { pointsWeather: ok, summary, units };
}

/* ------------------ ROUTING (Google / OSRM) ------------------ */
async function fetchRouteGoogle(locations, { includeTraffic = false, departureTimeEpoch = 0 } = {}) {
  locations = dedupeConsecutiveLocations(locations);

  const origin = locations[0], dest = locations[locations.length - 1];
  const waypoints = locations.length > 2 ? locations.slice(1, -1).map(l => `${l.latitude},${l.longitude}`).join('|') : '';

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
    logger.error('Google Directions failed', { status: data.status, error_message: data.error_message, waypointCount: locations.length, includeTraffic, departureTimeEpoch });
    throw new Error(`Google error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
  }
  const r0 = data.routes[0] || {};
  const legs = r0.legs || [];
  const poly = r0.overview_polyline?.points || '';
  const decoded = poly ? polyline.decode(poly).map(([lat, lng]) => ({ lat, lng })) : [];

  const mappedLegs = legs.map((leg, i) => {
    const base = {
      start: { address: leg.start_address, latitude: locations[i].latitude, longitude: locations[i].longitude },
      end: { address: leg.end_address, latitude: locations[i + 1].latitude, longitude: locations[i + 1].longitude },
      distance: leg.distance?.text || '',
      duration: leg.duration?.text || ''
    };
    if (includeTraffic && leg.duration_in_traffic?.value != null) {
      const normalSec = leg.duration?.value || 0, trafficSec = leg.duration_in_traffic.value;
      base.durationInTraffic = leg.duration_in_traffic?.text || base.duration;
      base.trafficDelaySec = Math.max(0, trafficSec - normalSec);
      base.traffic = { durationInTrafficSec: trafficSec, normalDurationSec: normalSec, delaySec: Math.max(0, trafficSec - normalSec) };
    }
    return base;
  });

  if (includeTraffic && legs.some(l => l?.duration_in_traffic?.value == null)) {
    logger.warn('Google: duration_in_traffic missing for some legs', { legCount: legs.length });
  }

  let trafficSummary = null;
  if (includeTraffic) {
    const delays = mappedLegs.map(l => +l.trafficDelaySec || 0);
    const totalDelaySec = delays.reduce((s, n) => s + n, 0);
    const avgDelay = mappedLegs.length ? Math.round(totalDelaySec / mappedLegs.length) : 0;
    const congestion = totalDelaySec > 3600 ? 'high' : totalDelaySec > 900 ? 'medium' : 'low';
    trafficSummary = { trafficAt: normalizeDeparture(departureTimeEpoch), totalDelaySec, avgDelayPerLegSec: avgDelay, congestion };
  }
  return { legs: mappedLegs, shape: decoded, trafficSummary };
}

async function fetchRouteOSRM(locations) {
  locations = dedupeConsecutiveLocations(locations);
  const coords = locations.map(p => `${p.longitude},${p.latitude}`).join(';');
  const url = `${cfg.osrmBaseUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
  const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT_MS });
  if (resp.data.code !== 'Ok') throw new Error(`OSRM error: ${resp.data.code}`);
  const route = resp.data.routes[0];
  const decoded = polyline.decode(route.geometry).map(([lat, lng]) => ({ lat, lng }));
  const legs = (route.legs || []).map((leg, i) => ({
    start: { address: '', latitude: locations[i].latitude, longitude: locations[i].longitude },
    end: { address: '', latitude: locations[i + 1].latitude, longitude: locations[i + 1].longitude },
    distance: kmText(leg.distance || 0),
    duration: minText(leg.duration || 0)
  }));
  return { legs, shape: decoded, trafficSummary: null };
}

async function getOptimizedRouteWithLoad(locations, shipmentLoads, {
  includeTraffic = false,
  departureTimeEpoch = 0,
  sampleEveryKm = WEATHER_SAMPLE_EVERY_KM_DEFAULT,
  maxSamplePoints = Infinity
} = {}) {
  if (!Array.isArray(locations) || locations.length < 2) throw new Error('Need at least origin and destination');
  locations = dedupeConsecutiveLocations(locations);

  const depBucket = includeTraffic ? departureBucket(departureTimeEpoch) : 0;
  const cacheKey = `route:${cfg.routingProvider}:${includeTraffic ? 'T' : 'N'}:${depBucket}:${buildRouteKey(locations)}:${sampleEveryKm}:${maxSamplePoints}`;
  const cached = await getJSON(cacheKey);
  let optimizedRoute, sampledCoords, trafficSummary, shape;

  if (cached) {
    optimizedRoute = cached.optimizedRoute;
    trafficSummary = cached.trafficSummary || null;
    shape = cached.shape || null;
    sampledCoords = (shape && Array.isArray(shape))
      ? sampleRoutePoints(shape, sampleEveryKm, maxSamplePoints)
      : (cached.sampledCoords || []);
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
      if (leg.start.latitude !== leg.end.latitude || leg.start.longitude !== leg.end.longitude) {
        builtRoute.push({ ...leg, loadAfterStop: currentLoad });
      }
    });

    optimizedRoute = builtRoute;
    shape = shapeLocal || [];
    // sampledCoords = sampleRoutePoints(shape, sampleEveryKm, maxSamplePoints);
    sampledCoords = shape;
    trafficSummary = trafficSummaryLocal;
    await setJSON(cacheKey, { optimizedRoute, shape, trafficSummary }, cfg.redisTTL);
  }

  let currentLoad = 0;
  const recomputed = optimizedRoute.map((leg, i) => {
    currentLoad += (shipmentLoads[i] || 0);
    return { ...leg, loadAfterStop: currentLoad };
  });

  // return { optimizedRoute: recomputed, sampledCoords, trafficSummary };
  return {
  optimizedRoute: recomputed,
  sampledCoords,       // now FULL route
  trafficSummary
};

}

/* ------------------- bearing / clustering ------------------- */
function getBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
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
  let d = Math.abs(iA - iB); if (d > 4) d = 8 - d;
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
          visited.add(j); queue.push(j); cluster.push(pkgs[j]);
        }
      }
    }
    groups.push(cluster);
  }
  return groups;
}

/* ---------------------- DB helpers ----------------------- */
function isVehicleValid(v) {
  const t = new Date(), from = new Date(v.transportation_details.validity_from), to = new Date(v.transportation_details.validity_to);
  return t >= from && t <= to;
}
function isVehicleDown(v) {
  if (!v.downtimes.downtime_starts_from) return false;
  const now = new Date(), s = new Date(v.downtimes.downtime_starts_from), e = new Date(v.downtimes.downtime_ends_from);
  return now >= s && now <= e;
}
async function getLocationById(loc_ID) {
  const [rows] = await db.query(`SELECT latitude, longitude, loc_desc FROM master_locations WHERE loc_ID=?`, [loc_ID]);
  if (!rows.length) throw new Error(`Location not found: ${loc_ID}`);
  return { latitude: parseFloat(rows[0].latitude) || 0, longitude: parseFloat(rows[0].longitude) || 0, loc_desc: rows[0].loc_desc || '' };
}
function safeJsonParse(v, def = []) { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return def; } } return v || def; }
function getPackageSpecialFlags(pkg, productMap) {
  let f = 0, d = 0, h = 0, t = 0;
  for (const pr of pkg.products) {
    const info = productMap[pr.prod_ID]; if (!info) continue;
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
    return !vehF.fragile_vehicle && !vehF.danger_proof && !vehF.hazardous_proof && !vehF.temp_controlled_vehicle;
  }
  if (pkgF.fragile && !vehF.fragile_vehicle) return false;
  if (pkgF.dangerous && !vehF.danger_proof) return false;
  if (pkgF.hazardous && !vehF.hazardous_proof) return false;
  if (pkgF.tempCtrl && !vehF.temp_controlled_vehicle) return false;
  return true;
}

/* ---------------- UNALLOCATION REASON HELPER ---------------- */

function generateUnallocationReason(pkgInfo, vehicles) {
  try {
    if (!pkgInfo) return 'Unknown allocation failure';

    /* 1️⃣ No vehicles at pickup location */
    if (!vehicles || !vehicles.length) {
      return 'No vehicles available at pickup location';
    }

    const pkgFlags = pkgInfo.specialFlags || {};

    /* 2️⃣ Special-goods incompatibility */
    const hasCompatibleVehicle = vehicles.some(v =>
      checkPackageVehicleCompatibility(pkgFlags, getVehicleSpecialFlags(v))
    );

    if (!hasCompatibleVehicle) {
      const reasons = [];
      if (pkgFlags.fragile) reasons.push('fragile');
      if (pkgFlags.dangerous) reasons.push('dangerous');
      if (pkgFlags.hazardous) reasons.push('hazardous');
      if (pkgFlags.tempCtrl) reasons.push('temperature-controlled');

      return reasons.length
        ? `No compatible vehicle available for ${reasons.join(', ')} goods`
        : 'No compatible vehicle available for package type';
    }

    /* 3️⃣ Weight capacity exceeded */
    const fitsWeight = vehicles.some(v =>
      pkgInfo.totalWeight <= v.weightCapKg
    );
    if (!fitsWeight) {
      return 'Package weight exceeds payload capacity of all available vehicles';
    }

    /* 4️⃣ Volume / usable volume exceeded */
    const fitsVolume = vehicles.some(v =>
      pkgInfo.totalVolume <= v.usableVol
    );
    if (!fitsVolume) {
      return 'Package volume exceeds usable capacity of all available vehicles';
    }

    /* 5️⃣ Physical dimension / orientation failure */
    const fitsPhysically = vehicles.some(v => {
      const truckDims = getTruckDimsFromVehicle(v);
      return (pkgInfo.products || []).every(line => {
        const dims = line.packagingDimensions;
        if (!dims) return true;
        return canRectFitInTruck(dims.lengthM, dims.widthM, truckDims);
      });
    });

    if (!fitsPhysically) {
      return 'Package dimensions do not fit inside any available vehicle';
    }

    /* 6️⃣ Stacking / height constraint failure */
    const fitsHeight = vehicles.some(v => {
      const truckDims = getTruckDimsFromVehicle(v);
      return (pkgInfo.products || []).every(line => {
        const dims = line.packagingDimensions;
        if (!dims?.heightM) return true;
        return dims.heightM <= truckDims.heightM;
      });
    });

    if (!fitsHeight) {
      return 'Package height or stacking constraints exceed vehicle limits';
    }

    /* 7️⃣ Solver exhausted all combinations */
    return 'No feasible vehicle combination found for this package';

  } catch (e) {
    // Absolute safety net — never crash allocator
    return 'Allocation failed due to constraints';
  }
}


/* ---------- packaging helpers (ONLY from master_products) --------- */
function resolvePacIdsFromProduct(prodRow) {
  if (!prodRow) return [];
  let pt = prodRow.packaging_type;
  if (typeof pt === 'string') { try { pt = JSON.parse(pt); } catch { pt = null; } }
  if (!Array.isArray(pt)) return [];
  return pt.filter(x => x && x.pac_ID).map(x => x.pac_ID);
}
async function loadAllPackageInfo(pacIDs) {
  if (!pacIDs.length) return {};
  const ph = pacIDs.map(_ => '?').join(',');
  const [rows] = await db.query(`SELECT * FROM master_package_info WHERE pac_ID IN (${ph})`, pacIDs);
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
// async function sumPackageWeightVolume(pkg, productMap, pkgInfoMap){
//   let totalW=0,totalV=0;
//   for(const line of pkg.products){
//     const prod=productMap[line.prod_ID]; if(!prod) continue;
//     totalW+=parseWeightAndUOM(prod.weight,prod.weight_uom)*line.quantity;
//     const pacIds=resolvePacIdsFromProduct(prod);
//     if(pacIds.length){
//       const info=pkgInfoMap[pacIds[0]];
//       if(info) totalV+=parseVolumeAndUOM(info.pack_volume,info.pack_volume_uom)*line.quantity;
//     }
//   }
//   return {totalW,totalV};
// }

async function sumPackageWeightVolume(pkg, productMap, pkgInfoMap) {
  let totalW = 0;     // physical weight (kg) for capacity/feasibility
  let totalV = 0;     // volume (m3)  for volume/packing
  let totalCW = 0;    // chargeable weight (kg) for PRICING ONLY

  for (const line of (pkg.products || [])) {
    const prod = productMap[line.prod_ID];
    if (!prod) continue;
    const qty = Number(line.quantity || 0);

    // physical weight (always from weight + weight_uom)
    const physKg = parseWeightAndUOM(prod.weight, prod.weight_uom) * qty;
    totalW += physKg;

    // chargeable weight: prefer new fields; fallback to physical if missing
    const useCwVal = (prod.chargeable_weight ?? prod.weight);
    const useCwUom = (prod.chargeable_weight != null ? prod.chargeable_weight_uom : prod.weight_uom);
    const chgKg = parseWeightAndUOM(useCwVal, useCwUom) * qty;
    totalCW += chgKg;

    // volume from packaging
    const pacIds = resolvePacIdsFromProduct(prod);
    if (pacIds.length) {
      const info = pkgInfoMap[pacIds[0]];
      if (info) totalV += parseVolumeAndUOM(info.pack_volume, info.pack_volume_uom) * qty;
    }
  }
  return { totalW, totalV, totalCW };
}

/* ------------------- dimension + packing helpers ------------------- */
function parseDimension(str = '') {
  if (typeof str === 'number') return +str || 0;
  const m = String(str).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  return /cm/i.test(str) ? val / 100 : val;
}
function r3(n) { return Math.round(n * 1000) / 1000; }

function deriveDimsFromFallback(prodRow, truckHeightM) {
  const volM3 = parseVolumeAndUOM(prodRow?.volume, prodRow?.volume_uom) || 0;
  if (volM3 > 0) {
    const H = Math.min(Math.max(0.2, Math.cbrt(volM3)), Math.max(0.2, truckHeightM || 0.6));
    const base = Math.sqrt(Math.max(volM3 / H, 0.04));
    return { lengthM: r3(base), widthM: r3(base), heightM: r3(H) };
  }
  return { lengthM: 0.25, widthM: 0.25, heightM: Math.min(0.25, Math.max(0.2, truckHeightM || 0.6)) };
}

function getTruckDimsFromVehicle(v) {
  const caps = v.capacity || {};
  const widthM = parseDimension(caps.interior_width);
  const lengthM = parseDimension(caps.interior_length);
  const heightM = parseDimension(caps.interior_height);
  return { widthM, lengthM, heightM, floorAreaM2: (widthM || 0) * (lengthM || 0) };
}

// per-line dims + cap for a given truck
function getLineDimsAndCap(prod, packInfo, truckHeightM, truckAllowedLayers, globalSfCap) {
  let dims;
  if (packInfo && packInfo.pack_length && packInfo.pack_width && packInfo.pack_height) {
    dims = {
      lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
      widthM: parseDimension(`${packInfo.pack_width} ${packInfo.dimensions_uom}`),
      heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
    };
  } else {
    dims = deriveDimsFromFallback(prod, truckHeightM);
  }

  const sfCap = parseSfCap(prod?.stacking_factor);

  let allowedLayers = 1;
  if (dims?.heightM && truckHeightM) {
    const heightCap = capLayersByHeight(dims.heightM, truckHeightM, LAYER_GAP_STACKING, LAYER_HEADROOM);
    allowedLayers = Math.min(
      heightCap,
      (truckAllowedLayers ?? Infinity),
      (globalSfCap ?? Infinity),
      (sfCap ?? Infinity)
    );
  }
  return { dims, allowedLayers, sfCap };
}

// quick physical fit check with rotation
function canRectFitInTruck(L, W, truck) {
  const { widthM, lengthM } = truck;
  if (!widthM || !lengthM) return true;
  return (L <= lengthM && W <= widthM) || (W <= lengthM && L <= widthM);
}

function estimatePackageFloorArea(pkg, productMap, packagingInfoMap, truck, truckAllowedLayers, globalSfCap) {
  let area = 0, fitsPhysically = true;

  for (const line of (pkg.products || [])) {
    const prod = productMap[line.prod_ID]; if (!prod) continue;
    const pacIds = resolvePacIdsFromProduct(prod);
    const firstPac = pacIds[0] || null;
    const packInfo = firstPac ? packagingInfoMap[firstPac] : null;

    const { dims, allowedLayers } = getLineDimsAndCap(
      prod, packInfo, truck.heightM, truckAllowedLayers, globalSfCap
    );

    if (!canRectFitInTruck(dims.lengthM, dims.widthM, truck)) fitsPhysically = false;

    const qty = Number(line.quantity || 0);
    const stacks = Math.max(0, Math.ceil(qty / Math.max(1, allowedLayers)));
    area += stacks * (dims.lengthM * dims.widthM);
  }
  return { areaM2: area, fitsPhysically };
}

/* ---------------- fast greedy splitter & allocation ---------------- */
function unionFlags(a, b) {
  return {
    fragile: (a.fragile || b.fragile) ? 1 : 0,
    dangerous: (a.dangerous || b.dangerous) ? 1 : 0,
    hazardous: (a.hazardous || b.hazardous) ? 1 : 0,
    tempCtrl: (a.tempCtrl || b.tempCtrl) ? 1 : 0
  };
}

function greedyBinsForTruck(group, vehicle, {
  truckDims, weightCapKg, usableVolM3, floorAreaBudgetM2,
  productMap, packagingInfoMap, globalSfCap
}) {
  const bins = [];
  const remaining = [...group];

  while (remaining.length) {
    let bin = { pkgs: [], sumWeight: 0, sumChargeableWeight: 0, sumVolume: 0, sumArea: 0, flags: { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 } };

    for (let i = 0; i < remaining.length;) {
      const pkg = remaining[i];
      const { areaM2, fitsPhysically } = estimatePackageFloorArea(pkg, productMap, packagingInfoMap, truckDims, vehicle.allowedLayers, globalSfCap);
      if (!fitsPhysically) { i++; continue; }

      const newArea = bin.sumArea + areaM2;
      const newWeight = bin.sumWeight + pkg.totalWeight;
      const newVolume = bin.sumVolume + pkg.totalVolume;
      const newCw = bin.sumChargeableWeight + pkg.chargeableWeight;
      const newFlags = unionFlags(bin.flags, pkg.specialFlags);

      const flagsOk = checkPackageVehicleCompatibility(newFlags, getVehicleSpecialFlags(vehicle));
      if (flagsOk && newWeight <= weightCapKg + 1e-6 && newVolume <= usableVolM3 + 1e-9 && newArea <= floorAreaBudgetM2 + 1e-9) {
        bin.pkgs.push(pkg);
        bin.sumArea = newArea; bin.sumWeight = newWeight; bin.sumVolume = newVolume; bin.flags = newFlags;
        bin.sumChargeableWeight = newCw;
        remaining.splice(i, 1);
      } else {
        i++;
      }
    }
    if (!bin.pkgs.length) break;
    bins.push(bin);
  }
  return { bins, leftover: remaining };
}

/* ---------------- backtracking cost solver (last resort) ---------------- */
async function findMinCostArrangement(cluster, vehicles, sourceLoc) {
  vehicles = vehicles.slice().sort((a, b) => a.cost_per_ton - b.cost_per_ton);

  let best = { cost: Infinity, allocations: [], unallocated: cluster.map(p => p.pack_ID), placedCount: 0 };
  function snapshot(used, rem) {
    return {
      cost: used.reduce((s, a) => s + a.cost, 0),
      allocations: JSON.parse(JSON.stringify(used)),
      unallocated: rem.map(r => r.pack_ID),
      placedCount: cluster.length - rem.length
    };
  }

  async function backtrack(rem, iVeh, used) {
    if (!rem.length) { const s = snapshot(used, rem); if (s.placedCount > best.placedCount || (s.placedCount === best.placedCount && s.cost < best.cost)) best = s; return; }
    if (iVeh >= vehicles.length) { const s = snapshot(used, rem); if (s.placedCount > best.placedCount || (s.placedCount === best.placedCount && s.cost < best.cost)) best = s; return; }

    const v = vehicles[iVeh];
    const subsets = [];
    function buildSub(idx, chosen, sumW, sumV, flags, sumCW) {
      if (idx === rem.length) { subsets.push({ chosen, sumW, sumV, flags, sumCW }); return; }
      buildSub(idx + 1, chosen, sumW, sumV, flags, sumCW);
      const pkg = rem[idx];
      const newW = sumW + pkg.totalWeight;
      const newV = sumV + pkg.totalVolume;
      const newCW = sumCW + pkg.chargeableWeight;
      if (newW <= v.weightCapKg && newV <= v.usableVol) {
        const nf = { ...flags };
        nf.fragile ||= pkg.specialFlags.fragile;
        nf.dangerous ||= pkg.specialFlags.dangerous;
        nf.hazardous ||= pkg.specialFlags.hazardous;
        nf.tempCtrl ||= pkg.specialFlags.tempCtrl;
        if (checkPackageVehicleCompatibility(nf, getVehicleSpecialFlags(v))) {
          buildSub(idx + 1, [...chosen, pkg], newW, newV, nf, newCW);
        }
      }
    }
    const LIMIT = 10;
    if (rem.length <= LIMIT) {
      buildSub(0, [], 0, 0, { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 }, 0);
    } else {
      const greedy = rem.slice().sort((a, b) => b.totalVolume - a.totalVolume);
      let sumW = 0, sumV = 0; const flags = { fragile: 0, dangerous: 0, hazardous: 0, tempCtrl: 0 }; const chosen = [];
      for (const pkg of greedy) {
        const nw = sumW + pkg.totalWeight, nv = sumV + pkg.totalVolume;
        const nf = unionFlags(flags, pkg.specialFlags);
        if (nw <= v.weightCapKg && nv <= v.usableVol && checkPackageVehicleCompatibility(nf, getVehicleSpecialFlags(v))) {
          sumW = nw; sumV = nv; chosen.push(pkg); Object.assign(flags, nf);
        }
      }
      subsets.push({ chosen, sumW, sumV, flags });
    }

    for(const {chosen,sumW,sumCW} of subsets){
      if (!chosen.length) continue;

      chosen.sort((a, b) => a.distFromSource - b.distFromSource);
      const locs = [sourceLoc, ...chosen.map(x => x.destination)];
      const shipments = new Array(chosen.length).fill(1);
      const { optimizedRoute } = await getOptimizedRouteWithLoad(locs, shipments);
      const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
      const tonsChargeable = (sumCW>0 ? sumCW : sumW) / 1000;
      const cost = tonsChargeable * v.cost_per_ton * totalDist;

      let loadArr = [], remainIDs = chosen.map(x => x.pack_ID);
      optimizedRoute.forEach((leg, i) => {
        const stop = i + 1, matches = [];
        for (const id of remainIDs) {
          const p = chosen.find(x => x.pack_ID === id);
          if (p && p.destination.latitude === leg.end.latitude && p.destination.longitude === leg.end.longitude) matches.push(id);
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
        chargeableWeight:sumCW,
        occupiedVolume: chosen.reduce((s, p) => s + p.totalVolume, 0),
        leftoverWeight: v.weightCapKg - sumW,
        leftoverVolume: v.volumeCapM3 - chosen.reduce((s, p) => s + p.totalVolume, 0),
        cost,
        packages: chosen.map(x => x.pack_ID),
        route: optimizedRoute,
        loadArrangement: loadArr,
        sampledRoutePoints: []
      });

      await backtrack(rem.filter(r => !chosen.includes(r)), iVeh + 1, used);
      used.pop();
    }
    await backtrack(rem, iVeh + 1, used);
  }

  await backtrack(cluster, 0, []);
  return (best.placedCount > 0) ? best : { cost: 0, allocations: [], unallocated: best.unallocated };
}

/* ---------------- allocation orchestration ---------------- */
async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap, extra = {}) {
  const { includeTraffic = false, departureTimeEpoch = 0, weatherOpts = {} } = extra;

  const allocations = [], unallocatedPackages = [];
  let totalCost = 0;
  const pkgInfos = [];

  // build pkg infos
  for (const pkg of packagesData) {
    const { totalW, totalV, totalCW } = await sumPackageWeightVolume(pkg, productMap, packagingInfoMap);
    const destLoc = await getLocationById(pkg.ship_to);
    const bearing = getBearing(sourceLocation.latitude, sourceLocation.longitude, destLoc.latitude, destLoc.longitude);
    const dir8 = getDirection8(bearing);
    const distKM = distanceBetweenCoords(sourceLocation.latitude, sourceLocation.longitude, destLoc.latitude, destLoc.longitude);
    const flags = getPackageSpecialFlags(pkg, productMap);
    pkgInfos.push({
      pack_ID: pkg.pack_ID, products: pkg.products, totalWeight: totalW, totalVolume: totalV,
      chargeableWeight: totalCW, destination: destLoc, direction8: dir8, distFromSource: distKM, specialFlags: flags
    });
  }

  const groups = groupPackagesByDirection(pkgInfos);

  // capacity counts
  const capacityByVehicleId = {};
  for (const v of vehicles) {
    let count = 1;
    if (v.unlimited_usage) count = Infinity;
    else if (typeof v.individual_resource === 'number' && v.individual_resource > 0) count = v.individual_resource;
    capacityByVehicleId[v.vehicle_ID] = count;
  }

  for (const group of groups) {
    group.sort((a, b) => a.distFromSource - b.distFromSource);

    let remaining = [...group];
    for (const veh of vehicles) {
      if (!remaining.length) break;
      if (capacityByVehicleId[veh.vehicle_ID] === 0) continue;

      const truckDims = getTruckDimsFromVehicle(veh);
      const floorAreaBudgetM2 = truckDims.floorAreaM2 * FLOOR_PACKING_DENSITY;
      const weightCapKg = veh.weightCapKg;
      const usableVolM3 = veh.usableVol;

      const physicallyFittable = remaining.filter(pkg => {
        const { fitsPhysically } = estimatePackageFloorArea(pkg, productMap, packagingInfoMap, truckDims, veh.allowedLayers, Infinity);
        return fitsPhysically;
      });
      if (!physicallyFittable.length) continue;

      const { bins, leftover } = greedyBinsForTruck(remaining, veh, {
        truckDims, weightCapKg, usableVolM3, floorAreaBudgetM2,
        productMap, packagingInfoMap, globalSfCap: Infinity
      });

      let slots = capacityByVehicleId[veh.vehicle_ID];
      const useBins = bins.slice(0, Number.isFinite(slots) ? Math.max(0, slots) : bins.length);

      for (const bin of useBins) {
        const pkgs = bin.pkgs; if (!pkgs.length) continue;
        const routeLocs = [sourceLocation, ...pkgs.map(g => g.destination)];
        const shipments = new Array(pkgs.length).fill(1);

        const { optimizedRoute, sampledCoords, trafficSummary } =
          await getOptimizedRouteWithLoad(routeLocs, shipments, {
            includeTraffic, departureTimeEpoch,
            sampleEveryKm: weatherOpts.sampleEveryKm || WEATHER_SAMPLE_EVERY_KM_DEFAULT,
            maxSamplePoints: weatherOpts.maxPoints || WEATHER_MAX_POINTS_DEFAULT
          });

        const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
        const tonsChargeable = (bin.sumChargeableWeight > 0 ? bin.sumChargeableWeight : bin.sumWeight) / 1000;
        const cost = tonsChargeable * veh.cost_per_ton * totalDist;
        totalCost += cost;

        let loadArr = [], remainIDs = pkgs.map(g => g.pack_ID);
        optimizedRoute.forEach((leg, i) => {
          const stop = i + 1, using = [];
          remainIDs.forEach(id => {
            const pkg = pkgs.find(g => g.pack_ID === id);
            if (pkg && pkg.destination.latitude === leg.end.latitude && pkg.destination.longitude === leg.end.longitude) using.push(id);
          });
          if (using.length) {
            using.forEach(id => remainIDs.splice(remainIDs.indexOf(id), 1));
            loadArr.push({ stop, location: leg.end.address, packages: using });
          }
        });

        allocations.push({
          vehicle_ID: veh.vehicle_ID,
          totalWeightCapacity: veh.totalWeightCapacity,
          totalVolumeCapacity: veh.totalVolumeCapacity,
          occupiedWeight: bin.sumWeight,
          chargeableWeight: bin.sumChargeableWeight,
          occupiedVolume: bin.sumVolume,
          leftoverWeight: veh.weightCapKg - bin.sumWeight,
          leftoverVolume: veh.volumeCapM3 - bin.sumVolume,
          cost,
          packages: pkgs.map(g => g.pack_ID),
          pkgVolumes: pkgs.map(g => g.totalVolume),
          route: optimizedRoute,
          trafficSummary,
          loadArrangement: loadArr,
          sampledRoutePoints: sampledCoords
        });
      }

      if (Number.isFinite(capacityByVehicleId[veh.vehicle_ID])) {
        capacityByVehicleId[veh.vehicle_ID] = Math.max(0, capacityByVehicleId[veh.vehicle_ID] - useBins.length);
      }

      remaining = leftover.concat(remaining.filter(p => !physicallyFittable.includes(p)));
      if (!remaining.length) break;
    }

    if (remaining.length) {
      const { cost, allocations: subAllocs, unallocated } = await findMinCostArrangement(remaining, vehicles, sourceLocation);
      totalCost += cost; allocations.push(...subAllocs);
      unallocated.forEach(id => {
        const info = remaining.find(p => p.pack_ID === id);
        unallocatedPackages.push({ pack_ID: id, reason: info ? generateUnallocationReason(info, vehicles) : 'Could not allocate package.' });
      });
    }
  }
  return { allocations, totalCost, unallocated: unallocatedPackages };
}

/* ========= 3D placement ========= */
function buildColorMapByProdPkg(packageInfoDetails) {
  const palette = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#0ea5e9', '#6366f1', '#22c55e'];
  const colorByKey = {}; let i = 0;
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
function getMaxBoxHeight(packageInfoDetails) {
  let h = 0;
  for (const p of packageInfoDetails) {
    for (const l of (p.lines || [])) {
      if (l?.packagingDimensions?.heightM) h = Math.max(h, +l.packagingDimensions.heightM);
    }
  }
  return h || 0.5;
}

function computeBoxPlacements(loadArrangement, packageInfoDetails, vehicleDimensions, opts = {}) {
  const truck = {
    interiorWidthM: Number(vehicleDimensions?.interiorWidthM || 0),
    interiorLengthM: Number(vehicleDimensions?.interiorLengthM || 0),
    interiorHeightM: Number(vehicleDimensions?.interiorHeightM || 0)
  };
  const Z_GUTTER = Number(opts.zGutter ?? 0.0);
  const FRONT_GUTTER_X = Number(opts.frontGutter ?? 0.0);
  const LAYER_GAP = Number(opts.layerGap ?? LAYER_GAP_STACKING);
  const HEADROOM = Number(opts.headroom ?? LAYER_HEADROOM);
  const EPS = 1e-9;

  const allowedGlobalLayers = Math.max(1, Number(opts.maxLayers || 1));

  const colorByKey = buildColorMapByProdPkg(packageInfoDetails);
  const pkgMap = new Map(packageInfoDetails.map(p => [p.pkg_ID, p]));
  const stopsDesc = [...loadArrangement].sort((a, b) => b.stop - a.stop);
  const colorFor = (prod_ID, pkg_ID) => colorByKey[`${prod_ID}|${pkg_ID}`] || '#999';

  function expandStopLines(stop) {
    const items = [];
    for (const pkgId of (stop.packages || [])) {
      const pkg = pkgMap.get(pkgId); if (!pkg) continue;
      for (const line of (pkg.lines || [])) {
        const dims = line.packagingDimensions || {};
        const L = +dims.lengthM || 0, W = +dims.widthM || 0, H = +dims.heightM || 0;
        const qty = Number(line.quantity || 0);
        if (!(L > 0 && W > 0 && H > 0) || qty <= 0) continue;

        // strict height cap with headroom
        const heightCap = capLayersByHeight(H, truck.interiorHeightM, LAYER_GAP, HEADROOM);
        const lineSfCap = parseSfCap(line.sfCap ?? line.stacking_factor ?? line.allowedLayers ?? 1);
        const perLineCap = Math.max(1, Math.min(heightCap, lineSfCap, allowedGlobalLayers));

        items.push({ pkg_ID: pkgId, prod_ID: line.prod_ID, qty, L, W, H, maxLayers: perLineCap, color: colorFor(line.prod_ID, pkgId) });
      }
    }
    items.sort((a, b) => {
      const va = a.L * a.W * a.H, vb = b.L * b.W * b.H;
      if (vb !== va) return vb - va;
      if (b.H !== a.H) return b.H - a.H;
      return String(a.prod_ID).localeCompare(String(b.prod_ID));
    });
    return items;
  }

  const placements = [];
  let globalLayersUsed = 0;

  const Wmax = truck.interiorWidthM, Lmax = truck.interiorLengthM;

  let cursorX = FRONT_GUTTER_X;
  let cursorZ = 0;
  let sliceDepth = 0;

  function advanceToNextSlice() {
    cursorZ = 0;
    cursorX = Math.min(Lmax, r3(cursorX + sliceDepth + FRONT_GUTTER_X));
    sliceDepth = 0;
  }

  // re-check against height inside the placement loop to guard against rounding
  function clampLayersByHeight(H, requested) {
    const hardCap = capLayersByHeight(H, truck.interiorHeightM, LAYER_GAP, HEADROOM);
    return Math.max(1, Math.min(requested, hardCap));
  }

  for (const stop of stopsDesc) {
    const items = expandStopLines(stop);
    if (!items.length) { advanceToNextSlice(); continue; }

    for (const it of items) {
      let remaining = it.qty;

      while (remaining > 0) {
        const remWidth = Wmax - cursorZ;

        let placeL = it.L, placeW = it.W;
        if (placeW > remWidth + EPS && placeL <= remWidth + EPS && placeL <= Wmax + EPS) {
          const tmp = placeL; placeL = it.W; placeW = it.L;
        }

        if (cursorZ + placeW > Wmax + EPS) {
          advanceToNextSlice();
          if (placeW > Wmax + EPS && placeL > Wmax + EPS) { remaining = 0; break; }
          continue;
        }
        if (cursorX + placeL > Lmax + EPS) {
          remaining = 0; break; // length exhausted
        }

        // layers here will never exceed roof
        const layersHere = clampLayersByHeight(it.H, Math.min(it.maxLayers, remaining));

        for (let h = 0; h < layersHere; h++) {
          const y = r3(h * (it.H + LAYER_GAP));
          // assert top never exceeds interior height
          const top = y + it.H;
          if (top > truck.interiorHeightM - HEADROOM + EPS) {
            break; // extra safety
          }
          placements.push({
            pkg_ID: it.pkg_ID, prod_ID: it.prod_ID, color: it.color,
            position: [r3(cursorX), y, r3(cursorZ)],
            dimensions: [r3(placeL), r3(it.H), r3(placeW)]
          });
        }
        globalLayersUsed = Math.max(globalLayersUsed, layersHere);
        remaining -= layersHere;

        sliceDepth = Math.max(sliceDepth, placeL);
        cursorZ = r3(cursorZ + placeW + Z_GUTTER);
      }
    }

    advanceToNextSlice();
    if (cursorX >= Lmax - 1e-9) break;
  }

  return { placements, total: placements.length, placed: placements.length, layersUsed: Math.max(1, globalLayersUsed) };
}

function generatePackageBlocks(boxPlacements) {
  return boxPlacements.map(b => ({ pkg_ID: b.pkg_ID, prod_ID: b.prod_ID, color: b.color || '#999', position: b.position, dimensions: b.dimensions }));
}

function buildProductLegend(loadArrangement, packageInfoDetails, colorByProdPkg) {
  const byProd = {};
  for (const stopEntry of loadArrangement) {
    const stop = stopEntry.stop;
    for (const pkg_ID of stopEntry.packages) {
      const p = packageInfoDetails.find(x => x.pkg_ID === pkg_ID); if (!p) continue;
      for (const l of (p.lines || [])) {
        if (!l?.prod_ID) continue;
        const rec = (byProd[l.prod_ID] ||= { prod_ID: l.prod_ID, color: '#999', totalQty: 0, byPackage: {}, byStop: {} });
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
    prod_ID: r.prod_ID, color: r.color, totalQty: r.totalQty,
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

    const includeWeather = (typeof filters?.includeWeather === 'boolean') ? !!filters.includeWeather : !!OPENWEATHER_API_KEY;

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
      if (p.pickup_date_time.split('T')[0] !== pickupDate) throw new Error('All packages must share pickup date');
    });

    // 2) products
    const allLines = packagesData.flatMap(p => p.products || []);
    const prodIDs = [...new Set(allLines.map(l => l.prod_ID))];
    if (!prodIDs.length) return res.status(400).json({ error: 'No product lines in packages' });

    const [prodRows] = await db.query(
      `SELECT product_ID, weight, weight_uom, chargeable_weight, chargeable_weight_uom, volume, volume_uom,
              fragile_goods, dangerous_goods, hazardous, temp_controlled,
              packaging_type, stacking_factor
         FROM master_products
        WHERE product_ID IN (?)`, [prodIDs]
    );
    const productMap = prodRows.reduce((m, r) => (m[r.product_ID] = r, m), {});

    // 3) packaging info
    const allPacIDs = collectAllPacIDs(packagesData, productMap);
    const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

    // tallest line height (for per-vehicle pre-cap)
    const heights = allLines.map(l => {
      const prod = productMap[l.prod_ID];
      const pacIds = resolvePacIdsFromProduct(prod);
      const info = pacIds[0] ? packagingInfoMap[pacIds[0]] : null;
      return info ? parseDimension(`${info.pack_height} ${info.dimensions_uom}`) : 0;
    }).filter(Boolean);
    const maxPkgH = heights.length ? Math.max(...heights) : 0;

    // global SF cap (∞ if any line unbounded)
    const sfCaps = allLines.map(l => parseSfCap(productMap[l.prod_ID]?.stacking_factor));
    let globalSfCap = 1;
    if (sfCaps.some(v => v === Infinity)) globalSfCap = Infinity;
    else if (sfCaps.length) globalSfCap = Math.max(...sfCaps);

    // 4) vehicles near origin
    const [dbVehicles] = await db.query(
      `SELECT * FROM master_resources WHERE JSON_CONTAINS(loc_ID, ?)`, [JSON.stringify(origin)]
    );

    let fleet = dbVehicles.map(v => {
      const caps = safeJsonParse(v.capacity, {});
      const W = parseDimension(caps.interior_width);
      const L = parseDimension(caps.interior_length);
      const H = parseDimension(caps.interior_height);

      const rawVolDims = (W && L && H) ? (W * L * H) : parseVolumeAndUOM(caps.cubic_capacity, caps.cubic_capacity_unit);
      const rawM3 = rawVolDims || 0;

      const maxLayersByHeight = (maxPkgH > 0 && H > 0)
        ? capLayersByHeight(maxPkgH, H, LAYER_GAP_STACKING, LAYER_HEADROOM)
        : 1;

      const truckAllowedLayers = Math.min(maxLayersByHeight, (globalSfCap ?? Infinity));
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

    // 7) allocate
    const { allocations, totalCost, unallocated } = await allocatePackages(
      packagesData, fleet, sourceLoc, productMap, packagingInfoMap,
      { includeTraffic, departureTimeEpoch, weatherOpts }
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
          const pacIds = resolvePacIdsFromProduct(prod);
          const firstPac = pacIds[0] || null;
          const packInfo = firstPac ? packagingInfoMap[firstPac] : null;

          let dims;
          if (packInfo && packInfo.pack_length && packInfo.pack_width && packInfo.pack_height) {
            dims = {
              lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
              widthM: parseDimension(`${packInfo.pack_width}  ${packInfo.dimensions_uom}`),
              heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
            };
          } else {
            dims = deriveDimsFromFallback(prod, heightM);
            logger.warn('Using fallback dims for product line', { prod_ID: line.prod_ID, pack_ID: pkgRecord?.pack_ID });
          }

          const sfCap = parseSfCap(prod?.stacking_factor);
          let allowedLayers = 1;
          if (dims?.heightM && heightM) {
            const heightCap = capLayersByHeight(dims.heightM, heightM, LAYER_GAP_STACKING, LAYER_HEADROOM);
            allowedLayers = Math.min(heightCap, (v.allowedLayers ?? Infinity), (sfCap ?? Infinity));
          }

          return {
            prod_ID: line.prod_ID, quantity: line.quantity, pac_ID: firstPac,
            stacking_factor: prod?.stacking_factor, sfCap,
            package_info: packInfo, packagingDimensions: dims, allowedLayers
          };
        });
        return { pkg_ID: pkgID, lines };
      });

      const perLineLayers = [];
      packageInfoDetails.forEach(p => {
        (p.lines || []).forEach(l => {
          if (l.packagingDimensions) {
            perLineLayers.push({ prod_ID: l.prod_ID, pac_ID: l.pac_ID, allowedLayers: l.allowedLayers });
          }
        });
      });

      const occupied = a.occupiedVolume;
      const rawM3 = v.totalVolumeCapacity || 0;
      const usableM3 = v.usableVol || rawM3;

      const occupiedPercentRaw = rawM3 ? +((occupied / rawM3) * 100).toFixed(2) : 0;
      const occupiedPercentUsable = usableM3 ? +((occupied / usableM3) * 100).toFixed(2) : 0;

      const packageDetails = a.packages.map((pkg_ID, idx) => {
        const vol = (a.pkgVolumes && a.pkgVolumes[idx]) || 0;
        const percentOfTruckRaw = rawM3 ? +((vol / rawM3) * 100).toFixed(2) : 0;
        const percentOfUsableRules = usableM3 ? +((vol / usableM3) * 100).toFixed(2) : 0;
        return { pkg_ID, volumeM3: vol, percentOfTruck: percentOfTruckRaw, percentOfUsable: percentOfUsableRules };
      });

      const colorByProdPkg = buildColorMapByProdPkg(packageInfoDetails);
      const tallestH = getMaxBoxHeight(packageInfoDetails);

      const { placements: rawPlacements, layersUsed } = computeBoxPlacements(
        a.loadArrangement, packageInfoDetails,
        { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
        {
          maxLayers: Math.max(1, v.allowedLayers || 1),
          zGutter: 0.0, frontGutter: 0.0, layerGap: LAYER_GAP_STACKING, headroom: LAYER_HEADROOM,
          layerHeight: tallestH
        }
      );

      const boxPlacements = generatePackageBlocks(rawPlacements);

      const expectedCount = packageInfoDetails.reduce((s, p) => s + (p.lines || []).reduce((ss, l) => ss + Number(l.quantity || 0), 0), 0);
      const actualCount = boxPlacements.length;
      if (expectedCount !== actualCount) {
        logger.warn('Box placement count mismatch', { vehicle_ID: v.vehicle_ID, expected: expectedCount, actual: actualCount, stops: a.loadArrangement?.length || 0 });
      }

      const productLegend = buildProductLegend(a.loadArrangement, packageInfoDetails, colorByProdPkg);

      // Weather (optional)
      let weatherAlongRoute, weatherSummary;
      if (includeWeather) {
        if (!OPENWEATHER_API_KEY) {
          logger.warn('OPENWEATHER_API_KEY missing: skipping weather');
        } else if (a.sampledRoutePoints?.length) {
          const normalized = a.sampledRoutePoints.map(normalizePoint);
          const r = await getWeatherAlongRoute(normalized, { units: weatherOpts.units, maxPoints: weatherOpts.maxPoints });
          weatherAlongRoute = r.pointsWeather; weatherSummary = r.summary;
        } else {
          weatherAlongRoute = []; weatherSummary = { minTemp: null, maxTemp: null, distinctConditions: [], points: 0 };
        }
      }

      let trafficSummary = a.trafficSummary || null;
      if (includeTraffic && !trafficSummary && Array.isArray(a.route)) {
        const delays = a.route.map(l => +l.trafficDelaySec || 0);
        const totalDelaySec = delays.reduce((s, n) => s + n, 0);
        const avgDelay = a.route.length ? Math.round(totalDelaySec / a.route.length) : 0;
        const congestion = totalDelaySec > 3600 ? 'high' : totalDelaySec > 900 ? 'medium' : 'low';
        trafficSummary = { trafficAt: normalizeDeparture(departureTimeEpoch), totalDelaySec, avgDelayPerLegSec: avgDelay, congestion };
      }

      return {
        ...a,
        boxPlacements,
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

    const ms = Date.now() - t0;
    await logApiPerf('/create-order', ms, true);
    await logSolverPerf(packagesData.length, fleet.length, ms, totalCost);
    try { await emit('plan.optimized', { totalCost, allocations: enriched, at: Date.now() }); } catch { }

    return res.status(200).json({
      message: enriched.length ? 'Best Combinational Scenario' : 'No suitable vehicles found',
      totalCost: enriched.length ? totalCost : null,
      allocations: enriched,
      unallocatedPackages: unallocated
    });
 } catch (err) {
  const ms = Date.now() - t0;
  try { await logApiPerf('/create-order', ms, false); } catch {}

  // ✅ Business validation: packages already ordered
  if (err?.code === 'PACKAGE_ALREADY_ORDERED') {
    logger.warn('Create-order blocked: packages already ordered', {
      orderedPackages: err.orderedPackages,
      message: err.message
    });

    return res.status(409).json({
      error: err.message,
      orderedPackages: err.orderedPackages
    });
  }

  // ✅ Other validation errors (optional)
  if (err?.message?.includes('All packages must share')) {
    logger.warn('Create-order validation failed', { message: err.message });
    return res.status(400).json({ error: err.message });
  }

  // ❌ Real server error
  logger.error('Error creating order', {
    message: err.message,
    code: err.code,
    stack: err.stack
  });

  return res.status(500).json({ error: 'Internal server error' });
}
});

/* ---- Sample route ---- */
// async function getPackagesByIds(packageIDs) {
//   const ph = packageIDs.map(_ => '?').join(',');
//   const [rows] = await db.query(`SELECT * FROM packages WHERE pack_ID IN (${ph})`, packageIDs);
//   if (!rows.length) throw new Error('No matching packages');
//   return rows.map(r => ({
//     pack_ID: r.pack_ID,
//     ship_from: r.ship_from,
//     ship_to: r.ship_to,
//     products: safeJsonParse(r.product_ID),
//     pickup_date_time: r.pickup_date_time
//   }));
// }

async function getPackagesByIds(packageIDs) {
  const ph = packageIDs.map(_ => '?').join(',');
  const [rows] = await db.query(
    `SELECT *
       FROM packages
      WHERE pack_ID IN (${ph})`,
    packageIDs
  );

  if (!rows.length) {
    throw new Error('No matching packages found');
  }

  // 🚨 NEW CHECK: already ordered packages
  const alreadyOrdered = rows
    .filter(r => String(r.package_status).toLowerCase() === 'ordered')
    .map(r => r.pack_ID);

  if (alreadyOrdered.length) {
    const err = new Error('Some packages are already ordered');
    err.code = 'PACKAGE_ALREADY_ORDERED';
    err.orderedPackages = alreadyOrdered;
    throw err;
  }

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
    if (!Array.isArray(locations) || locations.length < 2)
      return res.status(400).json({ error: 'Provide at least origin and destination.' });

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
router.post('/route/traffic', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const { locations, departureTimeEpoch = 0 } = req.body || {};
    if (!Array.isArray(locations) || locations.length < 2)
      return res.status(400).json({ error: 'Provide at least origin and destination.' });
    if (cfg.routingProvider !== 'google')
      return res.status(400).json({ error: 'Traffic is supported only when ROUTING_PROVIDER=google' });
    if (!GOOGLE_API_KEY)
      return res.status(500).json({ error: 'Google API key missing' });

    const depBucket = departureBucket(departureTimeEpoch);
    const keyLocs = dedupeConsecutiveLocations(locations);
    const cacheKey = `traffic:${cfg.routingProvider}:${depBucket}:${buildRouteKey(keyLocs)}`;

    const cached = await getJSON(cacheKey);
    if (cached) {
      res.status(200).json(cached);
      noBlock(logApiPerf('/route/traffic', Date.now() - t0, true), 'logApiPerf(/route/traffic)');
      return;
    }

    const { legs, trafficSummary } = await fetchRouteGoogle(keyLocs, { includeTraffic: true, departureTimeEpoch });
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

router.post('/route/weather', jwtAuth.verifyToken, async (req, res) => {
  const t0 = Date.now();
  try {
    if (!OPENWEATHER_API_KEY) return res.status(500).json({ error: 'OPENWEATHER_API_KEY missing' });
    const { points, locations, units = WEATHER_UNITS_DEFAULT, sampleEveryKm = WEATHER_SAMPLE_EVERY_KM_DEFAULT, maxPoints = WEATHER_MAX_POINTS_DEFAULT } = req.body || {};

    let usePoints = Array.isArray(points) ? points : null;
    if ((!usePoints || !usePoints.length) && Array.isArray(locations) && locations.length >= 2) {
      const shipments = new Array(Math.max(0, locations.length - 1)).fill(0);
      const { sampledCoords } = await getOptimizedRouteWithLoad(locations, shipments, { sampleEveryKm, maxSamplePoints: maxPoints });
      usePoints = sampledCoords;
    }
    if (!usePoints || !usePoints.length) return res.status(400).json({ error: 'Provide points[] or locations[] (>=2)' });

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
