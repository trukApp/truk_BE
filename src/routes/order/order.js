require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;



const getOptimizedRouteWithLoad = async (locations, shipmentLoads) => {
  if (!Array.isArray(locations) || locations.some(loc => !loc.latitude || !loc.longitude)) {
    throw new Error("Invalid locations array. Ensure all locations have latitude and longitude.");
  }

  const origin = locations[0];
  const destination = locations[locations.length - 1];

  const waypoints = locations.length > 2
    ? locations.slice(1, -1).map(loc => `${loc.latitude},${loc.longitude}`).join('|')
    : '';

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}${
    waypoints ? `&waypoints=${waypoints}` : ''
  }&key=${GOOGLE_API_KEY}`;

  try {
    const response = await axios.get(url);
    if (response.data.status !== 'OK') {
      console.error("Google API Error Response:", response.data);
      throw new Error(`Google Maps API Error: ${response.data.status}`);
    }

    const routeLegs = response.data.routes[0].legs;
    const optimizedRoute = [];
    let currentLoad = 0;

    routeLegs.forEach((leg, index) => {
      const shipmentLoad = shipmentLoads[index] || 0;
      currentLoad += shipmentLoad;
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
          loadAfterStop: currentLoad,
        });
      }
    });
    return optimizedRoute;
  } catch (error) {
    console.error('Error optimizing route:', error.message);
    throw error;
  }
};



function isVehicleValid(vehicle) {
  if (!vehicle.transportation_details) return false;
  const today = new Date();
  const validityFrom = new Date(vehicle.transportation_details.validity_from);
  const validityTo = new Date(vehicle.transportation_details.validity_to);
  return today >= validityFrom && today <= validityTo;
}

function isVehicleDown(vehicle) {
  if (!vehicle.downtimes || !vehicle.downtimes.downtime_starts_from) return false;
  const today = new Date();
  const downtimeStart = new Date(vehicle.downtimes.downtime_starts_from);
  const downtimeEnd = new Date(vehicle.downtimes.downtime_ends_from);
  return today >= downtimeStart && today <= downtimeEnd;
}

function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
  if (!weightNumber || !weightUnit) return 0;
  return weightUnit.toLowerCase() === "ton"
    ? weightNumber * 1000
    : parseFloat(weightNumber);
}

function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
  if (!volumeNumber || !volumeUnit) return 0;
  return volumeUnit.toLowerCase().includes("m")
    ? parseFloat(volumeNumber)
    : parseFloat(volumeNumber) / 1000;
}

async function getLocationById(loc_ID) {
  const [rows] = await db.query(
    `SELECT latitude, longitude, loc_desc FROM master_locations WHERE loc_ID = ?`,
    [loc_ID]
  );
  if (!rows || rows.length === 0) {
    throw new Error(`Location with loc_ID '${loc_ID}' not found.`);
  }
  return {
    latitude: parseFloat(rows[0].latitude) || 0,
    longitude: parseFloat(rows[0].longitude) || 0,
    loc_desc: rows[0].loc_desc || "Unknown"
  };
}

function safeJsonParse(value, defaultValue = []) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      console.error(`JSON Parse Error: ${error.message} | Input:`, value);
      return defaultValue;
    }
  }
  return value || defaultValue;
}

async function getPackagesByIds(packageIDs) {
  const placeholders = packageIDs.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT * FROM packages WHERE pack_ID IN (${placeholders})`,
    packageIDs
  );
  if (!rows || rows.length === 0) throw new Error(`No matching packages found.`);

  return rows.map(pkg => ({
    pack_ID: pkg.pack_ID,
    ship_from: pkg.ship_from,
    ship_to: pkg.ship_to,
    products: safeJsonParse(pkg.product_ID),
  }));
}



