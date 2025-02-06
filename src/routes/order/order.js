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
    const waypoints = locations.slice(1, -1)
        .map(loc => `${loc.latitude},${loc.longitude}`)
        .join('|');

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&waypoints=optimize:true|${waypoints}&key=${GOOGLE_API_KEY}`;

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
        });

        return optimizedRoute;
    } catch (error) {
        console.error('Error optimizing route:', error.message);
        throw error;
    }
};

// ✅ Restore isVehicleValid Function
function isVehicleValid(vehicle) {
    if (!vehicle.transportation_details) return false;
    const today = new Date();
    const validityFrom = new Date(vehicle.transportation_details.validity_from);
    const validityTo = new Date(vehicle.transportation_details.validity_to);
    return today >= validityFrom && today <= validityTo;
}

// ✅ Restore isVehicleDown Function
function isVehicleDown(vehicle) {
    if (!vehicle.downtimes || !vehicle.downtimes.downtime_starts_from) return false;
    const today = new Date();
    const downtimeStart = new Date(vehicle.downtimes.downtime_starts_from);
    const downtimeEnd = new Date(vehicle.downtimes.downtime_ends_from);
    return today >= downtimeStart && today <= downtimeEnd;
}

// ✅ Restore convertVehicleWeight Function
function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
    if (!weightNumber || !weightUnit) return 0;
    return weightUnit.toLowerCase() === "ton" ? weightNumber * 1000 : parseFloat(weightNumber);
}

// ✅ Restore convertVehicleVolume Function
function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
    if (!volumeNumber || !volumeUnit) return 0;
    return volumeUnit.toLowerCase().includes("m") ? parseFloat(volumeNumber) : parseFloat(volumeNumber) / 1000;
}

// ✅ Restore getLocationById function
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


// ✅ Safe JSON Parsing Function
function safeJsonParse(value, defaultValue = []) {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch (error) {
            console.error(`JSON Parse Error: ${error.message} | Input:`, value);
            return defaultValue;
        }
    }
    return value || defaultValue; // If already an object, return as is
}

// ✅ Fetch package details with Fix
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
        products: safeJsonParse(pkg.product_ID), // ✅ Fix applied here
    }));
}

// ✅ Create Order API (Fixed)
router.post('/create-order', async (req, res) => {
    try {
        const { packages: packageIDs } = req.body;
        if (!Array.isArray(packageIDs) || packageIDs.length === 0) {
            return res.status(400).json({ error: 'No valid package IDs provided.' });
        }

        // Fetch package details
        const packagesData = await getPackagesByIds(packageIDs);
        const sourceLocation = await getLocationById(packagesData[0].ship_from);

        // Resolve product destinations
        const resolvedProducts = await Promise.all(
            packagesData.flatMap(pkg =>
                pkg.products.map(async (product) => {
                    const destinationLocation = await getLocationById(pkg.ship_to);
                    return { ...product, destinationLocation };
                })
            )
        );

        // Fetch product details
        const productIDs = resolvedProducts.map((p) => p.prod_ID);
        const placeholdersProducts = productIDs.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT product_ID, weight, weight_uom, volume, volume_uom FROM master_products WHERE product_ID IN (${placeholdersProducts})`,
            productIDs
        );

        const productMap = {};
        rows.forEach((row) => (productMap[row.product_ID] = row));

        // Fetch vehicles
        const [dbVehicles] = await db.query(`SELECT * FROM master_vehicles`);
        let vehicles = dbVehicles.map((v) => ({
            ...v,
            transportation_details: safeJsonParse(v.transportation_details),
            downtimes: safeJsonParse(v.downtimes),
            capacity: safeJsonParse(v.capacity),
            weightCapKg: convertVehicleWeight(v.capacity?.payload_weight, v.capacity?.payload_weight_unit),
            volumeCapM3: convertVehicleVolume(v.capacity?.cubic_capacity, v.capacity?.cubic_capacity_unit),
            ownership: v.transportation_details?.ownership || "carrier"
        }));

        // Apply vehicle selection conditions
        vehicles = vehicles.filter(v => isVehicleValid(v) && !isVehicleDown(v));
        vehicles.sort((a, b) => b.unlimited_usage - a.unlimited_usage || (b.ownership === "self" ? 1 : 0) - (a.ownership === "self" ? 1 : 0));

        const allocations = [];
        const routes = [];

        for (const vehicle of vehicles) {
            let originalWeightCap = vehicle.weightCapKg;
            let originalVolumeCap = vehicle.volumeCapM3;

            const vehicleAllocation = { 
                vehicle_ID: vehicle.vehicle_ID, 
                allocatedWeight: 0, 
                allocatedVolume: 0, 
                products: [] 
            };

            for (const product of resolvedProducts) {
                const details = productMap[product.prod_ID];
                const weightPerUnit = parseWeightAndUOM(details.weight, details.weight_uom);
                const volumePerUnit = parseVolumeAndUOM(details.volume, details.volume_uom);

                const maxQuantity = Math.min(
                    Math.floor(vehicle.weightCapKg / weightPerUnit),
                    Math.floor(vehicle.volumeCapM3 / volumePerUnit),
                    product.quantity
                );

                if (maxQuantity > 0) {
                    vehicleAllocation.allocatedWeight += maxQuantity * weightPerUnit;
                    vehicleAllocation.allocatedVolume += maxQuantity * volumePerUnit;
                    vehicleAllocation.products.push({ product_ID: product.prod_ID, allocatedQuantity: maxQuantity });
                    product.quantity -= maxQuantity;
                    vehicle.weightCapKg -= maxQuantity * weightPerUnit;
                    vehicle.volumeCapM3 -= maxQuantity * volumePerUnit;
                }
            }

            if (vehicleAllocation.products.length > 0) {
                allocations.push(vehicleAllocation);
            
                // ✅ Fix: Ensure Unique Destinations
                const uniqueDestinations = [...new Map(
                    vehicleAllocation.products.map(p => [p.product_ID, resolvedProducts.find(prod => prod.prod_ID === p.product_ID).destinationLocation])
                ).values()];
            
                const optimizedRoute = await getOptimizedRouteWithLoad(
                    [sourceLocation, ...uniqueDestinations],
                    vehicleAllocation.products.map(p => p.allocatedQuantity)
                );
            
                routes.push({ vehicle_ID: vehicle.vehicle_ID, route: optimizedRoute });
            }
            
        }

        return res.status(200).json({ message: 'Order created successfully', allocations, routes });
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

