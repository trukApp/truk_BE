require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();

const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');
const polyline = require('@mapbox/polyline');
const cfg = require('../../config');

const GOOGLE_API_KEY = cfg.googleApiKey;

/* ---------------- SAFE JSON PARSER ---------------- */
function safeParseJSON(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

/* ---------------- CREATE ORDER API ---------------- */
router.post('/create-order', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { lor_nums } = req.body;

    if (!Array.isArray(lor_nums) || lor_nums.length === 0) {
      return res.status(400).json({
        message: 'lor_nums array is required'
      });
    }

    await conn.beginTransaction();

    /* ------------------------------------------------
       1️⃣ LOCK & VALIDATE LORs
    ------------------------------------------------ */
    const [lors] = await conn.query(
      `SELECT * FROM lor_data WHERE lor_num IN (?) FOR UPDATE`,
      [lor_nums]
    );

    if (lors.length !== lor_nums.length) {
      throw new Error('Invalid LOR selection');
    }

    for (const lor of lors) {
      if (lor.order_ID) {
        throw new Error(`LOR ${lor.lor_num} already linked to an order`);
      }
    }

    /* ------------------------------------------------
       2️⃣ COLLECT PACKAGE IDS
    ------------------------------------------------ */
    const packageIDs = lors.flatMap(l =>
      safeParseJSON(l.packages)
    );

    if (!packageIDs.length) {
      throw new Error('Selected LORs contain no packages');
    }

    /* ------------------------------------------------
       3️⃣ FETCH PACKAGES
    ------------------------------------------------ */
    const [packages] = await conn.query(
      `SELECT * FROM packages WHERE pack_ID IN (?)`,
      [packageIDs]
    );

    if (!packages.length) {
      throw new Error('No packages found');
    }

    /* ------------------------------------------------
       4️⃣ VALIDATE SINGLE SOURCE
    ------------------------------------------------ */
    const sourceSet = new Set(packages.map(p => p.ship_from));
    if (sourceSet.size !== 1) {
      throw new Error('All packages must have the same source to create an order');
    }

    const sourceLoc = [...sourceSet][0];

    /* ------------------------------------------------
       5️⃣ CALCULATE TOTAL WEIGHT (TONS)
    ------------------------------------------------ */
    let totalWeightKg = 0;

    for (const pkg of packages) {
      const products = safeParseJSON(pkg.product_ID);

      for (const p of products) {
        const qty = Number(p.quantity);
        if (!qty || qty <= 0) continue;

        const [[prod]] = await conn.query(
          `SELECT weight, weight_uom FROM master_products WHERE product_ID = ?`,
          [p.prod_ID]
        );

        if (!prod || !prod.weight) continue;

        let weightKg = Number(prod.weight);
        const uom = (prod.weight_uom || '').toLowerCase();

        if (uom === 'ton') {
          weightKg *= 1000;
        }

        totalWeightKg += weightKg * qty;
      }
    }

    const totalWeightTons = +(totalWeightKg / 1000).toFixed(3);

    /* ------------------------------------------------
       6️⃣ BUILD DESTINATION LIST (UNIQUE)
    ------------------------------------------------ */
    const destinationSet = new Set(packages.map(p => p.ship_to));
    const destinations = [...destinationSet];

    /* ------------------------------------------------
       7️⃣ FETCH LOCATION DETAILS
    ------------------------------------------------ */
    const allLocIDs = [sourceLoc, ...destinations];

    const [locations] = await conn.query(
      `SELECT loc_ID, loc_desc, latitude, longitude 
       FROM master_locations 
       WHERE loc_ID IN (?)`,
      [allLocIDs]
    );

    const locMap = {};
    locations.forEach(l => locMap[l.loc_ID] = l);

    /* ------------------------------------------------
       8️⃣ BUILD STOPS (SOURCE → DESTINATIONS)
    ------------------------------------------------ */
    const orderedStops = [sourceLoc, ...destinations];

    const stops = orderedStops.map((loc_ID, idx) => ({
      stop: idx + 1,
      loc_ID,
      loc_desc: locMap[loc_ID]?.loc_desc || null
    }));

    /* ------------------------------------------------
       9️⃣ GOOGLE MAPS ROUTE
    ------------------------------------------------ */
    const origin = `${locMap[sourceLoc].latitude},${locMap[sourceLoc].longitude}`;
    const waypointCoords = destinations
      .slice(0, -1)
      .map(d => `${locMap[d].latitude},${locMap[d].longitude}`)
      .join('|');
    const destination = `${locMap[destinations.at(-1)].latitude},${locMap[destinations.at(-1)].longitude}`;

    const mapsResp = await axios.get(
      'https://maps.googleapis.com/maps/api/directions/json',
      {
        params: {
          origin,
          destination,
          waypoints: waypointCoords || undefined,
          key: GOOGLE_API_KEY
        }
      }
    );

    if (!mapsResp.data.routes.length) {
      throw new Error('Unable to calculate route');
    }

    const route = mapsResp.data.routes[0];
    const decodedRoute = polyline.decode(route.overview_polyline.points);

    let totalDistanceMeters = 0;
    route.legs.forEach(l => {
      totalDistanceMeters += l.distance.value;
    });

    const totalDistanceKm = +(totalDistanceMeters / 1000).toFixed(2);

    /* ------------------------------------------------
       🔟 GENERATE ORDER ID
    ------------------------------------------------ */
    const [[last]] = await conn.query(
      `SELECT ord_ID FROM orders_data ORDER BY ordr_id DESC LIMIT 1 FOR UPDATE`
    );

    const lastSeq = last
      ? parseInt(last.ord_ID.replace('ORD', ''), 10)
      : 0;

    const ord_ID = `ORD${String(lastSeq + 1).padStart(7, '0')}`;

    /* ------------------------------------------------
       1️⃣1️⃣ INSERT ORDER
    ------------------------------------------------ */
    await conn.query(
      `INSERT INTO orders_data (
        ord_ID, LOR, packages,
        total_weight, total_weight_units,
        total_distance, total_distance_units,
        order_docs, created_at,
        assignment_status, sample_route,
        stops, order_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ord_ID,
        JSON.stringify(lor_nums),
        JSON.stringify(packageIDs),
        totalWeightTons,
        'ton',
        totalDistanceKm,
        'km',
        JSON.stringify({}),
        new Date().toISOString(),
        null,
        JSON.stringify(decodedRoute),
        JSON.stringify(stops),
        'created'
      ]
    );

    /* ------------------------------------------------
       1️⃣2️⃣ LOCK LORs
    ------------------------------------------------ */
    await conn.query(
      `UPDATE lor_data SET order_ID = ? WHERE lor_num IN (?)`,
      [ord_ID, lor_nums]
    );

    await conn.commit();

    return res.status(201).json({
      message: 'Order created successfully',
      ord_ID,
      total_weight: `${totalWeightTons} ton`,
      total_distance: `${totalDistanceKm} km`,
      source: sourceLoc,
      destinations,
      stops
    });

  } catch (err) {
    await conn.rollback();
    logger.error('Error creating order', err);
    return res.status(500).json({
      message: err.message || 'Server error'
    });
  } finally {
    conn.release();
  }
});

module.exports = router;
