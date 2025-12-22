const express = require('express');
const router = express.Router();

const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');
const cfg = require('../../config');
const { Pool } = require('pg');

// reuse your existing helper
const { parseWeightAndUOM } = require('../order/unitParser');

// ---- Timescale (optional; used only if include_gps=1) ----
let tsPool = null;
function getTsPool() {
  if (!tsPool) {
    tsPool = new Pool({
      host: cfg.ts.host,
      port: cfg.ts.port,
      database: cfg.ts.database,
      user: cfg.ts.user,
      password: cfg.ts.password,
    });
  }
  return tsPool;
}

// ---- tiny helpers ----
const j = (x, d = null) => {
  try { return typeof x === 'string' ? JSON.parse(x) : (x ?? d); }
  catch { return d; }
};
const toNum = (v) => (v === null || v === undefined ? null : Number(v));

function isVehicleValid(transportation_details) {
  try {
    const from = new Date(transportation_details?.validity_from);
    const to   = new Date(transportation_details?.validity_to);
    const now  = new Date();
    if (isNaN(from) || isNaN(to)) return true; // if not provided, don’t block
    return now >= from && now <= to;
  } catch { return true; }
}
function isVehicleDown(downtimes) {
  try {
    const s = new Date(downtimes?.downtime_starts_from);
    const e = new Date(downtimes?.downtime_ends_from);
    const now = new Date();
    if (isNaN(s) || isNaN(e)) return false;
    return now >= s && now <= e;
  } catch { return false; }
}

