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

function buildRouteKey(locations) {
  return locations.map(loc => `${loc.latitude},${loc.longitude}`).join('|');
}

function toRadians(deg) {
  return deg * Math.PI / 180;
}

function distanceBetweenCoords(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
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

// parse "123 km" → 123
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
    // adjust loads
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
        end:   { address: leg.end_address,   latitude: locations[i+1].latitude, longitude: locations[i+1].longitude },
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
  let brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return brng;
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
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  let iA = dirs.indexOf(a), iB = dirs.indexOf(b);
  if (iA<0||iB<0) return false;
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
        to   = new Date(v.transportation_details.validity_to);
  return t >= from && t <= to;
}

function isVehicleDown(v) {
  if (!v.downtimes.downtime_starts_from) return false;
  const now = new Date(),
        s = new Date(v.downtimes.downtime_starts_from),
        e = new Date(v.downtimes.downtime_ends_from);
  return now >= s && now <= e;
}

function convertVehicleWeight(n=0, u="") {
  if (!n||!u) return 0;
  return u.toLowerCase()==="ton"? n*1000 : parseFloat(n);
}

function convertVehicleVolume(n=0, u="") {
  if (!n||!u) return 0;
  return u.toLowerCase().includes("m")? parseFloat(n) : parseFloat(n)/1000;
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

function safeJsonParse(val, def=[]) {
  if (typeof val === "string") {
    try { return JSON.parse(val); }
    catch { return def; }
  }
  return val||def;
}

function getPackageSpecialFlags(pkg, productMap) {
  let f=0,d=0,h=0,t=0;
  for (let pr of pkg.products) {
    const info = productMap[pr.prod_ID];
    if (!info) continue;
    if (info.fragile_goods) f=1;
    if (info.dangerous_goods) d=1;
    if (info.hazardous) h=1;
    if (info.temp_controlled) t=1;
  }
  return { fragile:f, dangerous:d, hazardous:h, tempCtrl:t };
}

function getVehicleSpecialFlags(v) {
  return {
    fragile_vehicle: v.fragile_vehicle||0,
    danger_proof:    v.danger_proof   ||0,
    hazardous_proof: v.hazardous_proof||0,
    temp_controlled_vehicle: v.temp_controlled_vehicle||0
  };
}


function checkPackageVehicleCompatibility(pkgF, vehF) {
  const pkgIsNormal =
    !pkgF.fragile &&
    !pkgF.dangerous &&
    !pkgF.hazardous &&
    !pkgF.tempCtrl;

  if (pkgIsNormal) {
    const vehIsNormal =
      !vehF.fragile_vehicle &&
      !vehF.danger_proof &&
      !vehF.hazardous_proof &&
      !vehF.temp_controlled_vehicle;
    return vehIsNormal;
  }

  if (pkgF.fragile   && !vehF.fragile_vehicle)        return false;
  if (pkgF.dangerous && !vehF.danger_proof)            return false;
  if (pkgF.hazardous && !vehF.hazardous_proof)         return false;
  if (pkgF.tempCtrl  && !vehF.temp_controlled_vehicle) return false;

  return true;
}



async function loadAllPackageInfo(pacIDs) {
  if (!pacIDs.length) return {};
  const ph = pacIDs.map(_=>'?').join(',');
  const [rows] = await db.query(`
    SELECT * FROM master_package_info WHERE pac_ID IN (${ph})`, pacIDs);
  return rows.reduce((m,r)=>{ m[r.pac_ID]=r; return m; }, {});
}

function collectAllPacIDs(packagesData, productMap) {
  const set = new Set();
  for (let pkg of packagesData) {
    for (let pr of pkg.products) {
      const info = productMap[pr.prod_ID];
      if (!info) continue;
      let arr = info.packaging_type;
      if (typeof arr === "string") arr = JSON.parse(arr);
      if (Array.isArray(arr) && arr[0]) set.add(arr[0].pac_ID);
    }
  }
  return Array.from(set);
}

// async function sumPackageWeightVolume(pkg, productMap, packagingInfoMap) {
//   let w = 0, v = 0;
//   for (let pr of pkg.products) {
//     const info = productMap[pr.prod_ID];
//     if (!info) continue;
//     const unitWeight = parseWeightAndUOM(info.weight, info.weight_uom) * pr.quantity;
//     w += unitWeight;
//     let arr = info.packaging_type;
//     if (typeof arr === "string") arr = JSON.parse(arr);
//     if (!arr || !arr[0]) continue;
//     const pacID = arr[0].pac_ID;
//     const row = packagingInfoMap[pacID];
//     if (!row) continue;
//     v += parseVolumeAndUOM(row.pack_volume, row.pack_volume_uom) * pr.quantity;
//   }
//   return { totalW: w, totalV: v };
// }

async function sumPackageWeightVolume(pkg, productMap, pkgInfoMap) {
  let totalW = 0, totalV = 0;
  for (let pr of pkg.products) {
    const prod = productMap[pr.prod_ID];
    if (!prod) continue;
    totalW += parseWeightAndUOM(prod.weight, prod.weight_uom) * pr.quantity;
    const pacID = (Array.isArray(prod.packaging_type) && prod.packaging_type[0]?.pac_ID);
    if (pacID && pkgInfoMap[pacID]) {
      totalV += parseVolumeAndUOM(pkgInfoMap[pacID].pack_volume, pkgInfoMap[pacID].pack_volume_uom) * pr.quantity;
    }
  }
  return { totalW, totalV };
}

async function findMinCostArrangement(cluster, vehicles, sourceLoc) {
  vehicles = vehicles.slice().sort((a,b)=> a.cost_per_ton - b.cost_per_ton);
  let best = { cost: Infinity, allocations: [], unallocated: [] };

  async function backtrack(rem, iVeh, used) {
    if (!rem.length) {
      const total = used.reduce((s,a)=> s + a.cost, 0);
      if (total < best.cost) {
        best = { cost: total, allocations: JSON.parse(JSON.stringify(used)), unallocated: [] };
      }
      return;
    }
    if (iVeh >= vehicles.length) {
      if (best.cost === Infinity) best.unallocated = rem.map(r=>r.pack_ID);
      return;
    }
    const v = vehicles[iVeh], subsets = [];

    // build all subsets that fit
    function buildSub(idx, chosen, sumW, sumV, flags) {
      if (idx === rem.length) {
        subsets.push({ chosen, sumW, sumV, flags });
        return;
      }
      buildSub(idx+1, chosen, sumW, sumV, flags);
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
          buildSub(idx+1, [...chosen, pkg], newW, newV, nf);
        }
      }
    }

    buildSub(0, [], 0, 0, { fragile:0, dangerous:0, hazardous:0, tempCtrl:0 });

    for (let { chosen, sumW } of subsets) {
      if (!chosen.length) continue;
      // sort by distance
      chosen.sort((a,b)=> a.distFromSource - b.distFromSource);
      const locs = [sourceLoc, ...chosen.map(x=>x.destination)];
      const shipments = new Array(chosen.length).fill(1);
      const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(locs, shipments);

      // total distance of this optimizedRoute
      const totalDist = optimizedRoute.reduce((s,leg)=> s + parseDistanceText(leg.distance), 0);
      const tons = sumW / 1000;
      const cost = tons * v.cost_per_ton * totalDist;

      const reversed = [...optimizedRoute].reverse();
      let loadArr = [], remainIDs = chosen.map(x=>x.pack_ID);
      reversed.forEach((leg,i)=> {
        const stop = i+1, matches = [];
        for (let id of remainIDs) {
          const pObj = chosen.find(x=>x.pack_ID === id);
          if (pObj &&
              pObj.destination.latitude === leg.end.latitude &&
              pObj.destination.longitude === leg.end.longitude) {
            matches.push(id);
          }
        }
        if (matches.length) {
          matches.forEach(m=> remainIDs.splice(remainIDs.indexOf(m),1));
          loadArr.push({ stop, location: leg.end.address, packages: matches });
        }
      });

      used.push({
        vehicle_ID: v.vehicle_ID,
        totalWeightCapacity: v.totalWeightCapacity,
        totalVolumeCapacity: v.totalVolumeCapacity,
        occupiedWeight: sumW,
        occupiedVolume: chosen.reduce((s,p)=> s + p.totalVolume, 0),
        leftoverWeight: v.weightCapKg - sumW,
        leftoverVolume: v.volumeCapM3 - chosen.reduce((s,p)=> s + p.totalVolume, 0),
        cost,
        packages: chosen.map(x=> x.pack_ID),
        route: optimizedRoute,
        loadArrangement: loadArr,
        sampledRoutePoints: sampledCoords
      });

      await backtrack(rem.filter(r=> !chosen.includes(r)), iVeh+1, used);
      used.pop();
    }

    // also try skipping this vehicle
    await backtrack(rem, iVeh+1, used);
  }

  await backtrack(cluster, 0, []);
  return best.cost === Infinity
    ? { cost: 0, allocations: [], unallocated: best.unallocated }
    : best;
}

