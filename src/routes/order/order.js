require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Helper: Convert vehicle weight/volume
function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
  if (!weightNumber || !weightUnit) return 0;
  const lower = weightUnit.toLowerCase();
  return lower === "ton" ? weightNumber * 1000 : weightNumber;
}

function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
  if (!volumeNumber || !volumeUnit) return 0;
  const lower = volumeUnit.toLowerCase();
  return lower.includes("m") ? volumeNumber : volumeNumber / 1000;
}

// Helper: Resolve loc_ID to latitude/longitude
async function getLocationById(loc_ID) {
  const [rows] = await db.query(
    `SELECT latitude, longitude, loc_desc FROM master_locations WHERE loc_ID = ?`,
    [loc_ID]
  );
  if (rows.length === 0) throw new Error(`Location with loc_ID '${loc_ID}' not found.`);
  const { latitude, longitude, loc_desc } = rows[0];
  return { latitude: parseFloat(latitude), longitude: parseFloat(longitude), loc_desc };
}

// Google Maps Route Optimization
const getOptimizedRouteWithLoad = async (locations, vehicleLoadLimit, shipmentLoads) => {
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
      throw new Error(`Google Maps API Error: ${response.data.status}`);
    }

    const routeLegs = response.data.routes[0].legs;
    const optimizedRoute = [];
    let currentLoad = 0;

    routeLegs.forEach((leg, index) => {
      const shipmentLoad = shipmentLoads[index] || 0;
      optimizedRoute.push({
        start: leg.start_address,
        end: leg.end_address,
        distance: leg.distance.text,
        duration: leg.duration.text,
        loadAfterStop: currentLoad + shipmentLoad,
      });
      currentLoad += shipmentLoad;
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

    // Resolve destinations
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

    let totalOrderWeight = 0;
    let totalOrderVolume = 0;

    for (const product of resolvedProducts) {
      const details = productMap[product.product_ID] || {};
      const weight = parseWeightAndUOM(details.weight, details.weight_uom);
      const volume = parseVolumeAndUOM(details.volume, details.volume_uom);
      totalOrderWeight += weight * product.quantity;
      totalOrderVolume += volume * product.quantity;
    }

    // Fetch vehicles
    const [dbVehicles] = await db.query(`SELECT veh_id, vehicle_ID, transportation_details, capacity FROM master_vehicles`);
    const vehicles = dbVehicles.map((v) => {
      let capacity = {};
      try {
        capacity = typeof v.capacity === 'string' ? JSON.parse(v.capacity) : v.capacity || {};
      } catch (e) {
        throw new Error(`Invalid JSON in capacity for vehicle ${v.vehicle_ID}: ${e.message}`);
      }

      return {
        ...v,
        weightCapKg: convertVehicleWeight(capacity.payload_weight, capacity.payload_weight_unit),
        volumeCapM3: convertVehicleVolume(capacity.cubic_capacity, capacity.cubic_capacity_unit),
      };
    });

    vehicles.sort((a, b) => b.weightCapKg - a.weightCapKg);

    const allocations = [];
    const routes = [];
    for (const vehicle of vehicles) {
      const vehicleAllocation = {
        vehicle_ID: vehicle.vehicle_ID,
        allocatedWeight: 0,
        allocatedVolume: 0,
        leftoverWeight: vehicle.weightCapKg,
        leftoverVolume: vehicle.volumeCapM3,
        products: [],
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
          vehicleAllocation.leftoverWeight -= maxQuantity * weightPerUnit;
          vehicleAllocation.leftoverVolume -= maxQuantity * volumePerUnit;
          vehicleAllocation.products.push({
            product_ID: product.product_ID,
            allocatedQuantity: maxQuantity,
          });

          product.quantity -= maxQuantity;
          vehicle.weightCapKg -= maxQuantity * weightPerUnit;
          vehicle.volumeCapM3 -= maxQuantity * volumePerUnit;
        }
      }

      if (vehicleAllocation.products.length > 0) {
        allocations.push(vehicleAllocation);

        const destinations = vehicleAllocation.products.map((p) =>
          resolvedProducts.find((prod) => prod.product_ID === p.product_ID).destinationLocation
        );

        const optimizedRoute = await getOptimizedRouteWithLoad(
          [sourceLocation, ...destinations],
          vehicle.weightCapKg,
          vehicleAllocation.products.map((p) => p.allocatedQuantity)
        );
        routes.push({ vehicle_ID: vehicle.vehicle_ID, route: optimizedRoute });
      }
    }

    return res.status(200).json({
      message: 'Order created successfully',
      totalWeightKg: totalOrderWeight,
      totalVolumeM3: totalOrderVolume,
      allocations,
      routes,
    });
  } catch (error) {
    logger.error('Error creating order:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