// GET /ai/fleet
// Query params (all optional):
//  - available_only=1 (default 1) -> validity window & not in downtime
//  - min_payload_kg=####
//  - needs_temp_ctrl=1
//  - needs_hazmat=1
//  - city=Hyderabad  (matches any registered location city)
//  - include_gps=1   (best-effort Timescale fetch)
//  - page, limit     (simple array slice; defaults 1/50)
router.get('/fleet', jwtAuth.verifyToken, async (req, res) => {
  try {
    const {
      available_only = '1',
      min_payload_kg,
      needs_temp_ctrl,
      needs_hazmat,
      city,
      include_gps,
      page = '1',
      limit = '10',
    } = req.query;

    // 1) load vehicles
    const [rows] = await db.query(`SELECT * FROM master_resources`);

    // 2) optional: get latest GPS per vehicle from Timescale
    const gpsByVeh = {};
    if (include_gps === '1') {
      try {
        const ts = getTsPool();
        // latest row per vehicle_id (Timescale/Postgres)
        const gpsSQL = `
          SELECT DISTINCT ON (vehicle_id)
            vehicle_id, ts, lat, lon, speed_kph, heading_deg
          FROM gps_points
          ORDER BY vehicle_id, ts DESC
        `;
        const { rows: gpsRows } = await ts.query(gpsSQL);
        for (const g of gpsRows) gpsByVeh[g.vehicle_id] = g;
      } catch (e) {
        logger.warn('[ai/fleet] gps fetch failed: ' + e.message);
      }
    }

    // 3) prefetch all locations referenced in loc_ID arrays (one shot)
    // collect all loc_IDs into a Set
    const allLocIds = new Set();
    for (const r of rows) {
      const locs = j(r.loc_ID, []);
      (Array.isArray(locs) ? locs : [locs]).filter(Boolean).forEach(id => allLocIds.add(id));
    }

    let locById = {};
    if (allLocIds.size) {
      const ids = [...allLocIds];
      const ph = ids.map(() => '?').join(',');
      const [locRows] = await db.query(
        `SELECT loc_ID, loc_desc, latitude, longitude, city, state, country, pincode
         FROM master_locations WHERE loc_ID IN (${ph})`,
        ids
      );
      locById = locRows.reduce((m, r) => (m[r.loc_ID] = r, m), {});
    }

    // 4) shape + filter
    const shaped = [];
    for (const v of rows) {
      const caps = j(v.capacity, {});
      const tdet = j(v.transportation_details, {});
      const dwt  = j(v.downtimes, {});
      const add  = j(v.additional_details, {});
      const locs = j(v.loc_ID, []);
      const locArr = Array.isArray(locs) ? locs : (locs ? [locs] : []);

      const registered_locations = locArr
        .map(id => locById[id])
        .filter(Boolean)
        .map(L => ({
          loc_ID: L.loc_ID,
          address: L.loc_desc,
          latitude: toNum(L.latitude),
          longitude: toNum(L.longitude),
          city: L.city, state: L.state, country: L.country, pincode: L.pincode
        }));

      const payloadKg = parseWeightAndUOM(caps.payload_weight, caps.payload_weight_unit);

      const shapedRow = {
        vehicle_ID: v.vehicle_ID,
        ownership: tdet?.ownership || null,
        type: tdet?.vehicle_type || null,
        validity_from: tdet?.validity_from || null,
        validity_to: tdet?.validity_to || null,

        flags: {
          fragile_vehicle: !!v.fragile_vehicle,
          danger_proof: !!v.danger_proof,
          hazardous_proof: !!v.hazardous_proof,
          temp_controlled_vehicle: !!v.temp_controlled_vehicle,
        },

        capacities: {
          payload_kg: payloadKg ?? null,
          interior: {
            length: caps?.interior_length || null,
            width:  caps?.interior_width  || null,
            height: caps?.interior_height || null,
          },
          cubic_capacity: {
            value: caps?.cubic_capacity ?? null,
            unit:  caps?.cubic_capacity_unit || null
          }
        },

        registered_locations,

        live_location: gpsByVeh[v.vehicle_ID] ? {
          ts: gpsByVeh[v.vehicle_ID].ts,
          lat: gpsByVeh[v.vehicle_ID].lat,
          lon: gpsByVeh[v.vehicle_ID].lon,
          speed_kph: gpsByVeh[v.vehicle_ID].speed_kph,
          heading_deg: gpsByVeh[v.vehicle_ID].heading_deg
        } : null,

        downtime: dwt,
        cost_model: { cost_per_ton: toNum(add?.cost_per_ton) },

        // placeholder until driver tables exist
        driver_schedule: null
      };

      // availability filter
      if (available_only === '1') {
        if (!isVehicleValid(tdet)) continue;
        if (isVehicleDown(dwt)) continue;
      }

      // capability filters
      if (min_payload_kg && (shapedRow.capacities.payload_kg ?? 0) < Number(min_payload_kg)) continue;
      if (needs_temp_ctrl === '1' && !shapedRow.flags.temp_controlled_vehicle) continue;
      if (needs_hazmat === '1' && !shapedRow.flags.hazardous_proof) continue;

      // city filter (match any registered city)
      if (city) {
        const hit = shapedRow.registered_locations.some(L => (L.city || '').toLowerCase() === String(city).toLowerCase());
        if (!hit) continue;
      }

      shaped.push(shapedRow);
    }

    // 5) simple pagination (array slice)
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 50);
    const start = (pageNum - 1) * limitNum;
    const end = start + limitNum;

    const paged = shaped.slice(start, end);

    return res.status(200).json({
      message: 'Fleet data fetched successfully',
      count: shaped.length,
      page: pageNum,
      limit: limitNum,
      vehicles: paged
    });

  } catch (error) {
    logger.error('[ai/fleet] error: ', error);
    return res.status(500).json({ message: 'Error fetching fleet.', error: error.message });
  }
});


const PACKAGES_TABLE = 'packages';

// Parse "50m", "1km", "100" to { value: number, unit: 'm'|'km'|null, meters: number|null }
function parseRadius(s) {
  if (!s) return { value: null, unit: null, meters: null };
  const raw = String(s).trim().toLowerCase();
  const m = raw.match(/^(\d+(?:\.\d+)?)(\s*)(m|km)?$/i);
  if (!m) return { value: null, unit: null, meters: null };
  const val = Number(m[1]);
  const unit = (m[3] || 'm').toLowerCase();
  const meters = unit === 'km' ? val * 1000 : val;
  return { value: val, unit, meters };
}