router.post('/create-order', async (req, res) => {
  try {
    const { packages: packageIDs, filters = {} } = req.body;
    if (!Array.isArray(packageIDs) || packageIDs.length === 0) {
      return res.status(400).json({ error: 'No valid package IDs provided.' });
    }

    // 1) Fetch package details
    const packagesData = await getPackagesByIds(packageIDs);
    const sourceLocation = await getLocationById(packagesData[0].ship_from);

    // 2) Build resolvedProducts
    const resolvedProducts = await Promise.all(
      packagesData.flatMap(pkg =>
        pkg.products.map(async product => {
          const destinationLocation = await getLocationById(pkg.ship_to);
          return {
            ...product,
            pack_ID: pkg.pack_ID,
            destinationLocation
          };
        })
      )
    );

    // 3) Fetch product details
    const productIDs = resolvedProducts.map(p => p.prod_ID);
    const placeholdersProducts = productIDs.map(() => '?').join(',');
    const [rows] = await db.query(`
      SELECT product_ID, weight, weight_uom, volume, volume_uom
      FROM master_products
      WHERE product_ID IN (${placeholdersProducts})
    `, productIDs);

    const productMap = {};
    rows.forEach(row => {
      productMap[row.product_ID] = row;
    });

    // 4) Fetch vehicles
    const [dbVehicles] = await db.query(`SELECT * FROM master_vehicles`);
    let vehicles = dbVehicles.map(v => {
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
        ownership: trans?.ownership || "carrier",
        cost_per_ton: addl?.cost_per_ton ? parseFloat(addl.cost_per_ton) : 0
      };
    });

    // 5) Filter toggles
    if (filters.checkValidity) {
      vehicles = vehicles.filter(v => isVehicleValid(v));
    }
    if (filters.checkDowntime) {
      vehicles = vehicles.filter(v => !isVehicleDown(v));
    }

    // 6) Sorting toggles
    // REORDER so cost is first, then usage, then ownership, then capacity
    vehicles.sort((a, b) => {
      // 1) cost
      if (filters.sortByCost) {
        const costDiff = a.cost_per_ton - b.cost_per_ton;
        if (costDiff !== 0) return costDiff;
      }

      // 2) unlimited usage
      if (filters.sortUnlimitedUsage) {
        const usageDiff = b.unlimited_usage - a.unlimited_usage;
        if (usageDiff !== 0) return usageDiff;
      }

      // 3) ownership
      if (filters.sortOwnership) {
        const ownA = a.ownership === 'self' ? 1 : 0;
        const ownB = b.ownership === 'self' ? 1 : 0;
        const diff = ownB - ownA;
        if (diff !== 0) return diff;
      }

      // 4) capacity
      if (filters.sortByCapacity) {
        const capDiff = a.totalWeightCapacity - b.totalWeightCapacity;
        if (capDiff !== 0) return capDiff;
      }

      return 0;
    });

    // 7) Single-pass allocation with extended direction logic
    // Instead of just 'north'/'south', let's do a bearing-based approach:
    // We'll classify products into e.g. 8 directions: N, NE, E, SE, S, SW, W, NW
    // so we don't mix them in one vehicle
    let allocations = [];
    let routes = [];
    let totalCost = 0;

    // Helper to get "bearing" from source to product location
    const toRadians = angle => (angle * Math.PI) / 180;
    function getBearing(lat1, lon1, lat2, lon2) {
      // formula for initial bearing from lat1/lon1 to lat2/lon2
      const dLon = toRadians(lon2 - lon1);
      const phi1 = toRadians(lat1);
      const phi2 = toRadians(lat2);

      const y = Math.sin(dLon) * Math.cos(phi2);
      const x = Math.cos(phi1)*Math.sin(phi2) - Math.sin(phi1)*Math.cos(phi2)*Math.cos(dLon);
      let bearingDeg = (Math.atan2(y, x) * 180 / Math.PI);
      // normalizing
      bearingDeg = (bearingDeg + 360) % 360;
      return bearingDeg;
    }

    // classify bearing into one of 8 directions
    function getDirection(bearingDeg) {
      // each 45 degrees is a direction
      // 0 deg = N, 45 = NE, 90 = E, 135 = SE, 180 = S, 225 = SW, 270 = W, 315 = NW
      if (bearingDeg >= 337.5 || bearingDeg < 22.5) return 'N';
      if (bearingDeg >= 22.5 && bearingDeg < 67.5) return 'NE';
      if (bearingDeg >= 67.5 && bearingDeg < 112.5) return 'E';
      if (bearingDeg >= 112.5 && bearingDeg < 157.5) return 'SE';
      if (bearingDeg >= 157.5 && bearingDeg < 202.5) return 'S';
      if (bearingDeg >= 202.5 && bearingDeg < 247.5) return 'SW';
      if (bearingDeg >= 247.5 && bearingDeg < 292.5) return 'W';
      if (bearingDeg >= 292.5 && bearingDeg < 337.5) return 'NW';
      return 'N'; // fallback
    }

    for (const vehicle of vehicles) {
      const originalWeightCap = vehicle.weightCapKg;
      const originalVolumeCap = vehicle.volumeCapM3;

      let routeDirection = null; // store direction like 'N','NE','E','SE','S','SW','W','NW'
      const vehicleAllocation = {
        vehicle_ID: vehicle.vehicle_ID,
        totalWeightCapacity: vehicle.totalWeightCapacity,
        totalVolumeCapacity: vehicle.totalVolumeCapacity,
        allocatedWeight: 0,
        leftoverWeight: vehicle.weightCapKg,
        allocatedVolume: 0,
        leftoverVolume: vehicle.volumeCapM3,
        cost: 0,
        products: []
      };

      for (const product of resolvedProducts) {
        if (product.quantity <= 0) continue;

        const details = productMap[product.prod_ID];
        if (!details) continue;

        const weightPerUnit = parseWeightAndUOM(details.weight, details.weight_uom);
        const volumePerUnit = parseVolumeAndUOM(details.volume, details.volume_uom);

        // compute bearing from source to product
        const bearingDeg = getBearing(
          sourceLocation.latitude, sourceLocation.longitude,
          product.destinationLocation.latitude, product.destinationLocation.longitude
        );
        const productDirection8 = getDirection(bearingDeg); // e.g. 'NE','S','W', etc.

        if (!routeDirection) {
          routeDirection = productDirection8; // set the vehicle's direction to that 8-cardinal direction
        } else {
          if (productDirection8 !== routeDirection) {
            // skip if mismatch
            continue;
          }
        }

        const maxQty = Math.min(
          Math.floor(vehicle.weightCapKg / weightPerUnit),
          Math.floor(vehicle.volumeCapM3 / volumePerUnit),
          product.quantity
        );

        if (maxQty > 0) {
          vehicleAllocation.allocatedWeight += maxQty * weightPerUnit;
          vehicleAllocation.allocatedVolume += maxQty * volumePerUnit;
          vehicleAllocation.products.push({
            product_ID: product.prod_ID,
            pack_ID: product.pack_ID,
            allocatedQuantity: maxQty,
            destinationLocation: product.destinationLocation
          });

          product.quantity -= maxQty;
          vehicle.weightCapKg -= maxQty * weightPerUnit;
          vehicle.volumeCapM3 -= maxQty * volumePerUnit;
        }
      }

      vehicleAllocation.leftoverWeight = originalWeightCap - vehicleAllocation.allocatedWeight;
      vehicleAllocation.leftoverVolume = originalVolumeCap - vehicleAllocation.allocatedVolume;

      // cost => (allocatedWeight / 1000) * cost_per_ton
      const allocatedTons = vehicleAllocation.allocatedWeight / 1000;
      vehicleAllocation.cost = allocatedTons * vehicle.cost_per_ton;
      totalCost += vehicleAllocation.cost;

      if (vehicleAllocation.products.length > 0) {
        allocations.push(vehicleAllocation);

        // build route
        const uniqueDestinations = [
          ...new Map(
            vehicleAllocation.products.map(p => [p.destinationLocation.loc_desc, p.destinationLocation])
          ).values()
        ].sort((a, b) => a.latitude - b.latitude);

        const optimizedRoute = await getOptimizedRouteWithLoad(
          [sourceLocation, ...uniqueDestinations],
          vehicleAllocation.products.map(p => p.allocatedQuantity)
        );

        let loadArrangement = [];
        let remainingLoad = vehicleAllocation.allocatedWeight;

        optimizedRoute.forEach((stop, index) => {
          const loadAtThisStop = vehicleAllocation.products
            .filter(prod =>
              prod.destinationLocation.latitude === stop.end.latitude &&
              prod.destinationLocation.longitude === stop.end.longitude
            )
            .map(prod => ({
              product_ID: prod.product_ID,
              pack_ID: prod.pack_ID,
              quantity: prod.allocatedQuantity
            }));

          loadAtThisStop.forEach(prod => {
            remainingLoad -= prod.quantity;
          });

          loadArrangement.unshift({
            stop: index + 1,
            location: stop.end.address,
            products: loadAtThisStop
          });
        });

        routes.push({
          vehicle_ID: vehicle.vehicle_ID,
          totalWeightCapacity: vehicle.totalWeightCapacity,
          totalVolumeCapacity: vehicle.totalVolumeCapacity,
          leftoverWeight: vehicleAllocation.leftoverWeight,
          leftoverVolume: vehicleAllocation.leftoverVolume,
          cost: vehicleAllocation.cost,
          loadArrangement,
          route: optimizedRoute
        });
      }
    }

    return res.status(200).json({
      message: 'Order created successfully',
      totalCost,
      allocations,
      routes
    });

  } catch (error) {
    logger.error('Error creating order:', error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;




// require('dotenv').config();
// const express = require('express');
// const axios = require('axios');
// const router = express.Router();
// const db = require('../../../dbConnection');
// const { logger } = require('../../logger/logger');
// const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');


// const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;


// // ✅ Google Maps API Route Optimization
// const getOptimizedRouteWithLoad = async (locations, shipmentLoads) => {
//   if (!Array.isArray(locations) || locations.some(loc => !loc.latitude || !loc.longitude)) {
//     throw new Error("Invalid locations array. Ensure all locations have latitude and longitude.");
//   }


//   const origin = locations[0];
//   const destination = locations[locations.length - 1];


//   // CHANGE #1: Remove "optimize:true"
//   const waypoints = locations.length > 2
//     ? locations.slice(1, -1).map(loc => `${loc.latitude},${loc.longitude}`).join('|')
//     : '';


//   // So final URL has no "optimize:true"
//   const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}${
//     waypoints ? `&waypoints=${waypoints}` : ''
//   }&key=${GOOGLE_API_KEY}`;


//   try {
//     const response = await axios.get(url);
//     if (response.data.status !== 'OK') {
//       console.error("Google API Error Response:", response.data);
//       throw new Error(`Google Maps API Error: ${response.data.status}`);
//     }


//     const routeLegs = response.data.routes[0].legs;
//     const optimizedRoute = [];
//     let currentLoad = 0;


//     routeLegs.forEach((leg, index) => {
//       const shipmentLoad = shipmentLoads[index] || 0;
//       currentLoad += shipmentLoad;
//       // Prevent duplicate routes (Same Start & End)
//       if (leg.start_address !== leg.end_address) {
//         optimizedRoute.push({
//           start: {
//             address: leg.start_address,
//             latitude: locations[index].latitude,
//             longitude: locations[index].longitude
//           },
//           end: {
//             address: leg.end_address,
//             latitude: locations[index + 1].latitude,
//             longitude: locations[index + 1].longitude
//           },
//           distance: leg.distance.text,
//           duration: leg.duration.text,
//           loadAfterStop: currentLoad,
//         });
//       }
//     });
//     return optimizedRoute;
//   } catch (error) {
//     console.error('Error optimizing route:', error.message);
//     throw error;
//   }
// };


// // ✅ Utility Functions
// function isVehicleValid(vehicle) {
//   if (!vehicle.transportation_details) return false;
//   const today = new Date();
//   const validityFrom = new Date(vehicle.transportation_details.validity_from);
//   const validityTo = new Date(vehicle.transportation_details.validity_to);
//   return today >= validityFrom && today <= validityTo;
// }


// function isVehicleDown(vehicle) {
//   if (!vehicle.downtimes || !vehicle.downtimes.downtime_starts_from) return false;
//   const today = new Date();
//   const downtimeStart = new Date(vehicle.downtimes.downtime_starts_from);
//   const downtimeEnd = new Date(vehicle.downtimes.downtime_ends_from);
//   return today >= downtimeStart && today <= downtimeEnd;
// }


// function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
//   if (!weightNumber || !weightUnit) return 0;
//   return weightUnit.toLowerCase() === "ton" ? weightNumber * 1000 : parseFloat(weightNumber);
// }


// function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
//   if (!volumeNumber || !volumeUnit) return 0;
//   return volumeUnit.toLowerCase().includes("m") ? parseFloat(volumeNumber) : parseFloat(volumeNumber) / 1000;
// }


// async function getLocationById(loc_ID) {
//   const [rows] = await db.query(
//     `SELECT latitude, longitude, loc_desc FROM master_locations WHERE loc_ID = ?`,
//     [loc_ID]
//   );
//   if (!rows || rows.length === 0) {
//     throw new Error(`Location with loc_ID '${loc_ID}' not found.`);
//   }
//   return {
//     latitude: parseFloat(rows[0].latitude) || 0,
//     longitude: parseFloat(rows[0].longitude) || 0,
//     loc_desc: rows[0].loc_desc || "Unknown"
//   };
// }


// function safeJsonParse(value, defaultValue = []) {
//   if (typeof value === 'string') {
//     try {
//       return JSON.parse(value);
//     } catch (error) {
//       console.error(`JSON Parse Error: ${error.message} | Input:`, value);
//       return defaultValue;
//     }
//   }
//   return value || defaultValue;
// }


// // ✅ Fetch Packages by IDs
// async function getPackagesByIds(packageIDs) {
//   const placeholders = packageIDs.map(() => '?').join(',');
//   const [rows] = await db.query(
//     `SELECT * FROM packages WHERE pack_ID IN (${placeholders})`,
//     packageIDs
//   );
//   if (!rows || rows.length === 0) throw new Error(`No matching packages found.`);


//   return rows.map(pkg => ({
//     pack_ID: pkg.pack_ID,
//     ship_from: pkg.ship_from,
//     ship_to: pkg.ship_to,
//     products: safeJsonParse(pkg.product_ID),
//   }));
// }


// // ✅ Create Order API
// router.post('/create-order', async (req, res) => {
//   try {
//     const { packages: packageIDs } = req.body;
//     if (!Array.isArray(packageIDs) || packageIDs.length === 0) {
//       return res.status(400).json({ error: 'No valid package IDs provided.' });
//     }


//     // Fetch package details
//     const packagesData = await getPackagesByIds(packageIDs);
//     const sourceLocation = await getLocationById(packagesData[0].ship_from);


//     // Resolve product destinations
//     const resolvedProducts = await Promise.all(
//       packagesData.flatMap(pkg =>
//         pkg.products.map(async (product) => {
//           const destinationLocation = await getLocationById(pkg.ship_to);
//           return { ...product, destinationLocation };
//         })
//       )
//     );


//     // Fetch product details
//     const productIDs = resolvedProducts.map((p) => p.prod_ID);
//     const placeholdersProducts = productIDs.map(() => '?').join(',');
//     const [rows] = await db.query(
//       `SELECT product_ID, weight, weight_uom, volume, volume_uom
//        FROM master_products
//        WHERE product_ID IN (${placeholdersProducts})`,
//       productIDs
//     );


//     const productMap = {};
//     rows.forEach((row) => (productMap[row.product_ID] = row));


//     // Fetch vehicles
//     const [dbVehicles] = await db.query(`SELECT * FROM master_vehicles`);
//     let vehicles = dbVehicles.map((v) => ({
//       ...v,
//       transportation_details: safeJsonParse(v.transportation_details),
//       downtimes: safeJsonParse(v.downtimes),
//       capacity: safeJsonParse(v.capacity),
//       totalWeightCapacity: convertVehicleWeight(v.capacity?.payload_weight, v.capacity?.payload_weight_unit),
//       totalVolumeCapacity: convertVehicleVolume(v.capacity?.cubic_capacity, v.capacity?.cubic_capacity_unit),
//       weightCapKg: convertVehicleWeight(v.capacity?.payload_weight, v.capacity?.payload_weight_unit),
//       volumeCapM3: convertVehicleVolume(v.capacity?.cubic_capacity, v.capacity?.cubic_capacity_unit),
//       ownership: v.transportation_details?.ownership || "carrier"
//     }));


//     // Apply vehicle selection conditions
//     vehicles = vehicles.filter(v => isVehicleValid(v) && !isVehicleDown(v));
//     vehicles.sort(
//       (a, b) =>
//         b.unlimited_usage - a.unlimited_usage ||
//         (b.ownership === "self" ? 1 : 0) - (a.ownership === "self" ? 1 : 0)
//     );


//     const allocations = [];
//     const routes = [];


//     for (const vehicle of vehicles) {
//       let originalWeightCap = vehicle.weightCapKg;
//       let originalVolumeCap = vehicle.volumeCapM3;


//       const vehicleAllocation = {
//         vehicle_ID: vehicle.vehicle_ID,
//         totalWeightCapacity: vehicle.totalWeightCapacity,
//         totalVolumeCapacity: vehicle.totalVolumeCapacity,
//         allocatedWeight: 0,
//         leftoverWeight: vehicle.weightCapKg,
//         allocatedVolume: 0,
//         leftoverVolume: vehicle.volumeCapM3,
//         products: []
//       };


//       let currentLoad = 0; // Track load after each stop


//       // Allocate products to the vehicle if capacity allows
//       for (const product of resolvedProducts) {
//         const details = productMap[product.prod_ID];
//         if (!details) continue; // Skip if no product details found


//         const weightPerUnit = parseWeightAndUOM(details.weight, details.weight_uom);
//         const volumePerUnit = parseVolumeAndUOM(details.volume, details.volume_uom);


//         // ✅ Ensure the vehicle has enough capacity left
//         const maxQuantity = Math.min(
//           Math.floor(vehicle.weightCapKg / weightPerUnit),
//           Math.floor(vehicle.volumeCapM3 / volumePerUnit),
//           product.quantity
//         );


//         if (maxQuantity > 0) {
//           vehicleAllocation.allocatedWeight += maxQuantity * weightPerUnit;
//           vehicleAllocation.allocatedVolume += maxQuantity * volumePerUnit;
//           vehicleAllocation.products.push({
//             product_ID: product.prod_ID,
//             allocatedQuantity: maxQuantity,
//             destinationLocation: product.destinationLocation
//           });
//           product.quantity -= maxQuantity;
//           vehicle.weightCapKg -= maxQuantity * weightPerUnit;
//           vehicle.volumeCapM3 -= maxQuantity * volumePerUnit;
//         }
//       }


//       vehicleAllocation.leftoverWeight = originalWeightCap - vehicleAllocation.allocatedWeight;
//       vehicleAllocation.leftoverVolume = originalVolumeCap - vehicleAllocation.allocatedVolume;


//       // Only proceed if this vehicle got some products
//       if (vehicleAllocation.products.length > 0) {
//         allocations.push(vehicleAllocation);


//         // ✅ **Sort Destinations in Correct Order (Ongole → Kakinada → Chennai)** or vice versa
//         const uniqueDestinations = [
//           ...new Map(
//             vehicleAllocation.products.map(p => [
//               p.destinationLocation.loc_desc,
//               p.destinationLocation
//             ])
//           ).values()
//         ].sort((a, b) => a.latitude - b.latitude);


//         // ✅ Generate Optimized Route (WITHOUT optimize:true)
//         const optimizedRoute = await getOptimizedRouteWithLoad(
//           [sourceLocation, ...uniqueDestinations],
//           vehicleAllocation.products.map(p => p.allocatedQuantity)
//         );


//         // ✅ **Fix Load Arrangement Order (LIFO Rule)**
//         let loadArrangement = [];
//         let remainingLoad = vehicleAllocation.allocatedWeight; // Start with full load


//         optimizedRoute.forEach((stop, index) => {
//           const loadAtThisStop = vehicleAllocation.products
//             .filter(prod =>
//               prod.destinationLocation.latitude === stop.end.latitude &&
//               prod.destinationLocation.longitude === stop.end.longitude
//             )
//             .map(prod => ({
//               product_ID: prod.product_ID,
//               quantity: prod.allocatedQuantity
//             }));


//           // Reduce load after each stop
//           loadAtThisStop.forEach(prod => {
//             remainingLoad -= prod.quantity;
//           });


//           loadArrangement.unshift({
//             stop: index + 1,
//             location: stop.end.address,
//             products: loadAtThisStop
//           });
//         });


//         routes.push({
//           vehicle_ID: vehicle.vehicle_ID,
//           totalWeightCapacity: vehicle.totalWeightCapacity,
//           totalVolumeCapacity: vehicle.totalVolumeCapacity,
//           leftoverWeight: vehicleAllocation.leftoverWeight,
//           leftoverVolume: vehicleAllocation.leftoverVolume,
//           loadArrangement,
//           route: optimizedRoute
//         });
//       }
//     }


//     return res.status(200).json({ message: 'Order created successfully', allocations, routes });
//   } catch (error) {
//     logger.error('Error creating order:', error);
//     return res.status(500).json({ error: error.message });
//   }
// });


// module.exports = router;
