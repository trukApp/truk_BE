const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');
const { parseWeightToKg, parseVolumeToM3 } = require('./unitParser');
require('dotenv').config();


router.post('/create-order', /*jwtAuth.verifyToken,*/ async (req, res) => {
  try {
    // 1) Parse input
    /*
      Payload example:
      {
        "source": { "latitude": 17.42, "longitude": 78.34 },
        "products": [
          {
            "product_ID": "PROD000001",
            "quantity": 2,
            "destination": { "latitude": 17.50, "longitude": 78.40 }
          },
          {
            "product_ID": "PROD000002",
            "quantity": 5,
            "destination": { "latitude": 17.45, "longitude": 78.45 }
          }
        ]
      }
    */
    const { source, products } = req.body;
    if (!source || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Invalid request payload' });
    }

    // 2) Gather product IDs from the request
    const productIDs = products.map(p => p.product_ID);
    if (!productIDs.length) {
      return res.status(400).json({ error: 'No product IDs provided' });
    }

    // 3) Fetch product records from master_products
    const [rows] = await db.query(`
      SELECT product_ID, weight, volume 
      FROM master_products
      WHERE product_ID IN (?)
    `, [productIDs]);

    // Convert rows to a map for quick lookup
    const productMap = {};
    rows.forEach(r => {
      productMap[r.product_ID] = r;
    });

    // 4) Sum total weight/volume
    let totalWeightKg = 0;
    let totalVolumeM3 = 0;

    // We'll store the "destinations" for route optimization
    const destinations = [];

    for (const item of products) {
      const { product_ID, quantity = 1, destination } = item;
      const prodRecord = productMap[product_ID];

      if (!prodRecord) {
        return res.status(400).json({ 
          error: `Product ID ${product_ID} not found in DB`
        });
      }

      // parse DB weight/volume
      const wKg = parseWeightToKg(prodRecord.weight || "0");
      const vM3 = parseVolumeToM3(prodRecord.volume || "0");

      totalWeightKg += wKg * quantity;
      totalVolumeM3 += vM3 * quantity;

      // collect the destination for route planning
      destinations.push(destination);
    }

    // 5) Fetch vehicles from master_vehicles
    const [dbVehicles] = await db.query(`
      SELECT 
        veh_id,
        vehicle_ID,
        unlimited_usage,
        transportation_details,
        capacity
      FROM master_vehicles
    `);

    // Parse capacity and sort vehicles
    const vehicles = dbVehicles.map(v => {
      let transport = {};
      let cap = {};
      try { transport = JSON.parse(v.transportation_details || '{}'); } catch {}
      try { cap = JSON.parse(v.capacity || '{}'); } catch {}

      // Convert capacity to numeric
      const vehicleWeightCapKg = parseWeightToKg(cap.payload_weight || '0');
      const vehicleVolumeCapM3 = parseVolumeToM3(cap.cubic_capacity || '0');

      return {
        ...v,
        transport,
        vehicleWeightCapKg,
        vehicleVolumeCapM3,
      };
    });

    // Sort:
    //  - unlimited_usage desc (1 before 0)
    //  - then by ownership = 'self' before 'carrier'
    vehicles.sort((a, b) => {
      if (b.unlimited_usage !== a.unlimited_usage) {
        return b.unlimited_usage - a.unlimited_usage;
      }
      const ownA = a.transport.ownership === 'self' ? 1 : 0;
      const ownB = b.transport.ownership === 'self' ? 1 : 0;
      return ownB - ownA;
    });

    // 6) Greedy allocation
    let remainingWeight = totalWeightKg;
    let remainingVolume = totalVolumeM3;
    const vehicleAllocations = [];

    for (const veh of vehicles) {
      if (remainingWeight <= 0 && remainingVolume <= 0) break;

      const canTakeWeight = Math.min(veh.vehicleWeightCapKg, remainingWeight);
      const canTakeVolume = Math.min(veh.vehicleVolumeCapM3, remainingVolume);

      if (canTakeWeight > 0 && canTakeVolume > 0) {
        // allocate to this vehicle
        remainingWeight -= canTakeWeight;
        remainingVolume -= canTakeVolume;
        vehicleAllocations.push({
          vehicle_ID: veh.vehicle_ID,
          allocatedWeight: canTakeWeight,
          allocatedVolume: canTakeVolume,
        });
      }
    }

    // Check if we still have leftover
    if (remainingWeight > 0 || remainingVolume > 0) {
      return res.status(400).json({
        error: 'Not enough vehicle capacity for this order.',
        totalWeightKg,
        totalVolumeM3,
      });
    }

    // 7) (Optional) Route Optimization 
    // If you want to see how to route from source to each product's destination:
    //   - Let Google reorder them to minimize travel time/distance
    //   - If multiple vehicles carry partial loads (multiple routes), 
    //     you'd group destinations per vehicle. For simplicity, let's assume 
    //     a single route for demonstration.

    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    let optimizedRoute = null;

    if (destinations.length) {
      // Build origin, waypoints, destination for Google
      // We can set the final destination to the last item, or come back to source, etc.
      // For demonstration, let's set the final destination to the last product's location
      const origin = `${source.latitude},${source.longitude}`;
      const lastDestination = destinations[destinations.length - 1];
      const destString = `${lastDestination.latitude},${lastDestination.longitude}`;

      // The intermediate stops (waypoints) are the other destinations
      const middleWaypoints = destinations.slice(0, -1)
        .map(d => `${d.latitude},${d.longitude}`)
        .join('|');

      const routeURL = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destString}&waypoints=optimize:true|${middleWaypoints}&key=${GOOGLE_API_KEY}`;

      try {
        const response = await axios.get(routeURL);
        if (response.data.status === 'OK') {
          optimizedRoute = response.data.routes[0];
        } else {
          console.warn('Google Maps API error:', response.data.status);
        }
      } catch (error) {
        console.warn('Error calling Google Maps Directions API:', error.message);
      }
    }

    // 8) Return the result
    return res.json({
      message: 'Order created & vehicles allocated successfully',
      totalWeightKg,
      totalVolumeM3,
      vehiclesUsed: vehicleAllocations,
      route: optimizedRoute, // or a simplified route
    });
  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(500).json({
      error: error.message || 'Internal Server Error'
    });
  }
});

module.exports = router;



