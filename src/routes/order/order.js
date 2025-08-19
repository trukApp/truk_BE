
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');
const jwtAuth = require('../../JWT/jwtAuth');
const polyline = require('@mapbox/polyline');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const routeCache = new Map();

/* ---------------------- small helpers ---------------------- */
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
function sampleRoutePoints(coords, intervalKm = 20) {
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
    }
  }
  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
  }
  return sampled;
}
function parseDistanceText(txt) {
  return parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
}
async function getOptimizedRouteWithLoad(locations, shipmentLoads) {
  if (!Array.isArray(locations) || locations.length < 2) {
    throw new Error("Need at least origin and destination");
  }
  const key = buildRouteKey(locations);
  if (routeCache.has(key)) {
    const { optimizedRoute, sampledCoords } = routeCache.get(key);
    optimizedRoute.forEach((leg, i) => {
      if (i < shipmentLoads.length) leg.loadAfterStop = i === 0 ? shipmentLoads[i] : leg.loadAfterStop;
    });
    return { optimizedRoute, sampledCoords };
  }

  const origin = locations[0], dest = locations[locations.length - 1];
  const waypoints = locations.length > 2
    ? locations.slice(1, -1).map(l => `${l.latitude},${l.longitude}`).join('|')
    : '';
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}` +
    `&destination=${dest.latitude},${dest.longitude}` +
    (waypoints ? `&waypoints=${waypoints}` : '') +
    `&key=${GOOGLE_API_KEY}`;

  const resp = await axios.get(url);
  if (resp.data.status !== 'OK') {
    console.error("Google API error:", resp.data);
    throw new Error(`Google error: ${resp.data.status}`);
  }

  const legs = resp.data.routes[0].legs;
  const optimizedRoute = [];
  let currentLoad = 0;
  legs.forEach((leg, i) => {
    const load = shipmentLoads[i] || 0;
    currentLoad += load;
    if (leg.start_address !== leg.end_address) {
      optimizedRoute.push({
        start: { address: leg.start_address, latitude: locations[i].latitude, longitude: locations[i].longitude },
        end: { address: leg.end_address, latitude: locations[i + 1].latitude, longitude: locations[i + 1].longitude },
        distance: leg.distance.text,
        duration: leg.duration.text,
        loadAfterStop: currentLoad
      });
    }
  });

  const decoded = polyline.decode(resp.data.routes[0].overview_polyline.points)
    .map(([lat, lng]) => ({ lat, lng }));
  const sampledCoords = sampleRoutePoints(decoded, 20);

  routeCache.set(key, { optimizedRoute, sampledCoords });
  return { optimizedRoute, sampledCoords };
}

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
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
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
function convertVehicleWeight(n = 0, u = "") {
  if (!n || !u) return 0;
  return u.toLowerCase() === "ton" ? n * 1000 : parseFloat(n);
}
function convertVehicleVolume(n = 0, u = "") {
  if (!n || !u) return 0;
  return u.toLowerCase().includes("m") ? parseFloat(n) : parseFloat(n) / 1000;
}
async function getLocationById(loc_ID) {
  const [rows] = await db.query(`
    SELECT latitude, longitude, loc_desc
    FROM master_locations WHERE loc_ID=?`, [loc_ID]);
  if (!rows.length) throw new Error(`Location not found: ${loc_ID}`);
  return {
    latitude: parseFloat(rows[0].latitude) || 0,
    longitude: parseFloat(rows[0].longitude) || 0,
    loc_desc: rows[0].loc_desc || ""
  };
}
function safeJsonParse(val, def = []) {
  if (typeof val === "string") {
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

/* ---------------- backtracking cost solver ---------------- */
// async function findMinCostArrangement(cluster, vehicles, sourceLoc) {
//   vehicles = vehicles.slice().sort((a,b)=>a.cost_per_ton - b.cost_per_ton);
//   let best = { cost: Infinity, allocations: [], unallocated: [] };

//   async function backtrack(rem, iVeh, used) {
//     if (!rem.length) {
//       const total = used.reduce((s,a)=>s+a.cost,0);
//       if (total < best.cost) {
//         best = { cost: total, allocations: JSON.parse(JSON.stringify(used)), unallocated: [] };
//       }
//       return;
//     }
//     if (iVeh >= vehicles.length) {
//       if (best.cost === Infinity) best.unallocated = rem.map(r=>r.pack_ID);
//       return;
//     }
//     const v = vehicles[iVeh], subsets = [];

//     function buildSub(idx, chosen, sumW, sumV, flags) {
//       if (idx === rem.length) {
//         subsets.push({ chosen, sumW, sumV, flags });
//         return;
//       }
//       buildSub(idx+1, chosen, sumW, sumV, flags);
//       const pkg = rem[idx];
//       const newW = sumW + pkg.totalWeight;
//       const newV = sumV + pkg.totalVolume;
//       if (newW <= v.weightCapKg && newV <= v.volumeCapM3) {
//         const nf = { ...flags };
//         nf.fragile   ||= pkg.specialFlags.fragile;
//         nf.dangerous ||= pkg.specialFlags.dangerous;
//         nf.hazardous ||= pkg.specialFlags.hazardous;
//         nf.tempCtrl  ||= pkg.specialFlags.tempCtrl;
//         if (checkPackageVehicleCompatibility(nf, getVehicleSpecialFlags(v))) {
//           buildSub(idx+1, [...chosen,pkg], newW,newV,nf);
//         }
//       }
//     }
//     buildSub(0, [], 0,0,{ fragile:0,dangerous:0,hazardous:0,tempCtrl:0 });

//     for (const {chosen,sumW} of subsets) {
//       if (!chosen.length) continue;
//       chosen.sort((a,b)=>a.distFromSource - b.distFromSource);
//       const locs = [sourceLoc, ...chosen.map(x=>x.destination)];
//       const shipments = new Array(chosen.length).fill(1);
//       const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(locs, shipments);
//       const totalDist = optimizedRoute.reduce((s,leg)=>s+parseDistanceText(leg.distance),0);
//       const tons = sumW/1000;
//       const cost = tons * v.cost_per_ton * totalDist;

//       const reversed = [...optimizedRoute].reverse();
//       let loadArr = [], remainIDs = chosen.map(x=>x.pack_ID);
//       reversed.forEach((leg,i)=>{
//         const stop = i+1, matches = [];
//         for (const id of remainIDs) {
//           const pObj = chosen.find(x=>x.pack_ID===id);
//           if (pObj &&
//               pObj.destination.latitude  === leg.end.latitude &&
//               pObj.destination.longitude === leg.end.longitude) {
//             matches.push(id);
//           }
//         }
//         if (matches.length) {
//           matches.forEach(m=>remainIDs.splice(remainIDs.indexOf(m),1));
//           loadArr.push({ stop, location: leg.end.address, packages: matches });
//         }
//       });

//       used.push({
//         vehicle_ID: v.vehicle_ID,
//         totalWeightCapacity: v.totalWeightCapacity,
//         totalVolumeCapacity: v.totalVolumeCapacity,
//         occupiedWeight: sumW,
//         occupiedVolume: chosen.reduce((s,p)=>s+p.totalVolume,0),
//         leftoverWeight: v.weightCapKg - sumW,
//         leftoverVolume: v.volumeCapM3 - chosen.reduce((s,p)=>s+p.totalVolume,0),
//         cost,
//         packages: chosen.map(x=>x.pack_ID),
//         route: optimizedRoute,
//         loadArrangement: loadArr,
//         sampledRoutePoints: sampledCoords
//       });
//       await backtrack(rem.filter(r=>!chosen.includes(r)), iVeh+1, used);
//       used.pop();
//     }

//     await backtrack(rem, iVeh+1, used);
//   }

//   await backtrack(cluster,0,[]);
//   return best.cost === Infinity
//     ? { cost: 0, allocations: [], unallocated: best.unallocated }
//     : best;
// }

async function findMinCostArrangement(cluster, vehicles, sourceLoc) {
  vehicles = vehicles.slice().sort((a, b) => a.cost_per_ton - b.cost_per_ton);
  let best = { cost: Infinity, allocations: [], unallocated: [] };

  async function backtrack(rem, iVeh, used) {
    if (!rem.length) {
      const total = used.reduce((s, a) => s + a.cost, 0);
      if (total < best.cost) {
        best = { cost: total, allocations: JSON.parse(JSON.stringify(used)), unallocated: [] };
      }
      return;
    }
    if (iVeh >= vehicles.length) {
      if (best.cost === Infinity) best.unallocated = rem.map(r => r.pack_ID);
      return;
    }

    const v = vehicles[iVeh], subsets = [];

    function buildSub(idx, chosen, sumW, sumV, flags) {
      if (idx === rem.length) {
        subsets.push({ chosen, sumW, sumV, flags });
        return;
      }
      buildSub(idx + 1, chosen, sumW, sumV, flags);
      const pkg = rem[idx];
      const newW = sumW + pkg.totalWeight;
      const newV = sumV + pkg.totalVolume;
      if (newW <= v.weightCapKg && newV <= v.volumeCapM3) {
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

      // ✅ FIXED: loadArrangement by forward stop sequence
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
  return best.cost === Infinity
    ? { cost: 0, allocations: [], unallocated: best.unallocated }
    : best;
}


function generateUnallocationReason(pkgInfo, vehicles) {
  if (!vehicles.length) return "No vehicles after filters.";
  const fleet = vehicles.map(getVehicleSpecialFlags);
  if (pkgInfo.specialFlags.tempCtrl && !fleet.some(v => v.temp_controlled_vehicle))
    return "Needs temperature-controlled truck.";
  if (pkgInfo.specialFlags.fragile && !fleet.some(v => v.fragile_vehicle))
    return "Needs fragile-goods truck.";
  if (pkgInfo.specialFlags.dangerous && !fleet.some(v => v.danger_proof))
    return "Needs dangerous-goods truck.";
  if (pkgInfo.specialFlags.hazardous && !fleet.some(v => v.hazardous_proof))
    return "Needs hazardous-goods truck.";

  const maxW = Math.max(...vehicles.map(v => v.weightCapKg));
  const maxV = Math.max(...vehicles.map(v => v.volumeCapM3));
  if (pkgInfo.totalWeight > maxW) return "Package too heavy for any truck.";
  if (pkgInfo.totalVolume > maxV) return "Package too large for any truck.";
  return "Could not allocate package.";
}

/* ---------------- allocation orchestration ---------------- */
// async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap) {
//   const allocations = [], unallocatedPackages = [];
//   let totalCost = 0;
//   const pkgInfos = [];

//   // build pkgInfos
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
//     const sumW = group.reduce((s,g)=>s+g.totalWeight,0);
//     const sumV = group.reduce((s,g)=>s+g.totalVolume,0);
//     const combinedFlags = group.reduce((f,g)=>({
//       fragile: f.fragile || g.specialFlags.fragile,
//       dangerous: f.dangerous || g.specialFlags.dangerous,
//       hazardous: f.hazardous || g.specialFlags.hazardous,
//       tempCtrl: f.tempCtrl || g.specialFlags.tempCtrl
//     }),{ fragile:0,dangerous:0,hazardous:0,tempCtrl:0 });

//     let feasible = vehicles.filter(v=>
//       v.weightCapKg >= sumW &&
//       v.usableVol     >= sumV &&
//       checkPackageVehicleCompatibility(combinedFlags, getVehicleSpecialFlags(v))
//     );

//     if (feasible.length) {
//       feasible.sort((a,b)=>a.cost_per_ton - b.cost_per_ton);
//       const chosen = feasible[0];

//       group.sort((a,b)=>a.distFromSource - b.distFromSource);
//       const routeLocs = [sourceLocation, ...group.map(g=>g.destination)];
//       const shipments = new Array(group.length).fill(1);
//       const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(routeLocs, shipments);

//       const totalDist = optimizedRoute.reduce((s,leg)=>s+parseDistanceText(leg.distance),0);
//       const tons = sumW/1000;
//       const cost = tons * chosen.cost_per_ton * totalDist;
//       totalCost += cost;

//       const reversed = [...optimizedRoute].reverse();
//       let loadArr = [], remainIDs = group.map(g=>g.pack_ID);
//       reversed.forEach((leg,i)=>{
//         const stop = i+1, using = [];
//         remainIDs.forEach(id=>{
//           const pkg = group.find(g=>g.pack_ID===id);
//           if (pkg &&
//               pkg.destination.latitude  === leg.end.latitude &&
//               pkg.destination.longitude === leg.end.longitude) {
//             using.push(id);
//           }
//         });
//         if (using.length) {
//           using.forEach(id=>remainIDs.splice(remainIDs.indexOf(id),1));
//           loadArr.push({ stop, location: leg.end.address, packages: using });
//         }
//       });

//       const pkgVolumes = group.map(g=>g.totalVolume);

//       allocations.push({
//         vehicle_ID: chosen.vehicle_ID,
//         totalWeightCapacity: chosen.totalWeightCapacity,
//         totalVolumeCapacity: chosen.totalVolumeCapacity,
//         occupiedWeight: sumW,
//         occupiedVolume: group.reduce((s,g)=>s+g.totalVolume,0),
//         leftoverWeight: chosen.weightCapKg - sumW,
//         leftoverVolume: chosen.volumeCapM3 - group.reduce((s,g)=>s+g.totalVolume,0),
//         cost,
//         packages: group.map(g=>g.pack_ID),
//         pkgVolumes,
//         route: optimizedRoute,
//         loadArrangement: loadArr,
//         sampledRoutePoints: sampledCoords
//       });
//     } else {
//       const { cost, allocations: subAllocs, unallocated } =
//         await findMinCostArrangement(group, vehicles, sourceLocation);
//       totalCost += cost;
//       allocations.push(...subAllocs);
//       unallocated.forEach(id => {
//         const info = pkgInfos.find(p=>p.pack_ID===id);
//         unallocatedPackages.push({
//           pack_ID: id,
//           reason: generateUnallocationReason(info, vehicles)
//         });
//       });
//     }
//   }

//   return { allocations, totalCost, unallocated: unallocatedPackages };
// }

async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap) {
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
      const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(routeLocs, shipments);

      const totalDist = optimizedRoute.reduce((s, leg) => s + parseDistanceText(leg.distance), 0);
      const tons = sumW / 1000;
      const cost = tons * chosen.cost_per_ton * totalDist;
      totalCost += cost;

      // ✅ FIXED: forward route-based loadArrangement
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

      const pkgVolumes = group.map(g => g.totalVolume);

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
        pkgVolumes,
        route: optimizedRoute,
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


async function getPackagesByIds(packageIDs) {
  const ph = packageIDs.map(_ => '?').join(',');
  const [rows] = await db.query(`
    SELECT * FROM packages WHERE pack_ID IN (${ph})`, packageIDs);
  if (!rows.length) throw new Error(`No matching packages`);
  return rows.map(r => ({
    pack_ID: r.pack_ID,
    ship_from: r.ship_from,
    ship_to: r.ship_to,
    products: safeJsonParse(r.product_ID),
    pickup_date_time: r.pickup_date_time
  }));
}

/* ------------------- dimension + 3D placement ------------------- */
function parseDimension(str = '') {
  const m = String(str).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  return /cm/i.test(str) ? val / 100 : val;
}



  // function computeBoxPlacements(packages, truckDimensions) {
  //   const placements = [];

  //   const truckLength = truckDimensions.interiorLengthM;
  //   const truckWidth = truckDimensions.interiorWidthM;
  //   const truckHeight = truckDimensions.interiorHeightM;

  //   const gridUnit = 0.1; // 10cm grid granularity
  //   const gridCols = Math.floor(truckLength / gridUnit);
  //   const gridRows = Math.floor(truckWidth / gridUnit);

  //   // Track used height and stacking count at each (x,z) cell
  //   const heightMap = Array.from({ length: gridCols }, () =>
  //     Array.from({ length: gridRows }, () => ({ height: 0, stackCount: 0 }))
  //   );

  //   // Sort by stop in FILO (last stop first)
  //   packages.sort((a, b) => b.stop - a.stop);

  //   for (const pkg of packages) {
  //     const [boxLength, boxHeight, boxWidth] = pkg.dimensions;
  //     const stackLimit = pkg.stacking_factor || 0;

  //     const gridBoxL = Math.ceil(boxLength / gridUnit);
  //     const gridBoxW = Math.ceil(boxWidth / gridUnit);

  //     let placed = false;

  //     for (let x = 0; x <= gridCols - gridBoxL; x++) {
  //       for (let z = 0; z <= gridRows - gridBoxW; z++) {
  //         let canPlace = true;
  //         let maxHeight = 0;
  //         let maxStack = 0;

  //         for (let i = 0; i < gridBoxL && canPlace; i++) {
  //           for (let j = 0; j < gridBoxW && canPlace; j++) {
  //             const cell = heightMap[x + i][z + j];
  //             if (cell.height + boxHeight > truckHeight) canPlace = false;
  //             if (cell.stackCount >= stackLimit + 1) canPlace = false;
  //             maxHeight = Math.max(maxHeight, cell.height);
  //             maxStack = Math.max(maxStack, cell.stackCount);
  //           }
  //         }

  //         if (canPlace) {
  //           // Mark cells as used
  //           for (let i = 0; i < gridBoxL; i++) {
  //             for (let j = 0; j < gridBoxW; j++) {
  //               const cell = heightMap[x + i][z + j];
  //               cell.height = maxHeight + boxHeight;
  //               cell.stackCount = maxStack + 1;
  //             }
  //           }

  //           // Save placement
  //           placements.push({
  //             pkg_ID: pkg.pkg_ID,
  //             color: pkg.color || '#ccc',
  //             position: [
  //               x * gridUnit,       // X (length)
  //               maxHeight,          // Y (height)
  //               z * gridUnit        // Z (width)
  //             ],
  //             dimensions: [boxLength, boxHeight, boxWidth]
  //           });

  //           placed = true;
  //           break;
  //         }
  //       }
  //       if (placed) break;
  //     }

  //     if (!placed) {
  //       console.warn(`Box from ${pkg.pkg_ID} could not be placed.`);
  //     }
  //   }

  //   return placements;
  // }

  function computeBoxPlacements(loadArrangement, packageInfoDetails, vehicleDimensions) {
    const placements = [];
  
    const truckLength = vehicleDimensions.interiorLengthM;
    const truckWidth = vehicleDimensions.interiorWidthM;
    const truckHeight = vehicleDimensions.interiorHeightM;
  
    const gridUnit = 0.1; // 10cm resolution
    const gridCols = Math.floor(truckLength / gridUnit);
    const gridRows = Math.floor(truckWidth / gridUnit);
  
    // Track used height and stacking count at each (x,z) cell
    const heightMap = Array.from({ length: gridCols }, () =>
      Array.from({ length: gridRows }, () => ({ height: 0, stackCount: 0 }))
    );
  
    // Assign colors per pkg_ID
    const pkgColorMap = {};
    const colorPalette = [
      "#10b981", "#3b82f6", "#f59e0b", "#ef4444",
      "#8b5cf6", "#ec4899", "#14b8a6", "#f43f5e",
      "#0ea5e9", "#6366f1", "#22c55e"
    ];
    let colorIndex = 0;
    function getColor(pkg_ID) {
      if (!pkgColorMap[pkg_ID]) {
        pkgColorMap[pkg_ID] = colorPalette[colorIndex % colorPalette.length];
        colorIndex++;
      }
      return pkgColorMap[pkg_ID];
    }
  
    // Flatten boxes in FILO stop order
    const allBoxes = [];
    for (let i = loadArrangement.length - 1; i >= 0; i--) {
      const { stop, packages } = loadArrangement[i];
      for (const pkg_ID of packages) {
        const pkg = packageInfoDetails.find(p => p.pkg_ID === pkg_ID);
        if (!pkg) continue;
  
        for (const line of pkg.lines) {
          const { packagingDimensions: dims, quantity } = line;
          const sf = +line.package_info?.stacking_factor || 0;
  
          for (let q = 0; q < quantity; q++) {
            allBoxes.push({
              pkg_ID,
              stop,
              color: getColor(pkg_ID),
              length: dims.lengthM,
              width: dims.widthM,
              height: dims.heightM,
              stacking_factor: sf
            });
          }
        }
      }
    }
  
    // Placement logic
    let truckX = 0, truckY = 0, truckZ = 0;
    let rowHeight = 0;
  
    for (const box of allBoxes) {
      const { length, width, height, stacking_factor } = box;
  
      const gridBoxL = Math.ceil(length / gridUnit);
      const gridBoxW = Math.ceil(width / gridUnit);
  
      let placed = false;
  
      for (let x = 0; x <= gridCols - gridBoxL && !placed; x++) {
        for (let z = 0; z <= gridRows - gridBoxW && !placed; z++) {
          let canPlace = true;
          let maxHeight = 0;
          let maxStack = 0;
  
          for (let i = 0; i < gridBoxL && canPlace; i++) {
            for (let j = 0; j < gridBoxW && canPlace; j++) {
              const cell = heightMap[x + i][z + j];
              if (cell.height + height > truckHeight) canPlace = false;
              if (cell.stackCount >= stacking_factor + 1) canPlace = false;
              maxHeight = Math.max(maxHeight, cell.height);
              maxStack = Math.max(maxStack, cell.stackCount);
            }
          }
  
          if (canPlace) {
            for (let i = 0; i < gridBoxL; i++) {
              for (let j = 0; j < gridBoxW; j++) {
                const cell = heightMap[x + i][z + j];
                cell.height = maxHeight + height;
                cell.stackCount = maxStack + 1;
              }
            }
  
            placements.push({
              pkg_ID: box.pkg_ID,
              color: box.color,
              position: [
                x * gridUnit,
                maxHeight,
                z * gridUnit
              ],
              dimensions: [length, height, width]
            });
  
            placed = true;
          }
        }
      }
  
      if (!placed) {
        console.warn(`Box from ${box.pkg_ID} at stop ${box.stop} could not be placed`);
      }
    }
  
    return placements;
  }
  



function generatePackageBlocks(boxPlacements) {
  const colorPalette = [
    "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
    "#14b8a6", "#f43f5e", "#0ea5e9", "#6366f1", "#22c55e"
  ];
  const colorMap = {};
  let colorIndex = 0;
  const blocks = [];

  boxPlacements.forEach(box => {
    const { pkg_ID } = box;
    if (!colorMap[pkg_ID]) {
      colorMap[pkg_ID] = colorPalette[colorIndex % colorPalette.length];
      colorIndex++;
    }
    blocks.push({
      ...box,
      color: colorMap[pkg_ID]
    });
  });

  return blocks;
}



/* -------------------------- ROUTES --------------------------- */
router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { packages: packageIDs, filters } = req.body;
    if (!packageIDs?.length) return res.status(400).json({ error: 'No packages provided.' });

    // 1) fetch packages & validate same origin/date
    const packagesData = await getPackagesByIds(packageIDs);
    const origin = packagesData[0].ship_from;
    const pickupDate = packagesData[0].pickup_date_time.split('T')[0];
    packagesData.forEach(p => {
      if (p.ship_from !== origin) throw new Error('All packages must share ship_from');
      if (p.pickup_date_time.split('T')[0] !== pickupDate)
        throw new Error('All packages must share pickup date');
    });

    // 2) build productMap BEFORE needing any pac_IDs
    const allLines = packagesData.flatMap(p => p.products || []);
    const prodIDs = [...new Set(allLines.map(l => l.prod_ID))];
    if (!prodIDs.length)
      return res.status(400).json({ error: 'No product lines in packages' });

    const [prodRows] = await db.query(
      `SELECT product_ID, weight, weight_uom, volume, volume_uom,
              fragile_goods, dangerous_goods, hazardous, temp_controlled,
              packaging_type, COALESCE(stacking_factor,'0') AS stacking_factor
       FROM master_products WHERE product_ID IN (?)`,
      [prodIDs]
    );
    const productMap = prodRows.reduce((m, r) => (m[r.product_ID] = r, m), {});

    // stacking-factor uniformity
    const sfSet = new Set(allLines.map(l => +productMap[l.prod_ID]?.stacking_factor || 0));
    if (sfSet.size !== 1) {
      return res.status(400).json({
        error: `Stacking-factor mismatch: [${[...sfSet].join(', ')}]`
      });
    }
    const productStackFactor = [...sfSet][0];

    // 3) collect ALL pac_IDs & load packagingInfo once
    const allPacIDs = collectAllPacIDs(packagesData, productMap);
    const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

    // determine tallest package height
    const heights = allLines.map(l => {
      const prod = productMap[l.prod_ID];
      const pacIds = resolvePacIdsFromProduct(prod);
      const info = pacIds[0] ? packagingInfoMap[pacIds[0]] : null;
      return info
        ? parseDimension(`${info.pack_height} ${info.dimensions_uom}`)
        : 0;
    }).filter(Boolean);
    const maxPkgH = heights.length ? Math.max(...heights) : 0;

    // 4) load vehicles & compute usable volume
    const [dbVehicles] = await db.query(
      `SELECT * FROM master_resources WHERE JSON_CONTAINS(loc_ID, ?)`,
      [JSON.stringify(origin)]
    );
    let fleet = dbVehicles.map(v => {
      const caps = safeJsonParse(v.capacity, {});
      const rawVol = parseVolumeAndUOM(caps.cubic_capacity, caps.cubic_capacity_unit);
      const W = parseDimension(caps.interior_width);
      const L = parseDimension(caps.interior_length);
      const H = parseDimension(caps.interior_height);
      const floorArea = W * L;

      const maxLayers = maxPkgH > 0 ? Math.floor(H / maxPkgH) : 0;
      const allowedLayers = productStackFactor === 0
        ? maxLayers
        : Math.min(maxLayers, productStackFactor);
      const oneLayerM3 = maxPkgH > 0 ? floorArea * maxPkgH : 0;
      const usableVol = oneLayerM3 * allowedLayers;

      const weightCapKg = parseWeightAndUOM(caps.payload_weight, caps.payload_weight_unit);

      return {
        ...v,
        transportation_details: safeJsonParse(v.transportation_details, {}),
        downtimes: safeJsonParse(v.downtimes, {}),
        capacity: caps,
        weightCapKg,
        totalWeightCapacity: weightCapKg,
        totalVolumeCapacity: rawVol,
        oneLayerM3,
        usableVol,
        volumeCapM3: usableVol,
        maxLayers,
        allowedLayers,
        cost_per_ton: +safeJsonParse(v.additional_details, {}).cost_per_ton || 0
      };
    });

    // 5) filters & sorts
    const now = Date.now();
    if (filters?.checkValidity) fleet = fleet.filter(isVehicleValid);
    if (filters?.checkDowntime) fleet = fleet.filter(v => !isVehicleDown(v));
    if (filters?.sortUnlimitedUsage) fleet.sort((a, b) => (a.unlimited_usage || 0) - (b.unlimited_usage || 0));
    if (filters?.sortOwnership) fleet.sort((a, b) => (a.individual_resource || '').localeCompare(b.individual_resource || ''));
    fleet.sort((a, b) => a.cost_per_ton - b.cost_per_ton);

    // 6) origin coords
    const sourceLoc = await getLocationById(origin);

    // 7) allocate packages
    const { allocations, totalCost, unallocated } = await allocatePackages(
      packagesData, fleet, sourceLoc, productMap, packagingInfoMap
    );

    // 8) enrich allocations for response
    const enriched = allocations.map(a => {
      const v = fleet.find(x => x.vehicle_ID === a.vehicle_ID) || {};
      const caps = v.capacity || {};
      const usable = v.usableVol || v.totalVolumeCapacity;
      const occupied = a.occupiedVolume;
      const occupiedPercent = usable > 0 ? +(occupied / usable * 100).toFixed(2) : 0;

      const widthM = parseDimension(caps.interior_width);
      const lengthM = parseDimension(caps.interior_length);
      const heightM = parseDimension(caps.interior_height);

      // per-package product lines
      const packageInfoDetails = a.packages.map(pkgID => {
        const pkgRecord = packagesData.find(p => p.pack_ID === pkgID);
        const lines = (pkgRecord?.products || []).map(line => {
          const prod = productMap[line.prod_ID];
          const pacIds = resolvePacIdsFromProduct(prod);
          const firstPac = pacIds[0] || null;
          const packInfo = firstPac ? packagingInfoMap[firstPac] : null;
          return {
            prod_ID: line.prod_ID,
            quantity: line.quantity,
            pac_ID: firstPac,
            package_info: packInfo,
            packagingDimensions: packInfo ? {
              lengthM: parseDimension(`${packInfo.pack_length} ${packInfo.dimensions_uom}`),
              widthM: parseDimension(`${packInfo.pack_width}  ${packInfo.dimensions_uom}`),
              heightM: parseDimension(`${packInfo.pack_height} ${packInfo.dimensions_uom}`)
            } : null
          };
        });
        return { pkg_ID: pkgID, lines };
      });

      // per-package volume %ages
      const packageDetails = a.packages.map((pkgID, idx) => {
        const vol = (a.pkgVolumes && a.pkgVolumes[idx]) || 0;
        const pct = usable > 0 ? +(vol / usable * 100).toFixed(2) : 0;
        return { pkg_ID: pkgID, volumeM3: vol, percentOfTruck: pct };
      });


      const boxesToPlace = [];

      a.packages.forEach(pkgID => {
        const pkgRecord = packagesData.find(p => p.pack_ID === pkgID);
        const stop = a.loadArrangement.find(x => x.packages.includes(pkgID))?.stop || 1;
        const stackFactor = productStackFactor;

        (pkgRecord?.products || []).forEach(line => {
          const prod = productMap[line.prod_ID];
          const pacIds = resolvePacIdsFromProduct(prod);
          const info = pacIds[0] ? packagingInfoMap[pacIds[0]] : null;
          if (!info) return;
          const L = parseDimension(`${info.pack_length} ${info.dimensions_uom}`);
          const W = parseDimension(`${info.pack_width}  ${info.dimensions_uom}`);
          const H = parseDimension(`${info.pack_height} ${info.dimensions_uom}`);
          for (let i = 0; i < line.quantity; i++) {
            boxesToPlace.push({
              pkg_ID: pkgID,
              dimensions: [L, H, W],
              stacking_factor: stackFactor,
              stop
            });
          }
        });
      });

      const vehicleDims = {
        interiorWidthM: widthM,
        interiorLengthM: lengthM,
        interiorHeightM: heightM
      };

      // const boxPlacements = computeBoxPlacements(boxesToPlace, vehicleDims);

      const packagesByStop = {};
      boxesToPlace.forEach(box => {
        const stop = box.stop;
        if (!packagesByStop[stop]) packagesByStop[stop] = [];
        packagesByStop[stop].push(box);
      });
      // const rawPlacements = computeBoxPlacements(boxesToPlace, vehicleDims);
      const rawPlacements = computeBoxPlacements(a.loadArrangement, packageInfoDetails, vehicleDims);

      
      const boxPlacements = generatePackageBlocks(rawPlacements);





      return {
        ...a,
        boxPlacements,
        vehicleDimensions: { interiorWidthM: widthM, interiorLengthM: lengthM, interiorHeightM: heightM },
        packageInfoDetails,
        occupiedPercent,
        packageDetails,
        truckCapacity: {
          rawM3: v.totalVolumeCapacity,
          oneLayerM3: v.oneLayerM3,
          usableM3: v.usableVol,
          maxLayers: v.maxLayers,
          allowedLayers: v.allowedLayers
        }
      };
    });

    return res.status(200).json({
      message: enriched.length ? 'Best Combinational Scenario' : 'No suitable vehicles found',
      totalCost: enriched.length ? totalCost : null,
      allocations: enriched,
      unallocatedPackages: unallocated
    });


  } catch (err) {
    logger.error('Error creating order:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/sample-route', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { locations } = req.body;
    if (!Array.isArray(locations) || locations.length < 2) {
      return res.status(400).json({ error: 'Provide at least origin and destination.' });
    }
    const origin = locations[0];
    const dest = locations[locations.length - 1];
    const waypoints = locations.length > 2
      ? locations.slice(1, -1).map(l => `${l.latitude},${l.longitude}`).join('|')
      : '';
    const url =
      `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}` +
      `&destination=${dest.latitude},${dest.longitude}` +
      (waypoints ? `&waypoints=${waypoints}` : '') +
      `&key=${GOOGLE_API_KEY}`;

    const resp = await axios.get(url);
    if (resp.data.status !== 'OK') {
      return res.status(502).json({ error: `Google API: ${resp.data.status}` });
    }
    const decoded = polyline.decode(resp.data.routes[0].overview_polyline.points)
      .map(([lat, lng]) => ({ lat, lng }));
    const sampledRoutePoints = sampleRoutePoints(decoded, 20);
    return res.status(200).json({ sampledRoutePoints });
  } catch (err) {
    logger.error('Error sampling route:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
