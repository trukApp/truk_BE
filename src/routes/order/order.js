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
  return locations
    .map(loc => `${loc.latitude},${loc.longitude}`)
    .join('|');
}

function toRadians(deg) {
  return deg * Math.PI / 180;
}
function distanceBetweenCoords(lat1, lon1, lat2, lon2) {
  const R = 6371;
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
  let lastPoint = coords[0];
  let distAcc = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = distanceBetweenCoords(
      lastPoint.lat, lastPoint.lng,
      coords[i].lat, coords[i].lng
    );
    distAcc += d;
    if (distAcc >= intervalKm) {
      sampled.push(coords[i]);
      lastPoint = coords[i];
      distAcc = 0;
    }
  }

  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
  }
  return sampled;
}


async function getOptimizedRouteWithLoad(locations, shipmentLoads) {
  if (!Array.isArray(locations) || locations.length < 2) {
    throw new Error("Locations array must have at least two points (origin/dest).");
  }

  const routeKey = buildRouteKey(locations);


  if (routeCache.has(routeKey)) {
    const cached = routeCache.get(routeKey);

    const freshOptimizedRoute = [];
    for (let i = 0; i < cached.optimizedRoute.length; i++) {
      const leg = { ...cached.optimizedRoute[i] }; 
      if (i < shipmentLoads.length) {
        leg.loadAfterStop = (i === 0 ? shipmentLoads[i] : leg.loadAfterStop); 
      }
      freshOptimizedRoute.push(leg);
    }

    return {
      optimizedRoute: freshOptimizedRoute,
      sampledCoords: cached.sampledCoords
    };
  }


  const origin = locations[0];
  const destination = locations[locations.length - 1];
  const waypoints = (locations.length > 2)
    ? locations.slice(1, -1).map(loc => `${loc.latitude},${loc.longitude}`).join('|')
    : '';

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}` +
    `&destination=${destination.latitude},${destination.longitude}` +
    (waypoints ? `&waypoints=${waypoints}` : '') +
    `&key=${GOOGLE_API_KEY}`;

  try {
    const resp = await axios.get(url);
    if (resp.data.status !== 'OK') {
      console.error("Google API Error Response:", resp.data);
      throw new Error(`Google Maps API Error: ${resp.data.status}`);
    }

    const routeLegs = resp.data.routes[0].legs;
    const optimizedRoute = [];
    let currentLoad = 0;
    routeLegs.forEach((leg, index) => {
      const load = shipmentLoads[index] || 0;
      currentLoad += load;
      if (leg.start_address !== leg.end_address) {
        optimizedRoute.push({
          start: {
            address: leg.start_address,
            latitude: locations[index].latitude,
            longitude: locations[index].longitude
          },
          end: {
            address: leg.end_address,
            latitude: locations[index + 1].latitude,
            longitude: locations[index + 1].longitude
          },
          distance: leg.distance.text,
          duration: leg.duration.text,
          loadAfterStop: currentLoad
        });
      }
    });

    const overviewPolyline = resp.data.routes[0].overview_polyline.points;
    const decodedCoords = polyline.decode(overviewPolyline).map(([lat, lng]) => ({ lat, lng }));
    const sampledCoords = sampleRoutePoints(decodedCoords, 20);

    const toCache = {
      optimizedRoute,
      sampledCoords
    };
    routeCache.set(routeKey, toCache);

    return {
      optimizedRoute,
      sampledCoords
    };
  } catch (err) {
    console.error("Error in getOptimizedRouteWithLoad:", err.message);
    throw err;
  }
}

function getBearing(lat1, lon1, lat2, lon2) {
  // Convert degrees to radians
  function toRadians(deg) {
    return deg * Math.PI / 180;
  }

  const dLon = toRadians(lon2 - lon1);
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);

  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2)
    - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

  let bearingDeg = (Math.atan2(y, x) * 180) / Math.PI;
  bearingDeg = (bearingDeg + 360) % 360;
  return bearingDeg;
}


function getDirection8(bearingDeg) {
  if (bearingDeg >= 337.5 || bearingDeg < 22.5)  return 'N';
  if (bearingDeg >= 22.5  && bearingDeg < 67.5)  return 'NE';
  if (bearingDeg >= 67.5  && bearingDeg < 112.5) return 'E';
  if (bearingDeg >= 112.5 && bearingDeg < 157.5) return 'SE';
  if (bearingDeg >= 157.5 && bearingDeg < 202.5) return 'S';
  if (bearingDeg >= 202.5 && bearingDeg < 247.5) return 'SW';
  if (bearingDeg >= 247.5 && bearingDeg < 292.5) return 'W';
  if (bearingDeg >= 292.5 && bearingDeg < 337.5) return 'NW';
  return 'N';
}


// function isDirectionCompatible(dirA, dirB) {
//   if (dirA === dirB) return true;

//   const dirs = ["N","NE","E","SE","S","SW","W","NW"];

//   const iA = dirs.indexOf(dirA);
//   const iB = dirs.indexOf(dirB);

//   if (iA < 0 || iB < 0) return false;
//   let diff = Math.abs(iA - iB);
//   if (diff > 4) diff = 8 - diff;
//   return diff <= 2;
// }


function isDirectionCompatible(dirA, dirB) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  
  const iA = dirs.indexOf(dirA);
  const iB = dirs.indexOf(dirB);
  if (iA < 0 || iB < 0) return false;

  let diff = Math.abs(iA - iB);
  if (diff > 4) diff = 8 - diff; 

  return diff <= 1;
}



function groupPackagesByDirection(pkgInfos) {
  const visited = new Set();
  const groups = [];
  for (let i = 0; i < pkgInfos.length; i++) {
    if (visited.has(i)) continue;
    const queue = [i];
    visited.add(i);
    const cluster = [pkgInfos[i]];

    while (queue.length > 0) {
      const idx = queue.shift();
      for (let j = 0; j < pkgInfos.length; j++) {
        if (visited.has(j)) continue;
        if (isDirectionCompatible(pkgInfos[idx].direction8, pkgInfos[j].direction8)) {
          visited.add(j);
          queue.push(j);
          cluster.push(pkgInfos[j]);
        }
      }
    }
    groups.push(cluster);
  }
  return groups;
}




function isVehicleValid(vehicle) {
  if (!vehicle.transportation_details) return false;
  const today = new Date();
  const from = new Date(vehicle.transportation_details.validity_from);
  const to = new Date(vehicle.transportation_details.validity_to);
  return (today >= from && today <= to);
}
function isVehicleDown(vehicle) {
  if (!vehicle.downtimes || !vehicle.downtimes.downtime_starts_from) return false;
  const today = new Date();
  const dStart = new Date(vehicle.downtimes.downtime_starts_from);
  const dEnd = new Date(vehicle.downtimes.downtime_ends_from);
  return (today >= dStart && today <= dEnd);
}
function convertVehicleWeight(num=0, unit="") {
  if (!num || !unit) return 0;
  return unit.toLowerCase()==="ton"? num*1000 : parseFloat(num);
}
function convertVehicleVolume(num=0, unit="") {
  if (!num || !unit) return 0;
  return unit.toLowerCase().includes("m")? parseFloat(num) : parseFloat(num)/1000;
}


async function getLocationById(loc_ID) {
  const [rows] = await db.query(`
    SELECT latitude, longitude, loc_desc
    FROM master_locations
    WHERE loc_ID=?
  `,[loc_ID]);
  if (!rows || !rows.length) throw new Error(`Location not found: ${loc_ID}`);
  return {
    latitude: parseFloat(rows[0].latitude)||0,
    longitude: parseFloat(rows[0].longitude)||0,
    loc_desc: rows[0].loc_desc||"Unknown"
  };
}

function safeJsonParse(value, defaultVal=[]) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); }
    catch (err) {
      console.error("JSON parse error:", err.message);
      return defaultVal;
    }
  }
  return value||defaultVal;
}


function getPackageSpecialFlags(pkg, productMap) {
  let fragile=0, dangerous=0, hazardous=0, tempCtrl=0;
  for (const p of pkg.products) {
    const info = productMap[p.prod_ID];
    if (!info) continue;
    if (info.fragile_goods) fragile=1;
    if (info.dangerous_goods) dangerous=1;
    if (info.hazardous) hazardous=1;
    if (info.temp_controlled) tempCtrl=1;
  }
  return {fragile,dangerous,hazardous,tempCtrl};
}

function getVehicleSpecialFlags(vehicle) {
  return {
    fragile_vehicle: vehicle.fragile_vehicle||0,
    danger_proof: vehicle.danger_proof||0,
    hazardous_proof: vehicle.hazardous_proof||0,
    temp_controlled_vehicle: vehicle.temp_controlled_vehicle||0
  };
}

function checkPackageVehicleCompatibility(pkgFlags, vehFlags) {
  const pkgIsNormal = !pkgFlags.fragile && !pkgFlags.dangerous && !pkgFlags.hazardous && !pkgFlags.tempCtrl;
  const vehIsNormal = !vehFlags.fragile_vehicle && !vehFlags.danger_proof && !vehFlags.hazardous_proof && !vehFlags.temp_controlled_vehicle;
  if (pkgIsNormal) return vehIsNormal;

  if (pkgFlags.fragile && !vehFlags.fragile_vehicle) return false;
  if (pkgFlags.dangerous && !vehFlags.danger_proof) return false;
  if (pkgFlags.hazardous && !vehFlags.hazardous_proof) return false;
  if (pkgFlags.tempCtrl && !vehFlags.temp_controlled_vehicle) return false;
  return true;
}


async function loadAllPackageInfo(pacIDs) {
  if (!pacIDs.length) return {};
  const placeholders = pacIDs.map(()=>'?').join(',');
  const [rows] = await db.query(`
    SELECT *
    FROM master_package_info
    WHERE pac_ID IN (${placeholders})
  `, pacIDs);
  const map = {};
  for (const r of rows) {
    map[r.pac_ID] = r;
  }
  return map;
}

function collectAllPacIDs(packagesData, productMap) {
  const pacIDs = new Set();
  for (const pkg of packagesData) {
    for (const p of pkg.products) {
      const info = productMap[p.prod_ID];
      if (!info) continue;
      let arr = info.packaging_type;
      if (typeof arr === 'string') {
        arr = JSON.parse(arr);
      }
      if (Array.isArray(arr) && arr[0]) {
        pacIDs.add(arr[0].pac_ID);
      }
    }
  }
  return [...pacIDs];
}

async function sumPackageWeightVolume(pkg, productMap, packagingInfoMap) {
  let w=0, v=0;
  for (const p of pkg.products) {
    const info = productMap[p.prod_ID];
    if (!info) continue;
    const wpu = parseWeightAndUOM(info.weight, info.weight_uom);
    w += wpu * p.quantity;

    let arr = info.packaging_type;
    if (typeof arr==='string') arr=JSON.parse(arr);
    if (!arr || !arr[0]) continue;
    const pacID=arr[0].pac_ID;
    const row=packagingInfoMap[pacID];
    if (!row) continue;
    const vol = parseVolumeAndUOM(row.pack_volume, row.pack_volume_uom);
    v += vol * p.quantity;
  }
  return {totalW:w, totalV:v};
}


function groupPackagesByDirection(pkgInfos) {
  const visited = new Set();
  const groups = [];
  for (let i=0; i<pkgInfos.length; i++) {
    if (visited.has(i)) continue;
    const queue=[i];
    visited.add(i);
    const cluster=[pkgInfos[i]];

    while (queue.length>0) {
      const idx=queue.shift();
      for (let j=0; j<pkgInfos.length; j++) {
        if (visited.has(j)) continue;
        if (isDirectionCompatible(pkgInfos[idx].direction8, pkgInfos[j].direction8)) {
          visited.add(j);
          queue.push(j);
          cluster.push(pkgInfos[j]);
        }
      }
    }
    groups.push(cluster);
  }
  return groups;
}


function canAllFitInOneVehicle(cluster, v) {
  let sumW=0, sumV=0;
  let combinedFlags={fragile:0,dangerous:0,hazardous:0,tempCtrl:0};
  for (const pkg of cluster) {
    sumW += pkg.totalWeight;
    sumV += pkg.totalVolume;
    combinedFlags.fragile = combinedFlags.fragile||pkg.specialFlags.fragile;
    combinedFlags.dangerous = combinedFlags.dangerous||pkg.specialFlags.dangerous;
    combinedFlags.hazardous = combinedFlags.hazardous||pkg.specialFlags.hazardous;
    combinedFlags.tempCtrl = combinedFlags.tempCtrl||pkg.specialFlags.tempCtrl;
  }
  if (v.weightCapKg < sumW || v.volumeCapM3 < sumV) return false;

  const vehFlags = getVehicleSpecialFlags(v);
  const pkgIsNormal = !combinedFlags.fragile && !combinedFlags.dangerous && !combinedFlags.hazardous && !combinedFlags.tempCtrl;
  const vehIsNormal = !vehFlags.fragile_vehicle && !vehFlags.danger_proof && !vehFlags.hazardous_proof && !vehFlags.temp_controlled_vehicle;
  if (pkgIsNormal) return vehIsNormal;

  if (combinedFlags.fragile && !vehFlags.fragile_vehicle) return false;
  if (combinedFlags.dangerous && !vehFlags.danger_proof) return false;
  if (combinedFlags.hazardous && !vehFlags.hazardous_proof) return false;
  if (combinedFlags.tempCtrl && !vehFlags.temp_controlled_vehicle) return false;

  return true;
}


async function findMinCostArrangement(cluster, vehicles, sourceLoc) {

  vehicles = [...vehicles].sort((a,b)=>a.cost_per_ton - b.cost_per_ton);

  let best = { cost: Infinity, allocations: [], unallocated: [] };

  async function backtrack(remaining, startVehIndex, usedSoFar) {
    if (remaining.length===0) {
      let totalC=0; usedSoFar.forEach(x=>totalC+=x.cost);
      if (totalC<best.cost) {
        best.cost=totalC;
        best.allocations = JSON.parse(JSON.stringify(usedSoFar));
        best.unallocated=[];
      }
      return;
    }
    
    if (startVehIndex >= vehicles.length) {
      if (best.cost===Infinity) {
        best.unallocated= remaining.map(r=>r.pack_ID);
      }
      return;
    }

    const v=vehicles[startVehIndex];

    const validSubsets = [];
    function subsetBacktracking(idx, chosen, sumW, sumV, combinedFlags) {
      if (idx===remaining.length) {
        validSubsets.push({ chosen, sumW, sumV, combinedFlags });
        return;
      }

      subsetBacktracking(idx+1, [...chosen], sumW, sumV, {...combinedFlags});
      const pkg=remaining[idx];
      const newW= sumW + pkg.totalWeight;
      const newV= sumV + pkg.totalVolume;
      if (newW<=v.weightCapKg && newV<=v.volumeCapM3) {
        let newFlags={...combinedFlags};
        newFlags.fragile ||= pkg.specialFlags.fragile;
        newFlags.dangerous ||= pkg.specialFlags.dangerous;
        newFlags.hazardous ||= pkg.specialFlags.hazardous;
        newFlags.tempCtrl ||= pkg.specialFlags.tempCtrl;
        if (checkVehicleCompatMultiple(newFlags,v)) {
          subsetBacktracking(idx+1, [...chosen, pkg], newW, newV, newFlags);
        }
      }
    }
    function checkVehicleCompatMultiple(cf, veh) {
      const vehFlags = getVehicleSpecialFlags(veh);
      const pkgIsNormal = !cf.fragile && !cf.dangerous && !cf.hazardous && !cf.tempCtrl;
      const vehIsNormal = !vehFlags.fragile_vehicle && !vehFlags.danger_proof && !vehFlags.hazardous_proof && !vehFlags.temp_controlled_vehicle;
      if (pkgIsNormal) return vehIsNormal;
      if (cf.fragile && !vehFlags.fragile_vehicle) return false;
      if (cf.dangerous && !vehFlags.danger_proof) return false;
      if (cf.hazardous && !vehFlags.hazardous_proof) return false;
      if (cf.tempCtrl && !vehFlags.temp_controlled_vehicle) return false;
      return true;
    }

    subsetBacktracking(0, [], 0, 0, {fragile:0,dangerous:0,hazardous:0,tempCtrl:0});
    
    for (const subset of validSubsets) {
      if (subset.chosen.length===0) continue; 
      subset.chosen.sort((a,b)=>a.distFromSource - b.distFromSource);
      const routeLocations=[sourceLoc];
      subset.chosen.forEach(p=>routeLocations.push(p.destination));
      const shipments = new Array(subset.chosen.length).fill(1);

      const usedTons= (subset.sumW)/1000;
      const c= usedTons* v.cost_per_ton;

      const {optimizedRoute, sampledCoords} = await getOptimizedRouteWithLoad(routeLocations, shipments);

      const reversed=[...optimizedRoute].reverse();
      let loadArr=[];
      let remainIDs=subset.chosen.map(x=>x.pack_ID);
      reversed.forEach((leg,i)=>{
        const stopNumber=i+1;
        let legPkgs=[];
        for (const pkID of remainIDs) {
          const pObj = subset.chosen.find(x=>x.pack_ID===pkID);
          if (!pObj) continue;
          if (pObj.destination.latitude===leg.end.latitude &&
              pObj.destination.longitude===leg.end.longitude) {
            legPkgs.push(pkID);
          }
        }
        if (legPkgs.length>0) {
          legPkgs.forEach(lp=> {
            const idx = remainIDs.indexOf(lp);
            if (idx!==-1) remainIDs.splice(idx,1);
          });
          loadArr.push({
            stop: stopNumber,
            location: leg.end.address,
            packages: legPkgs
          });
        }
      });

      const allocation={
        vehicle_ID: v.vehicle_ID,
        totalWeightCapacity: v.totalWeightCapacity,
        totalVolumeCapacity: v.totalVolumeCapacity,
        occupiedWeight: subset.sumW,
        occupiedVolume: subset.sumV,
        leftoverWeight: v.weightCapKg - subset.sumW,
        leftoverVolume: v.volumeCapM3 - subset.sumV,
        cost: c,
        packages: subset.chosen.map(x=>x.pack_ID),
        route: optimizedRoute,
        loadArrangement: loadArr,
        sampledRoutePoints: sampledCoords
      };

      const leftover= remaining.filter(x=>!subset.chosen.includes(x));
      const nextUsedSoFar=[...usedSoFar, allocation];

      await backtrack(leftover, startVehIndex+1, nextUsedSoFar);
    }
    await backtrack(remaining, startVehIndex+1, usedSoFar);
  }

  await backtrack(cluster, 0, []);

  return best;
}


async function allocatePackages(packagesData, vehicles, sourceLocation, productMap, packagingInfoMap) {
  const allocations=[];
  let totalCost=0;
  const unallocated=[];

  const pkgInfos=[];
  for (const pkg of packagesData) {
    const {totalW, totalV} = await sumPackageWeightVolume(pkg, productMap, packagingInfoMap);
    const destLoc= await getLocationById(pkg.ship_to);
    const bearingDeg= getBearing(sourceLocation.latitude,sourceLocation.longitude,destLoc.latitude,destLoc.longitude);
    const dir8= getDirection8(bearingDeg);
    const distKM= distanceBetweenCoords(sourceLocation.latitude, sourceLocation.longitude,
                                        destLoc.latitude, destLoc.longitude);
    const flags= getPackageSpecialFlags(pkg, productMap);
    pkgInfos.push({
      pack_ID: pkg.pack_ID,
      totalWeight: totalW,
      totalVolume: totalV,
      allocated: false,
      destination: destLoc,
      direction8: dir8,
      distFromSource: distKM,
      specialFlags: flags,
      originalPkg: pkg 
    });
  }

  const groups= groupPackagesByDirection(pkgInfos);

  for (const group of groups) {
    let sumW=0; let sumV=0;
    let combinedFlags={fragile:0,dangerous:0,hazardous:0,tempCtrl:0};
    group.forEach(g=>{
      sumW+= g.totalWeight;
      sumV+= g.totalVolume;
      combinedFlags.fragile ||= g.specialFlags.fragile;
      combinedFlags.dangerous ||= g.specialFlags.dangerous;
      combinedFlags.hazardous ||= g.specialFlags.hazardous;
      combinedFlags.tempCtrl ||= g.specialFlags.tempCtrl;
    });

    let feasible= vehicles.filter(v => (v.weightCapKg>= sumW && v.volumeCapM3>= sumV));
    feasible= feasible.filter(v=>{
      const vf= getVehicleSpecialFlags(v);
      const pkgIsNormal= !combinedFlags.fragile && !combinedFlags.dangerous && !combinedFlags.hazardous && !combinedFlags.tempCtrl;
      const vehIsNormal= !vf.fragile_vehicle && !vf.danger_proof && !vf.hazardous_proof && !vf.temp_controlled_vehicle;
      if (pkgIsNormal) return vehIsNormal;
      if (combinedFlags.fragile && !vf.fragile_vehicle) return false;
      if (combinedFlags.dangerous && !vf.danger_proof) return false;
      if (combinedFlags.hazardous && !vf.hazardous_proof) return false;
      if (combinedFlags.tempCtrl && !vf.temp_controlled_vehicle) return false;
      return true;
    });

    if (feasible.length>0) {
      feasible.sort((a,b)=> a.cost_per_ton - b.cost_per_ton);
      const chosen= feasible[0];

      group.sort((a,b)=> a.distFromSource- b.distFromSource);
      const routeLocations=[sourceLocation];
      group.forEach(g=> routeLocations.push(g.destination));
      const shipments=new Array(group.length).fill(1);
      const usedTons=(sumW)/1000;
      const cost= usedTons* chosen.cost_per_ton;
      totalCost+= cost;

      const {optimizedRoute, sampledCoords}= await getOptimizedRouteWithLoad(routeLocations, shipments);
      const reversed=[...optimizedRoute].reverse();
      let loadArr=[];
      let remainIDs= group.map(x=>x.pack_ID);
      reversed.forEach((leg,i)=>{
        const stopNumber=i+1;
        let legPackages=[];
        for (const pkID of remainIDs) {
          const pObj= group.find(x=> x.pack_ID===pkID);
          if (!pObj) continue;
          if (pObj.destination.latitude=== leg.end.latitude &&
              pObj.destination.longitude=== leg.end.longitude) {
            legPackages.push(pkID);
          }
        }
        if (legPackages.length>0) {
          legPackages.forEach(lp=>{
            const idx= remainIDs.indexOf(lp);
            if (idx!==-1) remainIDs.splice(idx,1);
          });
          loadArr.push({stop:stopNumber, location: leg.end.address, packages: legPackages});
        }
      });

      allocations.push({
        vehicle_ID: chosen.vehicle_ID,
        totalWeightCapacity: chosen.totalWeightCapacity,
        totalVolumeCapacity: chosen.totalVolumeCapacity,
        occupiedWeight: sumW,
        occupiedVolume: sumV,
        leftoverWeight: chosen.weightCapKg - sumW,
        leftoverVolume: chosen.volumeCapM3 - sumV,
        cost,
        packages: group.map(x=> x.pack_ID),
        route: optimizedRoute,
        loadArrangement: loadArr,
        sampledRoutePoints: sampledCoords
      });

    } else {
      const { cost, allocations: subAllocs, unallocated }= await findMinCostArrangement(group, vehicles, sourceLocation);
      totalCost+= cost;
      allocations.push(... subAllocs);
      if (unallocated && unallocated.length>0) {
        unallocated.forEach(u=> {
          allocations.push({
            vehicle_ID: null,
            cost:0,
            packages:[u],
            route:[],
            leftoverWeight:0,
            leftoverVolume:0,
            loadArrangement:[],
            sampledRoutePoints:[]
          });
        });
      }
    }
  }

  return { allocations, totalCost, unallocated:[] };
}


async function getPackagesByIds(packageIDs) {
  const placeholders = packageIDs.map(()=>'?').join(',');
  const [rows] = await db.query(`
    SELECT *
    FROM packages
    WHERE pack_ID IN (${placeholders})
  `, packageIDs);
  if (!rows|| !rows.length) throw new Error(`No matching packages for: ${packageIDs}`);
  return rows.map(pkg=>({
    pack_ID: pkg.pack_ID,
    ship_from: pkg.ship_from,
    ship_to: pkg.ship_to,
    products: safeJsonParse(pkg.product_ID)
  }));
}


router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { packages: packageIDs, filters } = req.body;
    if (!Array.isArray(packageIDs) || packageIDs.length === 0) {
      return res.status(400).json({ error: 'No valid package IDs provided.' });
    }

    const packagesData = await getPackagesByIds(packageIDs);
    if (!packagesData.length) {
      return res.status(400).json({ error: 'No valid packages found.' });
    }

    const firstShipFrom = packagesData[0].ship_from;
    for (const pkg of packagesData) {
      if (pkg.ship_from !== firstShipFrom) {
        return res.status(400).json({
          error: 'All packages must have the same ship_from location.'
        });
      }
    }

    const resolvedProducts = packagesData.flatMap(p => p.products);
    const productIDs = resolvedProducts.map(rp => rp.prod_ID);
    if (!productIDs.length) {
      return res.status(400).json({ error: 'No product lines found in given packages.' });
    }

    const placeholders = productIDs.map(() => '?').join(',');
    const [rows] = await db.query(`
      SELECT product_ID, weight, weight_uom, volume, volume_uom,
             fragile_goods, dangerous_goods, hazardous, temp_controlled,
             packaging_type
      FROM master_products
      WHERE product_ID IN (${placeholders})
    `, productIDs);

    const productMap = {};
    rows.forEach(r => {
      productMap[r.product_ID] = {
        weight: r.weight,
        weight_uom: r.weight_uom,
        volume: r.volume,
        volume_uom: r.volume_uom,
        fragile_goods: r.fragile_goods,
        dangerous_goods: r.dangerous_goods,
        hazardous: r.hazardous,
        temp_controlled: r.temp_controlled,
        packaging_type: r.packaging_type
      };
    });

    let [dbVehicles] = await db.query(`SELECT * FROM master_vehicles`);
    dbVehicles = dbVehicles.map(v => {
      const trans = safeJsonParse(v.transportation_details);
      const downs = safeJsonParse(v.downtimes);
      const caps = safeJsonParse(v.capacity);
      const addl = safeJsonParse(v.additional_details);
      return {
        ...v,
        transportation_details: trans,
        downtimes: downs,
        capacity: caps,
        totalWeightCapacity: convertVehicleWeight(caps?.payload_weight, caps?.payload_weight_unit),
        totalVolumeCapacity: convertVehicleVolume(caps?.cubic_capacity, caps?.cubic_capacity_unit),
        weightCapKg: convertVehicleWeight(caps?.payload_weight, caps?.payload_weight_unit),
        volumeCapM3: convertVehicleVolume(caps?.cubic_capacity, caps?.cubic_capacity_unit),
        cost_per_ton: addl?.cost_per_ton ? parseFloat(addl.cost_per_ton) : 0
      };
    });

    if (filters?.checkValidity) {
      dbVehicles = dbVehicles.filter(isVehicleValid);
    }
    if (filters?.checkDowntime) {
      dbVehicles = dbVehicles.filter(v => !isVehicleDown(v));
    }
    if (filters?.sortUnlimitedUsage) {
      dbVehicles.sort((a, b) => (a.unlimited_usage || 0) - (b.unlimited_usage || 0));
    }
    if (filters?.sortOwnership) {
      dbVehicles.sort((a, b) => (a.individual_resource || '')
        .localeCompare(b.individual_resource || ''));
    }

    dbVehicles.sort((a, b) => a.cost_per_ton - b.cost_per_ton);

    const sourceLoc = await getLocationById(firstShipFrom);

    const allPacIDs = collectAllPacIDs(packagesData, productMap);
    const packagingInfoMap = await loadAllPackageInfo(allPacIDs);

    const { allocations, totalCost, unallocated } = await allocatePackages(
      packagesData, dbVehicles, sourceLoc, productMap, packagingInfoMap
    );

    const allNull = allocations.length > 0 && allocations.every(a => a.vehicle_ID === null);
    if (allNull) {
      return res.status(200).json({
        message: "No suitable vehicles found for these package(s). " +
                 "Possibly special conditions or capacity mismatch.",
        totalCost: null,
        allocations,
        unallocatedPackages: unallocated
      });
    }

    return res.status(200).json({
      message: "Best Combinational Scenario",
      totalCost: totalCost || 0, 
      allocations,
      unallocatedPackages: unallocated
    });

  } catch (error) {
    logger.error('Error creating order:', error);
    return res.status(500).json({ error: error.message });
  }
});


module.exports= router;