// // Convert weight & volume
// function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
//     if (!weightNumber || !weightUnit) return 0;
//     return weightUnit.toLowerCase() === "ton" ? weightNumber * 1000 : weightNumber;
// }

// function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
//     if (!volumeNumber || !volumeUnit) return 0;
//     return volumeUnit.toLowerCase().includes("m") ? volumeNumber : volumeNumber / 1000;
// }

// // Resolve loc_ID to latitude/longitude
// async function getLocationById(loc_ID) {
//     const [rows] = await db.query(
//         `SELECT latitude, longitude, loc_desc FROM master_locations WHERE loc_ID = ?`,
//         [loc_ID]
//     );
//     if (rows.length === 0) throw new Error(`Location with loc_ID '${loc_ID}' not found.`);
//     return { latitude: parseFloat(rows[0].latitude), longitude: parseFloat(rows[0].longitude), loc_desc: rows[0].loc_desc };
// }

// // Check vehicle validity
// function isVehicleValid(vehicle) {
//     if (!vehicle.transportation_details) return false;
//     const today = new Date();
//     const validityFrom = new Date(vehicle.transportation_details.validity_from);
//     const validityTo = new Date(vehicle.transportation_details.validity_to);
//     return today >= validityFrom && today <= validityTo;
// }

// // Check if vehicle is down for maintenance
// function isVehicleDown(vehicle) {
//     if (!vehicle.downtimes || !vehicle.downtimes.downtime_starts_from) return false;
//     const today = new Date();
//     const downtimeStart = new Date(vehicle.downtimes.downtime_starts_from);
//     const downtimeEnd = new Date(vehicle.downtimes.downtime_ends_from);
//     return today >= downtimeStart && today <= downtimeEnd;
// }

// // Google Maps Route Optimization - Includes lat/lng for UI
// const getOptimizedRouteWithLoad = async (locations, shipmentLoads) => {
//     if (!Array.isArray(locations) || locations.some(loc => !loc.latitude || !loc.longitude)) {
//         throw new Error("Invalid locations array. Ensure all locations have latitude and longitude.");
//     }

//     const origin = locations[0];
//     const destination = locations[locations.length - 1];
//     const waypoints = locations.slice(1, -1)
//         .map(loc => `${loc.latitude},${loc.longitude}`)
//         .join('|');

//     const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&waypoints=optimize:true|${waypoints}&key=${GOOGLE_API_KEY}`;

//     try {
//         const response = await axios.get(url);
//         if (response.data.status !== 'OK') {
//           console.error("Google API Error Response:", response.data);
//             throw new Error(`Google Maps API Error: ${response.data.status}`);
//         }

//         const routeLegs = response.data.routes[0].legs;
//         const optimizedRoute = [];
//         let currentLoad = 0;

//         routeLegs.forEach((leg, index) => {
//             const shipmentLoad = shipmentLoads[index] || 0;
//             currentLoad += shipmentLoad;
//             optimizedRoute.push({
//                 start: {
//                     address: leg.start_address,
//                     latitude: locations[index].latitude,
//                     longitude: locations[index].longitude
//                 },
//                 end: {
//                     address: leg.end_address,
//                     latitude: locations[index + 1].latitude,
//                     longitude: locations[index + 1].longitude
//                 },
//                 distance: leg.distance.text,
//                 duration: leg.duration.text,
//                 loadAfterStop: currentLoad,
//             });
//         });

