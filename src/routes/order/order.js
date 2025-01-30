
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

// // Google Maps Route Optimization
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
//             throw new Error(`Google Maps API Error: ${response.data.status}`);
//         }

//         const routeLegs = response.data.routes[0].legs;
//         const optimizedRoute = [];
//         let currentLoad = 0;

//         routeLegs.forEach((leg, index) => {
//             const shipmentLoad = shipmentLoads[index] || 0;
//             currentLoad += shipmentLoad;
//             optimizedRoute.push({
//                 start: leg.start_address,
//                 end: leg.end_address,
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

//         let totalOrderWeight = 0;
//         let totalOrderVolume = 0;

//         for (const product of resolvedProducts) {
//             const details = productMap[product.product_ID] || {};
//             const weight = parseWeightAndUOM(details.weight, details.weight_uom);
//             const volume = parseVolumeAndUOM(details.volume, details.volume_uom);
//             totalOrderWeight += weight * product.quantity;
//             totalOrderVolume += volume * product.quantity;
//         }

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

//                 // **FIX**: Get only relevant destinations for this vehicle
//                 const vehicleDestinations = [
//                     ...new Set(
//                         vehicleAllocation.products.map(p =>
//                             resolvedProducts.find(prod => prod.product_ID === p.product_ID).destinationLocation
//                         )
//                     )
//                 ];

//                 // Compute optimized route with filtered destinations
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


require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Convert weight & volume
function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
    if (!weightNumber || !weightUnit) return 0;
    return weightUnit.toLowerCase() === "ton" ? weightNumber * 1000 : weightNumber;
}

function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
    if (!volumeNumber || !volumeUnit) return 0;
    return volumeUnit.toLowerCase().includes("m") ? volumeNumber : volumeNumber / 1000;
}

// Resolve loc_ID to latitude/longitude
async function getLocationById(loc_ID) {
    const [rows] = await db.query(
        `SELECT latitude, longitude, loc_desc FROM master_locations WHERE loc_ID = ?`,
        [loc_ID]
    );
    if (rows.length === 0) throw new Error(`Location with loc_ID '${loc_ID}' not found.`);
    return { latitude: parseFloat(rows[0].latitude), longitude: parseFloat(rows[0].longitude), loc_desc: rows[0].loc_desc };
}

// Check vehicle validity
function isVehicleValid(vehicle) {
    if (!vehicle.transportation_details) return false;
    const today = new Date();
    const validityFrom = new Date(vehicle.transportation_details.validity_from);
    const validityTo = new Date(vehicle.transportation_details.validity_to);
    return today >= validityFrom && today <= validityTo;
}

// Check if vehicle is down for maintenance
function isVehicleDown(vehicle) {
    if (!vehicle.downtimes || !vehicle.downtimes.downtime_starts_from) return false;
    const today = new Date();
    const downtimeStart = new Date(vehicle.downtimes.downtime_starts_from);
    const downtimeEnd = new Date(vehicle.downtimes.downtime_ends_from);
    return today >= downtimeStart && today <= downtimeEnd;
}

// Google Maps Route Optimization - Includes lat/lng for UI
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

// Create Order API
router.post('/create-order', async (req, res) => {
    try {
        const { source, products } = req.body;
        if (!source || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'Invalid request payload' });
        }

        // Resolve source location
        const sourceLocation = await getLocationById(source);

        // Resolve product destinations
        const resolvedProducts = await Promise.all(
            products.map(async (product) => {
                const destinationLocation = await getLocationById(product.destination);
                return { ...product, destinationLocation };
            })
        );

        // Fetch product details
        const productIDs = resolvedProducts.map((p) => p.product_ID);
        const [rows] = await db.query(
            `SELECT product_ID, weight, weight_uom, volume, volume_uom FROM master_products WHERE product_ID IN (?)`,
            [productIDs]
        );

        const productMap = {};
        rows.forEach((row) => (productMap[row.product_ID] = row));

        // Fetch vehicles
        const [dbVehicles] = await db.query(`SELECT * FROM master_vehicles`);
        let vehicles = dbVehicles.map((v) => ({
            ...v,
            transportation_details: typeof v.transportation_details === "string" ? JSON.parse(v.transportation_details) : v.transportation_details || {},
            downtimes: typeof v.downtimes === "string" ? JSON.parse(v.downtimes) : v.downtimes || {},
            capacity: typeof v.capacity === "string" ? JSON.parse(v.capacity) : v.capacity || {},
            weightCapKg: convertVehicleWeight(v.capacity?.payload_weight, v.capacity?.payload_weight_unit),
            volumeCapM3: convertVehicleVolume(v.capacity?.cubic_capacity, v.capacity?.cubic_capacity_unit),
            ownership: v.transportation_details?.ownership || "carrier"
        }));

        // Apply vehicle selection conditions
        vehicles = vehicles.filter(v => isVehicleValid(v) && !isVehicleDown(v));
        vehicles.sort((a, b) => {
            if (b.unlimited_usage !== a.unlimited_usage) return b.unlimited_usage - a.unlimited_usage;
            return (b.ownership === "self" ? 1 : 0) - (a.ownership === "self" ? 1 : 0);
        });

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
                const details = productMap[product.product_ID];
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
                    vehicleAllocation.products.push({ product_ID: product.product_ID, allocatedQuantity: maxQuantity });
                    product.quantity -= maxQuantity;
                    vehicle.weightCapKg -= maxQuantity * weightPerUnit;
                    vehicle.volumeCapM3 -= maxQuantity * volumePerUnit;
                }
            }

            vehicleAllocation.leftoverWeight = originalWeightCap - vehicleAllocation.allocatedWeight;
            vehicleAllocation.leftoverVolume = originalVolumeCap - vehicleAllocation.allocatedVolume;

            if (vehicleAllocation.products.length > 0) {
                allocations.push(vehicleAllocation);

                const vehicleDestinations = [...new Set(vehicleAllocation.products.map(p =>
                    resolvedProducts.find(prod => prod.product_ID === p.product_ID).destinationLocation
                ))];

                const optimizedRoute = await getOptimizedRouteWithLoad(
                    [sourceLocation, ...vehicleDestinations],
                    vehicleAllocation.products.map(p => p.allocatedQuantity)
                );

                routes.push({ vehicle_ID: vehicle.vehicle_ID, route: optimizedRoute });
            }
        }

        return res.status(200).json({ message: 'Order created successfully', allocations, routes });
    } catch (error) {
        logger.error('Error creating order:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;