// GET /ai/loads
// Query params (all optional):
//  - status=ordered|...       -> packages.package_status
//  - pickup_from=YYYY-MM-DD   -> inclusive
//  - pickup_to=YYYY-MM-DD     -> inclusive
//  - dropoff_from=YYYY-MM-DD  -> inclusive
//  - dropoff_to=YYYY-MM-DD    -> inclusive
//  - from_city=Chennai        -> ship_from city (case-insensitive)
//  - to_city=Hyderabad        -> ship_to city (case-insensitive)
//  - city=Chennai             -> either ship_from OR ship_to city
//  - bill_to=LOC000011        -> filter by bill_to loc_ID
//  - q=PACK0000               -> pack_ID "like" search
//  - page, limit              -> pagination (defaults 1/10)
router.get('/loads', jwtAuth.verifyToken, async (req, res) => {
  try {
    const {
      status,
      pickup_from,
      pickup_to,
      dropoff_from,
      dropoff_to,
      from_city,
      to_city,
      city,
      bill_to,
      q,
      page = '1',
      limit = '10',
    } = req.query;

    const where = [];
    const params = [];

    // simple filters
    if (status) {
      where.push(`p.package_status = ?`);
      params.push(String(status));
    }
    if (bill_to) {
      where.push(`TRIM(p.bill_to) = ?`);
      params.push(String(bill_to).trim());
    }
    if (q) {
      where.push(`p.pack_ID LIKE ?`);
      params.push(`%${q}%`);
    }

    // date filters (cast to DATETIME to normalize 'YYYY-MM-DD hh:mm' and ISO 'T' forms)
    if (pickup_from) {
      where.push(`CAST(p.pickup_date_time AS DATETIME) >= CAST(? AS DATETIME)`);
      params.push(pickup_from);
    }
    if (pickup_to) {
      where.push(`CAST(p.pickup_date_time AS DATETIME) <= CAST(? AS DATETIME)`);
      params.push(pickup_to);
    }
    if (dropoff_from) {
      where.push(`CAST(p.dropoff_date_time AS DATETIME) >= CAST(? AS DATETIME)`);
      params.push(dropoff_from);
    }
    if (dropoff_to) {
      where.push(`CAST(p.dropoff_date_time AS DATETIME) <= CAST(? AS DATETIME)`);
      params.push(dropoff_to);
    }

    // location city filters (case-insensitive)
    if (from_city) {
      where.push(`LOWER(sf.city) = LOWER(?)`);
      params.push(String(from_city));
    }
    if (to_city) {
      where.push(`LOWER(st.city) = LOWER(?)`);
      params.push(String(to_city));
    }
    if (city) {
      where.push(`(LOWER(sf.city) = LOWER(?) OR LOWER(st.city) = LOWER(?))`);
      params.push(String(city), String(city));
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Count for pagination
    const [cntRows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM ${PACKAGES_TABLE} p
      LEFT JOIN master_locations sf ON TRIM(sf.loc_ID) = TRIM(p.ship_from)
      LEFT JOIN master_locations st ON TRIM(st.loc_ID) = TRIM(p.ship_to)
      LEFT JOIN master_locations bt ON TRIM(bt.loc_ID) = TRIM(p.bill_to)
      ${whereSQL}
      `,
      params
    );
    const total = Number(cntRows[0]?.total || 0);

    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const offset   = (pageNum - 1) * limitNum;

    // Fetch paged results
    const [rows] = await db.query(
      `
      SELECT
        p.pac_id, p.pack_ID, p.ship_from, p.ship_to, p.destination_radius,
        p.product_ID, p.package_info, p.bill_to, p.return_label, p.additional_info,
        p.pickup_date_time, p.dropoff_date_time, p.tax_info, p.package_status,

        -- ship_from details
        sf.loc_ID   AS sf_loc_ID,  sf.loc_desc AS sf_desc,  sf.latitude AS sf_lat,  sf.longitude AS sf_lon,
        sf.city     AS sf_city,    sf.state    AS sf_state, sf.country  AS sf_country, sf.pincode AS sf_pincode,
        sf.address_1 AS sf_addr1,  sf.address_2 AS sf_addr2,
        sf.contact_name AS sf_contact, sf.contact_phone_number AS sf_phone, sf.contact_email AS sf_email,

        -- ship_to details
        st.loc_ID   AS st_loc_ID,  st.loc_desc AS st_desc,  st.latitude AS st_lat,  st.longitude AS st_lon,
        st.city     AS st_city,    st.state    AS st_state, st.country  AS st_country, st.pincode AS st_pincode,
        st.address_1 AS st_addr1,  st.address_2 AS st_addr2,
        st.contact_name AS st_contact, st.contact_phone_number AS st_phone, st.contact_email AS st_email,

        -- bill_to (client) details
        bt.loc_ID   AS bt_loc_ID,  bt.loc_desc AS bt_desc,  bt.latitude AS bt_lat,  bt.longitude AS bt_lon,
        bt.city     AS bt_city,    bt.state    AS bt_state, bt.country  AS bt_country, bt.pincode AS bt_pincode,
        bt.address_1 AS bt_addr1,  bt.address_2 AS bt_addr2,
        bt.contact_name AS bt_contact, bt.contact_phone_number AS bt_phone, bt.contact_email AS bt_email

      FROM ${PACKAGES_TABLE} p
      LEFT JOIN master_locations sf ON TRIM(sf.loc_ID) = TRIM(p.ship_from)
      LEFT JOIN master_locations st ON TRIM(st.loc_ID) = TRIM(p.ship_to)
      LEFT JOIN master_locations bt ON TRIM(bt.loc_ID) = TRIM(p.bill_to)
      ${whereSQL}
      ORDER BY p.pac_id
      LIMIT ? OFFSET ?
      `,
      [...params, limitNum, offset]
    );

    const loads = rows.map(r => {
      const items = j(r.product_ID, []) || [];
      const addl  = j(r.additional_info, {}) || {};
      const tax   = j(r.tax_info, {}) || {};
      const radius = parseRadius(r.destination_radius);

      const pickup_address = r.sf_loc_ID ? {
        loc_ID: r.sf_loc_ID,
        address: r.sf_desc,
        latitude: toNum(r.sf_lat),
        longitude: toNum(r.sf_lon),
        city: r.sf_city, state: r.sf_state, country: r.sf_country, pincode: r.sf_pincode,
        address_1: r.sf_addr1, address_2: r.sf_addr2,
        contact: { name: r.sf_contact, phone: r.sf_phone, email: r.sf_email }
      } : null;

      const delivery_address = r.st_loc_ID ? {
        loc_ID: r.st_loc_ID,
        address: r.st_desc,
        latitude: toNum(r.st_lat),
        longitude: toNum(r.st_lon),
        city: r.st_city, state: r.st_state, country: r.st_country, pincode: r.st_pincode,
        address_1: r.st_addr1, address_2: r.st_addr2,
        contact: { name: r.st_contact, phone: r.st_phone, email: r.st_email }
      } : null;

      const client = r.bt_loc_ID ? {
        id: r.bt_loc_ID,
        name: r.bt_desc,
        address: {
          address: r.bt_desc,
          latitude: toNum(r.bt_lat),
          longitude: toNum(r.bt_lon),
          city: r.bt_city, state: r.bt_state, country: r.bt_country, pincode: r.bt_pincode,
          address_1: r.bt_addr1, address_2: r.bt_addr2
        },
        contact: { name: r.bt_contact, phone: r.bt_phone, email: r.bt_email }
      } : null;

      return {
        load_id: r.pack_ID,
        status: r.package_status || null,

        // time windows (if only a single timestamp is given, start=end)
        time_windows: {
          pickup:  { start: r.pickup_date_time || null,  end: r.pickup_date_time || null },
          dropoff: { start: r.dropoff_date_time || null, end: r.dropoff_date_time || null }
        },

        // addresses
        pickup_address,
        delivery_address,

        // client for multi-client grouping
        client,

        // items (product list)
        items: Array.isArray(items) ? items.map(it => ({
          prod_ID: it.prod_ID ?? null,
          quantity: toNum(it.quantity)
        })) : [],

        // optional fields, normalized
        destination_radius: r.destination_radius || null,
        destination_radius_parsed: radius, // {value, unit, meters}
        return_label: !!Number(r.return_label),

        // bookkeeping / extras
        package_info: r.package_info || null,
        additional_info: addl,
        tax_info: tax
      };
    });

    return res.status(200).json({
      message: 'Load data fetched successfully',
      count: total,
      page: pageNum,
      limit: limitNum,
      loads
    });
  } catch (error) {
    logger.error('[ai/loads] error: ', error);
    return res.status(500).json({ message: 'Error fetching loads.', error: error.message });
  }
});


module.exports = router;