//         return optimizedRoute;
//     } catch (error) {
//         console.error('Error optimizing route:', error.message);
//         throw error;
//     }
// };

// // Create Order API
// router.post('/create-order', async (req, res) => {
//     try {
//         const { source, products } = req.body;
//         if (!source || !Array.isArray(products) || products.length === 0) {
//             return res.status(400).json({ error: 'Invalid request payload' });
//         }

//         // Resolve source location
//         const sourceLocation = await getLocationById(source);

//         // Resolve product destinations
//         const resolvedProducts = await Promise.all(
//             products.map(async (product) => {
//                 const destinationLocation = await getLocationById(product.destination);
//                 return { ...product, destinationLocation };
//             })
//         );

//         // Fetch product details
//         const productIDs = resolvedProducts.map((p) => p.product_ID);
//         const [rows] = await db.query(
//             `SELECT product_ID, weight, weight_uom, volume, volume_uom FROM master_products WHERE product_ID IN (?)`,
//             [productIDs]
//         );

//         const productMap = {};
//         rows.forEach((row) => (productMap[row.product_ID] = row));

//         // Fetch vehicles
//         const [dbVehicles] = await db.query(`SELECT * FROM master_vehicles`);
//         let vehicles = dbVehicles.map((v) => ({
//             ...v,
//             transportation_details: typeof v.transportation_details === "string" ? JSON.parse(v.transportation_details) : v.transportation_details || {},
//             downtimes: typeof v.downtimes === "string" ? JSON.parse(v.downtimes) : v.downtimes || {},
//             capacity: typeof v.capacity === "string" ? JSON.parse(v.capacity) : v.capacity || {},
//             weightCapKg: convertVehicleWeight(v.capacity?.payload_weight, v.capacity?.payload_weight_unit),
//             volumeCapM3: convertVehicleVolume(v.capacity?.cubic_capacity, v.capacity?.cubic_capacity_unit),
//             ownership: v.transportation_details?.ownership || "carrier"
//         }));

//         // Apply vehicle selection conditions
//         vehicles = vehicles.filter(v => isVehicleValid(v) && !isVehicleDown(v));
//         vehicles.sort((a, b) => {
//             if (b.unlimited_usage !== a.unlimited_usage) return b.unlimited_usage - a.unlimited_usage;
//             return (b.ownership === "self" ? 1 : 0) - (a.ownership === "self" ? 1 : 0);
//         });

//         const allocations = [];
//         const routes = [];

//         for (const vehicle of vehicles) {
//             let originalWeightCap = vehicle.weightCapKg;
//             let originalVolumeCap = vehicle.volumeCapM3;

//             const vehicleAllocation = { 
//                 vehicle_ID: vehicle.vehicle_ID, 
//                 allocatedWeight: 0, 
//                 allocatedVolume: 0, 
//                 products: [] 
//             };

//             for (const product of resolvedProducts) {
//                 const details = productMap[product.product_ID];
//                 const weightPerUnit = parseWeightAndUOM(details.weight, details.weight_uom);
//                 const volumePerUnit = parseVolumeAndUOM(details.volume, details.volume_uom);
                
//                 const maxQuantity = Math.min(
//                     Math.floor(vehicle.weightCapKg / weightPerUnit),
//                     Math.floor(vehicle.volumeCapM3 / volumePerUnit),
//                     product.quantity
//                 );

//                 if (maxQuantity > 0) {
//                     vehicleAllocation.allocatedWeight += maxQuantity * weightPerUnit;
//                     vehicleAllocation.allocatedVolume += maxQuantity * volumePerUnit;
//                     vehicleAllocation.products.push({ product_ID: product.product_ID, allocatedQuantity: maxQuantity });
//                     product.quantity -= maxQuantity;
//                     vehicle.weightCapKg -= maxQuantity * weightPerUnit;
//                     vehicle.volumeCapM3 -= maxQuantity * volumePerUnit;
//                 }
//             }

//             vehicleAllocation.leftoverWeight = originalWeightCap - vehicleAllocation.allocatedWeight;
//             vehicleAllocation.leftoverVolume = originalVolumeCap - vehicleAllocation.allocatedVolume;

//             if (vehicleAllocation.products.length > 0) {
//                 allocations.push(vehicleAllocation);

//                 const vehicleDestinations = [...new Set(vehicleAllocation.products.map(p =>
//                     resolvedProducts.find(prod => prod.product_ID === p.product_ID).destinationLocation
//                 ))];

//                 const optimizedRoute = await getOptimizedRouteWithLoad(
//                     [sourceLocation, ...vehicleDestinations],
//                     vehicleAllocation.products.map(p => p.allocatedQuantity)
//                 );

//                 routes.push({ vehicle_ID: vehicle.vehicle_ID, route: optimizedRoute });
//             }
//         }

//         return res.status(200).json({ message: 'Order created successfully', allocations, routes });
//     } catch (error) {
//         logger.error('Error creating order:', error.message);
//         return res.status(500).json({ error: error.message });
//     }
// });

// module.exports = router;