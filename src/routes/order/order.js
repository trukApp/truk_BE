const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { parseWeightAndUOM, parseVolumeAndUOM } = require('./unitParser');

function convertVehicleWeight(weightNumber = 0, weightUnit = "") {
  if (!weightNumber || !weightUnit) {
    console.warn('Missing weightNumber or weightUnit:', weightNumber, weightUnit);
    return 0;
  }
  const lower = weightUnit.toLowerCase();
  if (lower === "ton") return weightNumber * 1000;
  if (lower === "kg") return weightNumber;
  return 0;
}

function convertVehicleVolume(volumeNumber = 0, volumeUnit = "") {
  if (!volumeNumber || !volumeUnit) {
    console.warn('Missing volumeNumber or volumeUnit:', volumeNumber, volumeUnit);
    return 0;
  }
  const lower = volumeUnit.toLowerCase();
  if (lower.includes("m")) return volumeNumber;
  if (lower.includes("l")) return volumeNumber / 1000;
  return 0;
}

router.post('/create-order', async (req, res) => {
  try {
    const { source, products } = req.body;
    if (!source || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Invalid request payload' });
    }

    // Fetch product details
    const productIDs = products.map((p) => p.product_ID);
    const [rows] = await db.query(`
      SELECT product_ID, weight, weight_uom, volume, volume_uom
      FROM master_products
      WHERE product_ID IN (?)
    `, [productIDs]);

    const productMap = {};
    rows.forEach((row) => (productMap[row.product_ID] = row));

    // Initialize remaining products
    const remainingProducts = products.map((product) => ({
      ...product,
      remainingQuantity: product.quantity,
    }));

    // Total order weight and volume
    let totalOrderWeight = 0;
    let totalOrderVolume = 0;

    for (const product of products) {
      const details = productMap[product.product_ID] || {};
      const weight = parseWeightAndUOM(details.weight, details.weight_uom);
      const volume = parseVolumeAndUOM(details.volume, details.volume_uom);

      totalOrderWeight += weight * product.quantity;
      totalOrderVolume += volume * product.quantity;
    }

    console.log('--- Total Order ---');
    console.log('Weight (kg):', totalOrderWeight);
    console.log('Volume (m^3):', totalOrderVolume);

    // Fetch vehicles
    const [dbVehicles] = await db.query(`
      SELECT veh_id, vehicle_ID, unlimited_usage, transportation_details, capacity
      FROM master_vehicles
    `);

    const vehicles = dbVehicles.map((v) => {
      let capacity = {};
      if (typeof v.capacity === 'string') {
        try {
          capacity = JSON.parse(v.capacity); // Parse stringified JSON
        } catch (e) {
          console.error(`Error parsing capacity for vehicle ${v.vehicle_ID}:`, e.message);
        }
      } else if (typeof v.capacity === 'object' && v.capacity !== null) {
        capacity = v.capacity; // Already an object
      }

      return {
        ...v,
        weightCapKg: convertVehicleWeight(capacity.payload_weight, capacity.payload_weight_unit),
        volumeCapM3: convertVehicleVolume(capacity.cubic_capacity, capacity.cubic_capacity_unit),
      };
    });

    // Sort vehicles by unlimited usage and ownership
    vehicles.sort((a, b) => {
      if (b.unlimited_usage !== a.unlimited_usage) return b.unlimited_usage - a.unlimited_usage;
      return (b.transportation_details.ownership === 'self') - (a.transportation_details.ownership === 'self');
    });

    // Allocate products to vehicles
    const allocations = [];
    for (const vehicle of vehicles) {
      const vehicleAllocation = {
        vehicle_ID: vehicle.vehicle_ID,
        allocatedWeight: 0,
        allocatedVolume: 0,
        products: [],
      };

      for (const product of remainingProducts) {
        const productDetails = productMap[product.product_ID];
        const weightPerUnit = parseWeightAndUOM(productDetails.weight, productDetails.weight_uom);
        const volumePerUnit = parseVolumeAndUOM(productDetails.volume, productDetails.volume_uom);

        const maxQuantityByWeight = Math.floor(vehicle.weightCapKg / weightPerUnit);
        const maxQuantityByVolume = Math.floor(vehicle.volumeCapM3 / volumePerUnit);
        const allocatableQuantity = Math.min(maxQuantityByWeight, maxQuantityByVolume, product.remainingQuantity);

        if (allocatableQuantity > 0) {
          vehicleAllocation.allocatedWeight += allocatableQuantity * weightPerUnit;
          vehicleAllocation.allocatedVolume += allocatableQuantity * volumePerUnit;
          vehicleAllocation.products.push({
            product_ID: product.product_ID,
            allocatedQuantity: allocatableQuantity,
          });

          product.remainingQuantity -= allocatableQuantity;
          vehicle.weightCapKg -= allocatableQuantity * weightPerUnit;
          vehicle.volumeCapM3 -= allocatableQuantity * volumePerUnit;
        }
      }

      if (vehicleAllocation.allocatedWeight > 0 || vehicleAllocation.allocatedVolume > 0) {
        allocations.push(vehicleAllocation);
      }
    }

    // Filter out products with remainingQuantity === 0
    const unallocatedProducts = remainingProducts.filter((p) => p.remainingQuantity > 0);

    if (unallocatedProducts.length > 0) {
      console.log('Remaining Products:', unallocatedProducts);
      return res.status(400).json({
        error: 'Not enough vehicle capacity to fulfill the order.',
        remainingProducts: unallocatedProducts,
      });
    }

    return res.status(200).json({
      message: 'Order created successfully',
      totalWeightKg: totalOrderWeight,
      totalVolumeM3: totalOrderVolume,
      allocations,
    });
  } catch (err) {
    logger.error('Error creating order:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;