function generateUnallocationReason(pkgInfo, vehicles) {
  if (!vehicles.length) return "No vehicles after filters.";
  const fleet = vehicles.map(getVehicleSpecialFlags);
  if (pkgInfo.specialFlags.tempCtrl &&
      !fleet.some(v=>v.temp_controlled_vehicle))
    return "Needs temperature-controlled truck.";
  if (pkgInfo.specialFlags.fragile &&
      !fleet.some(v=>v.fragile_vehicle))
    return "Needs fragile-goods truck.";
  if (pkgInfo.specialFlags.dangerous &&
      !fleet.some(v=>v.danger_proof))
    return "Needs dangerous-goods truck.";
  if (pkgInfo.specialFlags.hazardous &&
      !fleet.some(v=>v.hazardous_proof))
    return "Needs hazardous-goods truck.";

  const maxW = Math.max(...vehicles.map(v=>v.weightCapKg));
  const maxV = Math.max(...vehicles.map(v=>v.volumeCapM3));
  if (pkgInfo.totalWeight > maxW)
    return "Package too heavy for any truck.";
  if (pkgInfo.totalVolume > maxV)
    return "Package too large for any truck.";
  return "Could not allocate package.";
}

async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap) {
  const allocations = [], unallocatedPackages = [];
  let totalCost = 0;
  const pkgInfos = [];

  // build pkgInfos
  for (let pkg of packagesData) {
    const { totalW, totalV } = await sumPackageWeightVolume(pkg, productMap, packagingInfoMap);
    const destLoc = await getLocationById(pkg.ship_to);
    const bearing = getBearing(
      sourceLocation.latitude, sourceLocation.longitude,
      destLoc.latitude, destLoc.longitude
    );
    const dir8 = getDirection8(bearing);
    const distKM = distanceBetweenCoords(
      sourceLocation.latitude, sourceLocation.longitude,
      destLoc.latitude, destLoc.longitude
    );
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

  // group and process
  const groups = groupPackagesByDirection(pkgInfos);
  for (let group of groups) {
    const sumW = group.reduce((s, g)=> s + g.totalWeight, 0);
    const sumV = group.reduce((s, g)=> s + g.totalVolume, 0);
    const combinedFlags = group.reduce((f,g)=> ({
      fragile: f.fragile||g.specialFlags.fragile,
      dangerous: f.dangerous||g.specialFlags.dangerous,
      hazardous: f.hazardous||g.specialFlags.hazardous,
      tempCtrl: f.tempCtrl||g.specialFlags.tempCtrl
    }), {fragile:0,dangerous:0,hazardous:0,tempCtrl:0});

    let feasible = vehicles.filter(v =>
      v.weightCapKg >= sumW &&
      v.usableVol    >= sumV &&               // ← usable volume
      checkPackageVehicleCompatibility(combinedFlags, getVehicleSpecialFlags(v))
    );

    if (feasible.length) {
      feasible.sort((a,b)=> a.cost_per_ton - b.cost_per_ton);
      const chosen = feasible[0];
      // route
      group.sort((a,b)=> a.distFromSource - b.distFromSource);
      const routeLocs = [sourceLocation, ...group.map(g=>g.destination)];
      const shipments = new Array(group.length).fill(1);
      const { optimizedRoute, sampledCoords } = await getOptimizedRouteWithLoad(routeLocs, shipments);

      // total distance
      const totalDist = optimizedRoute.reduce((s,leg)=> s + parseDistanceText(leg.distance), 0);
      const tons = sumW / 1000;
      const cost = tons * chosen.cost_per_ton * totalDist;
      totalCost += cost;

      // load arrangement
      const reversed = [...optimizedRoute].reverse();
      let loadArr = [], remainIDs = group.map(g=>g.pack_ID);
      reversed.forEach((leg,i)=> {
        const stop = i+1, using = [];
        remainIDs.forEach(id => {
          const pkg = group.find(g=>g.pack_ID === id);
          if (pkg &&
              pkg.destination.latitude === leg.end.latitude &&
              pkg.destination.longitude === leg.end.longitude) {
            using.push(id);
          }
        });
        if (using.length) {
          using.forEach(id=> remainIDs.splice(remainIDs.indexOf(id),1));
          loadArr.push({ stop, location: leg.end.address, packages: using });
        }
      });

      allocations.push({
        vehicle_ID: chosen.vehicle_ID,
        totalWeightCapacity: chosen.totalWeightCapacity,
        totalVolumeCapacity: chosen.totalVolumeCapacity,
        occupiedWeight: sumW,
        occupiedVolume: group.reduce((s,g)=> s+g.totalVolume, 0),
        leftoverWeight: chosen.weightCapKg - sumW,
        leftoverVolume: chosen.volumeCapM3 - group.reduce((s,g)=> s+g.totalVolume, 0),
        cost,
        packages: group.map(g=>g.pack_ID),
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
        const info = pkgInfos.find(p=>p.pack_ID===id);
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
  const ph = packageIDs.map(_=>'?').join(',');
  const [rows] = await db.query(`
    SELECT * FROM packages WHERE pack_ID IN (${ph})`, packageIDs);
  if (!rows.length) throw new Error(`No matching packages`);
  return rows.map(r=>({
    pack_ID: r.pack_ID,
    ship_from: r.ship_from,
    ship_to: r.ship_to,
    products: safeJsonParse(r.product_ID),
    pickup_date_time: r.pickup_date_time
  }));
}

// router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { packages: packageIDs, filters } = req.body;
//     if (!Array.isArray(packageIDs) || !packageIDs.length) {
//       return res.status(400).json({ error: 'No packages provided' });
//     }

//     const packagesData = await getPackagesByIds(packageIDs);
//     if (!packagesData.length) {
//       return res.status(400).json({ error: 'No valid packages found' });
//     }

//     // all ship_from same and same pickup date
//     const firstFrom = packagesData[0].ship_from;
//     const firstDate = packagesData[0].pickup_date_time.split('T')[0];
//     for (let pkg of packagesData) {
//       if (pkg.ship_from !== firstFrom) {
//         return res.status(400).json({ error: 'All packages must share ship_from' });
//       }
//       if (pkg.pickup_date_time.split('T')[0] !== firstDate) {
//         return res.status(400).json({ error: 'All packages must share pickup date' });
//       }
//     }

//         // 3) Stacking-factor uniformity check
//         const allProdLines = packagesData.flatMap(p => p.products || []);
//         const allProdIDs   = [...new Set(allProdLines.map(p => p.prod_ID))];
//         if (!allProdIDs.length) {
//           return res.status(400).json({ error: 'No products in packages' });
//         }
    
//         const [stackRows] = await db.query(
//           `SELECT product_ID, COALESCE(stacking_factor, '0') AS stacking_factor
//              FROM master_products
//             WHERE product_ID IN (?)`,
//           [allProdIDs]
//         );
//         const stackMap = {};
//         stackRows.forEach(r => { stackMap[r.product_ID] = r.stacking_factor; });
    
//         const factorSet = new Set(
//           allProdLines.map(p => stackMap[p.prod_ID] || '0')
//         );
//         if (factorSet.size !== 1) {
//           return res.status(400).json({
//             error: `Stacking-factor mismatch—found [${[...factorSet].join(', ')}]`
//           });
//         }

//         const sfValue = parseInt([...factorSet][0], 10) || 0;

//     // load products
//     const prodLines = packagesData.flatMap(p => p.products);
//     const prodIDs = prodLines.map(p => p.prod_ID);
//     if (!prodIDs.length) {
//       return res.status(400).json({ error: 'No product lines in packages' });
//     }
//     const ph = prodIDs.map(_=>'?').join(',');
//     const [pRows] = await db.query(`
//       SELECT product_ID, weight, weight_uom, volume, volume_uom,
//              fragile_goods, dangerous_goods, hazardous, temp_controlled, packaging_type
//       FROM master_products WHERE product_ID IN (${ph})
//     `, prodIDs);
//     const productMap = {};
//     pRows.forEach(r => {
//       productMap[r.product_ID] = {
//         weight: r.weight, weight_uom: r.weight_uom,
//         volume: r.volume, volume_uom: r.volume_uom,
//         fragile_goods: r.fragile_goods,
//         dangerous_goods: r.dangerous_goods,
//         hazardous: r.hazardous,
//         temp_controlled: r.temp_controlled,
//         packaging_type: r.packaging_type
//       };
//     });

//     // load vehicles
//     let [dbVehicles] = await db.query(
//       `SELECT * FROM master_resources
//        WHERE JSON_CONTAINS(loc_ID, ?)`,
//       [ JSON.stringify(firstFrom) ]
//     );
//     dbVehicles = dbVehicles.map(v => {
//       const trans = safeJsonParse(v.transportation_details);
//       const downs = safeJsonParse(v.downtimes);
//       const caps  = safeJsonParse(v.capacity);
//       const addl  = safeJsonParse(v.additional_details);
//       return {
//         ...v,
//         transportation_details: trans,
//         downtimes: downs,
//         capacity: caps,
//         totalWeightCapacity: convertVehicleWeight(caps.payload_weight, caps.payload_weight_unit),
//         totalVolumeCapacity: convertVehicleVolume(caps.cubic_capacity, caps.cubic_capacity_unit),
//         weightCapKg: convertVehicleWeight(caps.payload_weight, caps.payload_weight_unit),
//         volumeCapM3: convertVehicleVolume(caps.cubic_capacity, caps.cubic_capacity_unit),
//         cost_per_ton: parseFloat(addl.cost_per_ton) || 0
//       };
//     });

//     if (filters?.checkValidity) {
//       dbVehicles = dbVehicles.filter(isVehicleValid);
//     }
//     if (filters?.checkDowntime) {
//       dbVehicles = dbVehicles.filter(v=> !isVehicleDown(v));
//     }
//     if (filters?.sortUnlimitedUsage) {
//       dbVehicles.sort((a,b)=> (a.unlimited_usage||0) - (b.unlimited_usage||0));
//     }
//     if (filters?.sortOwnership) {
//       dbVehicles.sort((a,b)=> (a.individual_resource||'').localeCompare(b.individual_resource||''));
//     }
//     dbVehicles.sort((a,b)=> a.cost_per_ton - b.cost_per_ton);

//     const sourceLoc = await getLocationById(firstFrom);
//     const allPacIDs = collectAllPacIDs(packagesData, productMap);
//     const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

//     const { allocations, totalCost, unallocated } = await allocatePackages(
//       packagesData, dbVehicles, sourceLoc, productMap, packagingInfoMap
//     );

//     if (!allocations.length || allocations.every(a => a.vehicle_ID == null)) {
//       return res.status(200).json({
//         message: "No suitable vehicles found",
//         totalCost: null,
//         allocations,
//         unallocatedPackages: unallocated
//       });
//     }

//     return res.status(200).json({
//       message: "Best Combinational Scenario",
//       totalCost: totalCost || 0,
//       allocations,
//       unallocatedPackages: unallocated
//     });

//   } catch (err) {
//     logger.error('Error creating order:', err);
//     return res.status(500).json({ error: err.message });
//   }
// });


// inside order.js
 
function parseDimension(str = '') {
  const m = String(str).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  return /cm/i.test(str) ? val / 100 : val;
}

router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { packages: packageIDs, filters } = req.body;
    if (!packageIDs?.length) return res.status(400).json({ error: 'No packages provided.' });

    // 1) fetch & validate
    const packagesData = await getPackagesByIds(packageIDs);
    const origin = packagesData[0].ship_from;
    const pickupDate = packagesData[0].pickup_date_time.split('T')[0];
    packagesData.forEach(p => {
      if (p.ship_from !== origin) throw new Error('All packages must share ship_from');
      if (p.pickup_date_time.split('T')[0] !== pickupDate) throw new Error('All packages must share pickup date');
    });

    // 2) stacking-factor
    const lines = packagesData.flatMap(p => p.products);
    const prodIDs = [...new Set(lines.map(l => l.prod_ID))];
    const [sfRows] = await db.query(
      `SELECT product_ID, COALESCE(stacking_factor,'0') AS sf FROM master_products WHERE product_ID IN (?)`,
      [prodIDs]
    );
    const sfMap = sfRows.reduce((m,r) => (m[r.product_ID]=+r.sf, m), {});
    const sfSet = new Set(lines.map(l=>sfMap[l.prod_ID]));
    if (sfSet.size!==1) return res.status(400).json({
      error: `Stacking-factor mismatch: [${[...sfSet].join(', ')}]`
    });
    const productStackFactor = [...sfSet][0];

    // 3) tallest package height
    const pkgInfoMap = await loadAllPackageInfo(
      [...new Set(lines.map(l => l.package_info))]
    );
    const heights = lines
      .map(l=>pkgInfoMap[l.package_info])
      .filter(Boolean)
      .map(i=>parseDimension(i.pack_height+' '+i.dimensions_uom));
    const maxPkgH = heights.length? Math.max(...heights) : 0;

    // 4) load vehicles & compute volumes
    const [dbVehicles] = await db.query(
      `SELECT * FROM master_resources WHERE JSON_CONTAINS(loc_ID, ?)`,
      [JSON.stringify(origin)]
    );
    let fleet = dbVehicles.map(v => {
      const caps  = safeJsonParse(v.capacity, {});
      const phys = safeJsonParse(v.physical_properties, {});
    
      // 1) raw interior volume
      const rawVol = parseVolumeAndUOM(caps.cubic_capacity, caps.cubic_capacity_unit);
    
      const W = parseDimension(caps.interior_width);
      const L = parseDimension(caps.interior_length);
      const H = parseDimension(caps.interior_height);
      const floorArea = W * L;
    
      // 3) stacking
      const oneLayerM3 = maxPkgH > 0 ? floorArea * maxPkgH : 0;
      const maxLayers  = maxPkgH > 0 ? Math.floor(H / maxPkgH) : 0;
      const allowedLayers = productStackFactor === 0
        ? maxLayers
        : Math.min(maxLayers, productStackFactor);
      const usableVol = oneLayerM3 * allowedLayers;
    
      // 4) **now put weightCapKg back in**
      const weightCapKg = parseWeightAndUOM(caps.payload_weight, caps.payload_weight_unit);
    
      return {
        ...v,
        weightCapKg,                         
        totalWeightCapacity: weightCapKg,    
        totalVolumeCapacity: rawVol,
        oneLayerM3,
        usableVol,
        volumeCapM3: usableVol,            
        maxLayers,
        allowedLayers,
        transportation_details: safeJsonParse(v.transportation_details, {}),
        downtimes:            safeJsonParse(v.downtimes, {}),
        cost_per_ton:         +safeJsonParse(v.additional_details, {}).cost_per_ton || 0
      };
    });
    

    // 5) filters & sorts
    const now = Date.now();
    if (filters?.checkValidity) {
      fleet = fleet.filter(v => {
        const from = new Date(v.transportation_details.validity_from).getTime();
        const to = new Date(v.transportation_details.validity_to).getTime();
        return now>=from && now<=to;
      });
    }
    if (filters?.checkDowntime) {
      fleet = fleet.filter(v => {
        if (!v.downtimes.downtime_starts_from) return true;
        const s = new Date(v.downtimes.downtime_starts_from).getTime();
        const e = new Date(v.downtimes.downtime_ends_from).getTime();
        return now<s || now>e;
      });
    }
    if (filters?.sortUnlimitedUsage) fleet.sort((a,b)=>(a.unlimited_usage||0)-(b.unlimited_usage||0));
    if (filters?.sortOwnership)      fleet.sort((a,b)=>(a.individual_resource||'').localeCompare(b.individual_resource||''));
    fleet.sort((a,b)=>a.cost_per_ton-b.cost_per_ton);

    // 6) build productMap
    const [prodRows] = await db.query(
      `SELECT product_ID, weight, weight_uom, packaging_type FROM master_products WHERE product_ID IN (?)`,
      [prodIDs]
    );
    const productMap = prodRows.reduce((m,r)=>(m[r.product_ID]=r,m),{});

    // 7) origin coords
    const sourceLoc = await getLocationById(origin);

    // 8) allocate (auto-reject if sumV > usableVol)
    const { allocations, totalCost, unallocated } = await allocatePackages(
      packagesData, fleet, sourceLoc, productMap, pkgInfoMap
    );

    // 9) enrich & respond
    const enriched = allocations.map(a => {
      const v = fleet.find(x=>x.vehicle_ID===a.vehicle_ID) || {};
      const pct = v.usableVol>0 ? +((a.occupiedVolume/v.usableVol)*100).toFixed(2) : 0;
      return {
        ...a,
        occupiedPercent: pct,
        truckCapacity: {
          rawM3: v.totalVolumeCapacity,
          oneLayerM3: v.oneLayerM3,
          usableM3: v.usableVol,
          maxM3: v.oneLayerM3 * v.maxLayers,
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

module.exports = router;
