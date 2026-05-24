// const express = require('express');
// const router = express.Router();
// const db = require('../../../dbConnection');
// const { logger } = require('../../logger/logger');
// const { applyPagination } = require('../../pagination/paginate');
// const jwtAuth = require('../../JWT/jwtAuth');
// const { createTrackingSession } = require('./trackingService');


// // ===== LR helpers =====
// const LR_PREFIX = 'TALRN';
// const LR_CUSTOMER = 'REL';

// // Safely parse JSON-ish fields
// function tryJson(v, def = {}) {
//   try { return (typeof v === 'string' ? JSON.parse(v) : (v || def)); } catch { return def; }
// }

// // Atomic LR number generator (must be called inside an open transaction)
// async function getNextLRNum(conn) {
//   // Lock the current max row (if any) to prevent race
//   const [rows] = await conn.query(
//     `SELECT CAST(SUBSTRING(lr_num, 6, 8) AS UNSIGNED) AS num
//        FROM lr_invoice
//       WHERE lr_num LIKE CONCAT(?, '%')
//       ORDER BY num DESC
//       LIMIT 1
//       FOR UPDATE`, [LR_PREFIX]
//   );
//   const last = rows.length ? Number(rows[0].num) || 0 : -1; // start from -1 so first becomes 0
//   const next = last + 1;
//   const seq = String(next).padStart(8, '0');
//   return `${LR_PREFIX}${seq}${LR_CUSTOMER}`;
// }


// router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     const {
//       scenario_label,
//       total_cost,
//       allocations,
//       unallocated_packages,
//       created_at,
//       updated_at,
//       order_docs,
//       bill_of_lading
//     } = req.body;

//     if (!scenario_label || total_cost == null) {
//       await conn.rollback();
//       return res.status(400).json({ message: 'Missing required fields: scenario_label, total_cost.' });
//     }

//     const allPackages = (allocations || []).flatMap(a => a.packages || []);
//     if (!allPackages.length) {
//       await conn.rollback();
//       return res.status(400).json({ message: 'No valid packages found for confirmation.' });
//     }

//     // Packages already confirmed?
//     const placeholders = allPackages.map(() => '?').join(',');
//     const [existingPackages] = await conn.query(
//       `SELECT pack_ID FROM packages
//         WHERE pack_ID IN (${placeholders})
//           AND package_status = 'ordered'`,
//       allPackages
//     );
//     if (existingPackages.length > 0) {
//       await conn.rollback();
//       const alreadyConfirmedPackages = existingPackages.map(r => r.pack_ID);
//       return res.status(400).json({
//         message: 'Some packages are already confirmed in an existing order.',
//         alreadyConfirmedPackages
//       });
//     }

//     // Last order id (lock the newest row to safely increment)
//     const [result] = await conn.query(`
//       SELECT order_ID
//         FROM orders
//     ORDER BY ord_id DESC
//        LIMIT 1
//        FOR UPDATE
//     `);
//     let lastOrderID = result[0]?.order_ID || 'ORD000000';
//     let numericPart = parseInt(lastOrderID.slice(3), 10);

//     // Load package → location (+ additional_info for invoices)
//     const [packageLocs] = await conn.query(
//       `SELECT pack_ID, ship_from, ship_to, destination_radius, additional_info
//          FROM packages
//         WHERE pack_ID IN (${placeholders})`,
//       allPackages
//     );
//     const packToLocMap = {};
//     for (const row of packageLocs) packToLocMap[row.pack_ID] = row;

//     const createdOrders = [];

//     // Process each allocation as a separate order row
//     for (const alloc of (allocations || [])) {
//       numericPart++;
//       const padded = String(numericPart).padStart(6, '0');
//       const newOrderID = 'ORD' + padded;

//       const allocJson = JSON.stringify([alloc]);
//       const allocatedPackagesJson = JSON.stringify(alloc.packages || []);
//       const allocatedVehiclesJson = JSON.stringify([alloc.vehicle_ID]);

//       // Route-based data
//       const routeInfo = alloc.route?.[0] || {};
//       const distanceVal = parseFloat(String(routeInfo.distance || '').replace(/[^\d.]/g, '')) || 0;
//       const weightVal = alloc.occupiedWeight || 0;

//       const firstPkg = alloc.packages?.[0];
//       const lastPkg = alloc.packages?.[alloc.packages.length - 1];
//       const startLocID = packToLocMap[firstPkg]?.ship_from || null;
//       const endLocID = packToLocMap[lastPkg]?.ship_to || null;

//       await createTrackingSession({
//         conn,
//         order_ID: newOrderID,
//         vehicle_ID: alloc.vehicle_ID,
//         device_ID: alloc.device_ID || null, // later from assignment
//         loadArrangement: alloc.loadArrangement,
//         packToLocMap,
//         route: alloc.route
//       });


//       // package_dest_radius
//       const packageRadiusData = (alloc.packages || []).map(packID => {
//         const pkg = packToLocMap[packID] || {};
//         return { pack_ID: pkg.pack_ID, ship_to: pkg.ship_to, destination_radius: pkg.destination_radius ?? null };
//       });

//       // Insert order row
//       await conn.query(`
//         INSERT INTO orders
//           (order_ID, scenario_label, total_cost, allocations, total_weight, total_distance,
//            start_loc_ID, end_loc_ID, allocated_packages, unallocated_packages, allocated_vehicles,
//            package_dest_radius, created_at, updated_at, order_docs, order_status, bill_of_lading)
//         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//       `, [
//         newOrderID,
//         scenario_label,
//         alloc.cost || 0,
//         allocJson,
//         Number(weightVal).toFixed(2),
//         Number(distanceVal).toFixed(2),
//         startLocID,
//         endLocID,
//         allocatedPackagesJson,
//         JSON.stringify(unallocated_packages || []),
//         allocatedVehiclesJson,
//         JSON.stringify(packageRadiusData),
//         created_at || new Date().toISOString(),
//         updated_at || new Date().toISOString(),
//         JSON.stringify(order_docs || []),
//         "assignment pending",
//         JSON.stringify(bill_of_lading)
//       ]);

//       // Mark packages → ordered
//       if (alloc.packages?.length) {
//         const pkgPlaceholders = alloc.packages.map(() => '?').join(',');
//         await conn.query(
//           `UPDATE packages SET package_status = 'ordered' WHERE pack_ID IN (${pkgPlaceholders})`,
//           alloc.packages
//         );
//       }

//       // ========== NEW: Create LR rows per stop ==========
//       // Group the allocation’s packages by their stop (alloc.loadArrangement)
//       // Each stop => one LR row (if multiple ship_to locs appear in the same stop, split by ship_to)
//       const stops = Array.isArray(alloc.loadArrangement) ? alloc.loadArrangement : [];
//       for (const stop of stops) {
//         const pkgsAtStop = Array.isArray(stop.packages) ? stop.packages : [];
//         if (!pkgsAtStop.length) continue;

//         // Further group by ship_to (usually all equal, but handle robustly)
//         const byShipTo = new Map();
//         for (const pid of pkgsAtStop) {
//           const meta = packToLocMap[pid];
//           if (!meta) continue;
//           const shipTo = meta.ship_to;
//           if (!byShipTo.has(shipTo)) byShipTo.set(shipTo, []);
//           byShipTo.get(shipTo).push(pid);
//         }

//         for (const [shipTo, pkgs] of byShipTo.entries()) {
//           // Build packages_in_data with invoice pulled from packages.additional_info.invoice
//           const packages_in_data = pkgs.map(pid => {
//             const meta = packToLocMap[pid] || {};
//             const addl = tryJson(meta.additional_info, {});
//             return { pack_ID: pid, invoice: addl?.invoice ?? null, e_way: null };
//           });

//           const lr_num = await getNextLRNum(conn); // atomic counter within txn

//           await conn.query(
//             `INSERT INTO lr_invoice (lr_num, order_ID, ship_from, ship_to, packages_in_data)
//              VALUES (?, ?, ?, ?, ?)`,
//             [lr_num, newOrderID, startLocID, shipTo, JSON.stringify(packages_in_data)]
//           );
//         }
//       }
//       // ======== END NEW: LR creation ========

//       createdOrders.push({
//         order_ID: newOrderID,
//         vehicle_ID: alloc.vehicle_ID,
//         allocated_packages: alloc.packages || [],
//         cost: alloc.cost || 0
//       });
//     }

//     await conn.commit();
//     return res.status(201).json({
//       message: 'Orders confirmed successfully.',
//       scenario_label,
//       created_orders: createdOrders,
//       unallocated_packages: unallocated_packages || []
//     });
//   } catch (error) {
//     try { await conn.rollback(); } catch { }
//     logger.error('Error confirming order:', error);
//     return res.status(500).json({ message: error.message || 'Server error.' });
//   } finally {
//     try { conn.release(); } catch { }
//   }
// });


// // router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
// //     try {
// //         const {
// //             scenario_label,
// //             total_cost,
// //             allocations,
// //             unallocated_packages,
// //             created_at,
// //             updated_at,
// //             order_docs,
// //             bill_of_lading
// //         } = req.body;

// //         if (!scenario_label || total_cost == null) {
// //             return res.status(400).json({
// //                 message: 'Missing required fields: scenario_label, total_cost.'
// //             });
// //         }

// //         const allPackages = allocations.flatMap(alloc => alloc.packages || []);

// //         if (allPackages.length === 0) {
// //             return res.status(400).json({
// //                 message: 'No valid packages found for confirmation.'
// //             });
// //         }

// //         const placeholders = allPackages.map(() => '?').join(',');
// //         const [existingPackages] = await db.query(
// //             `SELECT pack_ID FROM packages 
// //            WHERE pack_ID IN (${placeholders}) 
// //              AND package_status = 'ordered'`,
// //             allPackages
// //         );
// //         if (existingPackages.length > 0) {
// //             const alreadyConfirmedPackages = existingPackages.map(row => row.pack_ID);
// //             return res.status(400).json({
// //                 message: 'Some packages are already confirmed in an existing order.',
// //                 alreadyConfirmedPackages
// //             });
// //         }

// //         const [result] = await db.query(`
// //           SELECT order_ID 
// //           FROM orders 
// //           ORDER BY ord_id DESC 
// //           LIMIT 1 FOR UPDATE
// //       `);
// //         let lastOrderID = result[0]?.order_ID || 'ORD000000';
// //         let numericPart = parseInt(lastOrderID.slice(3), 10);

// //         // Get package -> location mapping
// //         const [packageLocs] = await db.query(
// //             `SELECT pack_ID, ship_from, ship_to, destination_radius FROM packages WHERE pack_ID IN (${placeholders})`,
// //             allPackages
// //         );
// //         const packToLocMap = Object.fromEntries(packageLocs.map(row => [row.pack_ID, row]));

// //         const createdOrders = [];

// //         for (const alloc of allocations) {
// //             numericPart++;
// //             const padded = String(numericPart).padStart(6, '0');
// //             const newOrderID = 'ORD' + padded;

// //             const allocJson = JSON.stringify([alloc]);
// //             const allocatedPackagesJson = JSON.stringify(alloc.packages || []);
// //             const allocatedVehiclesJson = JSON.stringify([alloc.vehicle_ID]);

// //             // Extract route-based data
// //             const routeInfo = alloc.route?.[0] || {};
// //             const distanceVal = parseFloat((routeInfo.distance || '').replace(/[^\d.]/g, '')) || 0;
// //             const weightVal = alloc.occupiedWeight || 0;

// //             const firstPkg = alloc.packages?.[0];
// //             const lastPkg = alloc.packages?.[alloc.packages.length - 1];
// //             const startLocID = packToLocMap[firstPkg]?.ship_from || null;
// //             const endLocID = packToLocMap[lastPkg]?.ship_to || null;

// //             // Extract package_dest_radius info
// //             const packageRadiusData = alloc.packages.map(packID => {
// //                 const pkg = packToLocMap[packID];
// //                 return {
// //                     pack_ID: pkg.pack_ID,
// //                     ship_to: pkg.ship_to,
// //                     destination_radius: pkg.destination_radius || null
// //                 };
// //             });

// //             await db.query(`
// //               INSERT INTO orders
// //                 (order_ID, scenario_label, total_cost, allocations, total_weight, total_distance, start_loc_ID, end_loc_ID,
// //                  allocated_packages, unallocated_packages, allocated_vehicles, package_dest_radius,
// //                  created_at, updated_at, order_docs, order_status, bill_of_lading)
// //               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
// //           `, [
// //                 newOrderID,
// //                 scenario_label,
// //                 alloc.cost || 0,
// //                 allocJson,
// //                 weightVal.toFixed(2),
// //                 distanceVal.toFixed(2),
// //                 startLocID,
// //                 endLocID,
// //                 allocatedPackagesJson,
// //                 JSON.stringify(unallocated_packages || []),
// //                 allocatedVehiclesJson,
// //                 JSON.stringify(packageRadiusData),
// //                 created_at || new Date().toISOString(),
// //                 updated_at || new Date().toISOString(),
// //                 JSON.stringify(order_docs || []),
// //                 "assignment pending",
// //                 JSON.stringify(bill_of_lading)
// //             ]);

// //             if (alloc.packages?.length) {
// //                 const pkgPlaceholders = alloc.packages.map(() => '?').join(',');
// //                 await db.query(
// //                     `UPDATE packages SET package_status = 'ordered' WHERE pack_ID IN (${pkgPlaceholders})`,
// //                     alloc.packages
// //                 );
// //             }

// //             createdOrders.push({
// //                 order_ID: newOrderID,
// //                 vehicle_ID: alloc.vehicle_ID,
// //                 allocated_packages: alloc.packages || [],
// //                 cost: alloc.cost || 0
// //             });
// //         }

// //         return res.status(201).json({
// //             message: 'Orders confirmed successfully.',
// //             scenario_label,
// //             created_orders: createdOrders,
// //             unallocated_packages: unallocated_packages || []
// //         });

// //     } catch (error) {
// //         logger.error('Error confirming order:', error);
// //         return res.status(500).json({
// //             message: error.message || 'Server error.'
// //         });
// //     }
// // });


// router.get('/all-orders', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { page, limit } = req.query;
//     let query = `SELECT * FROM orders ORDER BY created_at DESC`;
//     query = applyPagination(query, page, limit);

//     const [orders] = await db.query(query);
//     if (!orders.length) {
//       return res.status(404).json({ message: 'No orders found.' });
//     }

//     return res.status(200).json({ message: 'Orders retrieved successfully.', orders });
//   } catch (error) {
//     logger.error('Error fetching all orders:', error);
//     return res.status(500).json({ message: 'Server error.', error: error.message });
//   }
// });


// // router.get('/order-by-id', jwtAuth.verifyToken, async (req, res) => {
// //     try {
// //         const { order_ID } = req.query;
// //         if (!order_ID) {
// //             return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
// //         }

// //         // 1) fetch the order
// //         const [orderRows] = await db.query(
// //             `SELECT * FROM orders WHERE order_ID = ?`,
// //             [order_ID]
// //         );
// //         if (!orderRows.length) {
// //             return res.status(404).json({ message: 'Order not found.' });
// //         }
// //         const order = orderRows[0];

// //         // 2) parse the allocated package and vehicle arrays
// //         const safeParseList = val => {
// //             if (!val) return [];
// //             if (Array.isArray(val)) return val;
// //             try { return JSON.parse(val); }
// //             catch { return String(val).split(',').map(s => s.trim()); }
// //         };
// //         const allocatedPackages = safeParseList(order.allocated_packages);
// //         const allocatedVehicles = safeParseList(order.allocated_vehicles);

// //         // 3) load package details (with bill_to, product_ID, etc.)
// //         let packageDetails = [];
// //         if (allocatedPackages.length) {
// //             const ph = allocatedPackages.map(() => '?').join(',');
// //             const [rows] = await db.query(
// //                 `SELECT 
// //                p.pac_id, p.pack_ID, p.ship_from, p.ship_to, p.destination_radius,
// //                p.product_ID, p.package_info, p.bill_to, p.return_label,
// //                p.additional_info, p.pickup_date_time, p.dropoff_date_time,
// //                p.tax_info, p.package_status
// //              FROM packages p
// //              WHERE p.pack_ID IN (${ph})`,
// //                 allocatedPackages
// //             );

// //             // parse JSON columns & extract a uniform `product_lines` array
// //             packageDetails = rows.map(r => {
// //                 let product_lines = [];
// //                 if (typeof r.product_ID === 'string') {
// //                     try { product_lines = JSON.parse(r.product_ID); }
// //                     catch { product_lines = []; }
// //                 } else if (Array.isArray(r.product_ID)) {
// //                     product_lines = r.product_ID;
// //                 }

// //                 return {
// //                     pac_id: r.pac_id,
// //                     pack_ID: r.pack_ID,
// //                     ship_from: r.ship_from,
// //                     ship_to: r.ship_to,
// //                     destination_radius: r.destination_radius,
// //                     product_lines,                      // [{ prod_ID, quantity, package_info }, …]
// //                     package_info: r.package_info,
// //                     bill_to: r.bill_to,
// //                     return_label: r.return_label,
// //                     additional_info: (() => { try { return JSON.parse(r.additional_info) } catch { return {} } })(),
// //                     pickup_date_time: r.pickup_date_time,
// //                     dropoff_date_time: r.dropoff_date_time,
// //                     tax_info: (() => { try { return JSON.parse(r.tax_info) } catch { return {} } })(),
// //                     package_status: r.package_status
// //                 };
// //             });
// //         }

// //         // 4) fetch all involved master_products to get weight & uom
// //         const allProdIDs = [
// //             ...new Set(
// //                 packageDetails
// //                     .flatMap(pd => pd.product_lines.map(pl => pl.prod_ID))
// //                     .filter(id => id)
// //             )
// //         ];

// //         let weightMap = {};
// //         if (allProdIDs.length) {
// //             const [prodRows] = await db.query(
// //                 `SELECT product_ID, weight, weight_uom 
// //              FROM master_products 
// //              WHERE product_ID IN (?)`,
// //                 [allProdIDs]
// //             );
// //             weightMap = prodRows.reduce((m, pr) => {
// //                 m[pr.product_ID] = {
// //                     weight: parseFloat(pr.weight) || 0,
// //                     weight_uom: pr.weight_uom
// //                 };
// //                 return m;
// //             }, {});
// //         }

// //         // 5) compute per-package weights in a separate array
// //         const packagesAndWeights = packageDetails.map(pd => {
// //             const package_weight = pd.product_lines.reduce((sum, pl) => {
// //                 const info = weightMap[pl.prod_ID] || { weight: 0 };
// //                 return sum + info.weight * (pl.quantity || 0);
// //             }, 0);
// //             const uom = pd.product_lines.length
// //                 ? (weightMap[pd.product_lines[0].prod_ID]?.weight_uom || null)
// //                 : null;
// //             return {
// //                 pack_ID: pd.pack_ID,
// //                 package_weight: +package_weight.toFixed(2),
// //                 weight_uom: uom
// //             };
// //         });

// //         // 6) load vehicle details
// //         let vehicleDetails = [];
// //         if (allocatedVehicles.length) {
// //             const ph = allocatedVehicles.map(() => '?').join(',');
// //             const [rows] = await db.query(
// //                 `SELECT * FROM master_resources WHERE vehicle_ID IN (${ph})`,
// //                 allocatedVehicles
// //             );
// //             vehicleDetails = rows;
// //         }


// //         // 7) respond
// //         return res.status(200).json({
// //             message: 'Order retrieved successfully.',
// //             order,
// //             allocated_packages_details: packageDetails,
// //             packages_and_weights: packagesAndWeights,
// //             allocated_vehicles: vehicleDetails
// //         });
// //     }
// //     catch (err) {
// //         logger.error('Error fetching order by ID:', err);
// //         return res.status(500).json({ message: 'Server error.', error: err.message });
// //     }
// // }
// // );


// router.get('/order-by-id', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { order_ID } = req.query;
//     if (!order_ID) {
//       return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
//     }

//     // 1) fetch the order
//     const [orderRows] = await db.query(
//       `SELECT * FROM orders WHERE order_ID = ?`,
//       [order_ID]
//     );
//     if (!orderRows.length) {
//       return res.status(404).json({ message: 'Order not found.' });
//     }
//     const order = orderRows[0];

//     // helper to normalize arrays stored as JSON / CSV
//     const safeParseList = (val) => {
//       if (!val) return [];
//       if (Array.isArray(val)) return val;
//       try { return JSON.parse(val); }
//       catch { return String(val).split(',').map(s => s.trim()).filter(Boolean); }
//     };

//     // 2) parse the allocated package and vehicle arrays
//     const allocatedPackages = safeParseList(order.allocated_packages);
//     const allocatedVehicles = safeParseList(order.allocated_vehicles);

//     // 3) load package details (with bill_to, product_ID, etc.)
//     let packageDetails = [];
//     if (allocatedPackages.length) {
//       const ph = allocatedPackages.map(() => '?').join(',');
//       const [rows] = await db.query(
//         `SELECT 
//            p.pac_id, p.pack_ID, p.ship_from, p.ship_to, p.destination_radius,
//            p.product_ID, p.package_info, p.bill_to, p.return_label,
//            p.additional_info, p.pickup_date_time, p.dropoff_date_time,
//            p.tax_info, p.package_status
//          FROM packages p
//          WHERE p.pack_ID IN (${ph})`,
//         allocatedPackages
//       );

//       // parse JSON columns & extract a uniform `product_lines` array
//       packageDetails = rows.map(r => {
//         let product_lines = [];
//         if (typeof r.product_ID === 'string') {
//           try { product_lines = JSON.parse(r.product_ID); }
//           catch { product_lines = []; }
//         } else if (Array.isArray(r.product_ID)) {
//           product_lines = r.product_ID;
//         }

//         return {
//           pac_id: r.pac_id,
//           pack_ID: r.pack_ID,
//           ship_from: r.ship_from,
//           ship_to: r.ship_to,
//           destination_radius: r.destination_radius,
//           product_lines,                      // [{ prod_ID, quantity, package_info }, …]
//           package_info: r.package_info,
//           bill_to: r.bill_to,
//           return_label: r.return_label,
//           additional_info: (() => { try { return JSON.parse(r.additional_info) } catch { return {} } })(),
//           pickup_date_time: r.pickup_date_time,
//           dropoff_date_time: r.dropoff_date_time,
//           tax_info: (() => { try { return JSON.parse(r.tax_info) } catch { return {} } })(),
//           package_status: r.package_status
//         };
//       });
//     }

//     // 4) fetch all involved master_products to get weight & uom
//     const allProdIDs = [
//       ...new Set(
//         packageDetails
//           .flatMap(pd => pd.product_lines.map(pl => pl.prod_ID))
//           .filter(Boolean)
//       )
//     ];

//     let weightMap = {};
//     if (allProdIDs.length) {
//       const [prodRows] = await db.query(
//         `SELECT product_ID, weight, weight_uom 
//            FROM master_products 
//           WHERE product_ID IN (?)`,
//         [allProdIDs]
//       );
//       weightMap = prodRows.reduce((m, pr) => {
//         m[pr.product_ID] = {
//           weight: parseFloat(pr.weight) || 0,
//           weight_uom: pr.weight_uom
//         };
//         return m;
//       }, {});
//     }

//     // 5) compute per-package weights in a separate array
//     const packagesAndWeights = packageDetails.map(pd => {
//       const package_weight = pd.product_lines.reduce((sum, pl) => {
//         const info = weightMap[pl.prod_ID] || { weight: 0 };
//         return sum + info.weight * (pl.quantity || 0);
//       }, 0);
//       const uom = pd.product_lines.length
//         ? (weightMap[pd.product_lines[0].prod_ID]?.weight_uom || null)
//         : null;
//       return {
//         pack_ID: pd.pack_ID,
//         package_weight: +package_weight.toFixed(2),
//         weight_uom: uom
//       };
//     });

//     // 6) load vehicle details
//     let vehicleDetails = [];
//     if (allocatedVehicles.length) {
//       const ph = allocatedVehicles.map(() => '?').join(',');
//       const [rows] = await db.query(
//         `SELECT * FROM master_resources WHERE vehicle_ID IN (${ph})`,
//         allocatedVehicles
//       );
//       vehicleDetails = rows;
//     }

//     // 6.5) LR invoices linked to this order
//     const [lrRows] = await db.query(
//       `SELECT lr_id, lr_num, order_ID, ship_from, ship_to, packages_in_data
//          FROM lr_invoice
//         WHERE order_ID = ?
//         ORDER BY lr_id ASC`,
//       [order_ID]
//     );
//     const lr_invoices = lrRows.map(r => ({
//       lr_id: r.lr_id,
//       lr_num: r.lr_num,
//       order_ID: r.order_ID,
//       ship_from: r.ship_from,
//       ship_to: r.ship_to,
//       packages_in_data: (() => {
//         try { return JSON.parse(r.packages_in_data); }
//         catch { return r.packages_in_data; }
//       })()
//     }));

//     // 7) respond
//     return res.status(200).json({
//       message: 'Order retrieved successfully.',
//       order,
//       allocated_packages_details: packageDetails,
//       packages_and_weights: packagesAndWeights,
//       allocated_vehicles: vehicleDetails,
//       lr_invoices
//     });
//   } catch (err) {
//     logger.error('Error fetching order by ID:', err);
//     return res.status(500).json({ message: 'Server error.', error: err.message });
//   }
// });

// router.put('/edit-order', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { order_ID } = req.query;
//     const {
//       order_status,
//       allocated_packages,
//       allocated_vehicles,
//       order_docs,
//       bill_of_lading
//     } = req.body;

//     if (!order_ID) {
//       return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
//     }

//     const [orderExists] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
//     if (!orderExists.length) {
//       return res.status(404).json({ message: 'Order not found.' });
//     }

//     let updateFields = [];
//     let values = [];

//     if (order_status) {
//       updateFields.push('order_status = ?');
//       values.push(order_status);
//     }

//     if (allocated_packages) {
//       updateFields.push('allocated_packages = ?');
//       values.push(JSON.stringify(allocated_packages));
//     }

//     if (allocated_vehicles) {
//       updateFields.push('allocated_vehicles = ?');
//       values.push(JSON.stringify(allocated_vehicles));
//     }

//     if (order_docs) {
//       updateFields.push('order_docs = ?');
//       values.push(JSON.stringify(order_docs));
//     }

//     if (bill_of_lading) {
//       updateFields.push('bill_of_lading = ?');
//       values.push(JSON.stringify(bill_of_lading));
//     }

//     // Always update the timestamp
//     const now = new Date().toISOString();
//     updateFields.push('updated_at = ?');
//     values.push(now);

//     if (updateFields.length === 0) {
//       return res.status(400).json({ message: 'No fields provided for update.' });
//     }

//     values.push(order_ID);
//     const query = `UPDATE orders SET ${updateFields.join(', ')} WHERE order_ID = ?`;

//     await db.query(query, values);

//     return res.status(200).json({ message: 'Order updated successfully.', order_ID });
//   } catch (error) {
//     logger.error('Error updating order:', error);
//     return res.status(500).json({ message: 'Server error.', error: error.message });
//   }
// });



// router.put('/edit-lr-invoice', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { lr_num } = req.query;
//     if (!lr_num) {
//       return res.status(400).json({ message: 'Missing required query parameter: lr_num' });
//     }

//     // Does it exist?
//     const [rows] = await db.query(`SELECT * FROM lr_invoice WHERE lr_num = ?`, [lr_num]);
//     if (!rows.length) {
//       return res.status(404).json({ message: 'LR not found.' });
//     }

//     const { ship_from, ship_to, packages_in_data, order_ID } = req.body;

//     const updates = [];
//     const values = [];

//     // Optional: allow order_ID change (omit this block if you want it immutable)
//     if (typeof order_ID !== 'undefined') {
//       updates.push('order_ID = ?');
//       values.push(order_ID);
//     }
//     if (typeof ship_from !== 'undefined') {
//       updates.push('ship_from = ?');
//       values.push(ship_from);
//     }
//     if (typeof ship_to !== 'undefined') {
//       updates.push('ship_to = ?');
//       values.push(ship_to);
//     }
//     if (typeof packages_in_data !== 'undefined') {
//       let payload = packages_in_data;

//       // Accept string or object
//       if (typeof payload === 'string') {
//         try { payload = JSON.parse(payload); }
//         catch {
//           return res.status(400).json({ message: 'packages_in_data must be valid JSON (array of objects).' });
//         }
//       }

//       // Minimal shape check
//       if (!Array.isArray(payload) || !payload.every(o => o && typeof o === 'object' && 'pack_ID' in o)) {
//         return res.status(400).json({
//           message: 'packages_in_data must be an array of objects with at least { pack_ID }'
//         });
//       }

//       updates.push('packages_in_data = ?');
//       values.push(JSON.stringify(payload));
//     }

//     if (!updates.length) {
//       return res.status(400).json({ message: 'No fields provided for update.' });
//     }

//     values.push(lr_num);
//     await db.query(`UPDATE lr_invoice SET ${updates.join(', ')} WHERE lr_num = ?`, values);

//     // Return updated row
//     const [after] = await db.query(
//       `SELECT lr_id, lr_num, order_ID, ship_from, ship_to, packages_in_data
//          FROM lr_invoice
//         WHERE lr_num = ?`,
//       [lr_num]
//     );

//     const row = after[0];
//     let parsed = row.packages_in_data;
//     try { parsed = JSON.parse(parsed); } catch { }

//     return res.status(200).json({
//       message: 'LR updated successfully.',
//       lr_invoice: {
//         lr_id: row.lr_id,
//         lr_num: row.lr_num,
//         order_ID: row.order_ID,
//         ship_from: row.ship_from,
//         ship_to: row.ship_to,
//         packages_in_data: parsed
//       }
//     });
//   } catch (error) {
//     logger.error('Error updating LR invoice:', error);
//     return res.status(500).json({ message: 'Server error.', error: error.message });
//   }
// });


// router.delete('/delete-order', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { order_ID } = req.query;
//     if (!order_ID) {
//       return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
//     }

//     const [orderExists] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
//     if (!orderExists.length) {
//       return res.status(404).json({ message: 'Order not found.' });
//     }

//     await db.query(`DELETE FROM orders WHERE order_ID = ?`, [order_ID]);

//     return res.status(200).json({ message: 'Order deleted successfully.', order_ID });
//   } catch (error) {
//     logger.error('Error deleting order:', error);
//     return res.status(500).json({ message: 'Server error.', error: error.message });
//   }
// });

// module.exports = router;





const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');
const { createTrackingSession } = require('./trackingService');

/* ============================================================================
   ORDER / DRAFT RULES
   ----------------------------------------------------------------------------
   orders.draft = 1  -> editable saved draft; packages are reserved
   orders.draft = 0  -> confirmed order

   packages.package_status:
     draft   -> package is reserved by a draft order
     ordered -> package belongs to a confirmed order

   Current DB values show that free/selectable packages have package_status = NULL.
   Therefore, removing a package from a draft releases it back to NULL.
   No .env variable is required for package_status.
============================================================================ */

const PACKAGE_DRAFT_STATUS = 'draft';
const PACKAGE_CONFIRMED_STATUS = 'ordered';
const LR_PREFIX = 'TALRN';
const LR_CUSTOMER = 'REL';

function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase();
}

function jsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tryJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function getAvailablePackageStatus() {
  // In your existing packages table, NULL means available/selectable.
  return null;
}

function validateAllocations(allocations) {
  if (!Array.isArray(allocations) || !allocations.length) {
    const err = new Error('At least one allocation is required.');
    err.httpStatus = 400;
    throw err;
  }

  const packageIDs = allocations.flatMap(allocation =>
    Array.isArray(allocation?.packages) ? allocation.packages : []
  );

  if (!packageIDs.length) {
    const err = new Error('No valid packages found in allocations.');
    err.httpStatus = 400;
    throw err;
  }

  const uniquePackageIDs = uniqueStrings(packageIDs);
  if (uniquePackageIDs.length !== packageIDs.length) {
    const err = new Error('The same package is present in more than one allocation.');
    err.httpStatus = 400;
    throw err;
  }

  return uniquePackageIDs;
}

async function getNextOrderNumber(conn) {
  const [rows] = await conn.query(`
    SELECT order_ID
      FROM orders
     ORDER BY ord_id DESC
     LIMIT 1
     FOR UPDATE
  `);

  const lastID = rows[0]?.order_ID || 'ORD000000';
  return Number.parseInt(String(lastID).slice(3), 10) || 0;
}

function makeOrderID(number) {
  return `ORD${String(number).padStart(6, '0')}`;
}

async function lockPackageRows(conn, packageIDs) {
  if (!packageIDs.length) return [];

  const placeholders = packageIDs.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT pack_ID, package_status, ship_from, ship_to, destination_radius, additional_info
       FROM packages
      WHERE pack_ID IN (${placeholders})
      FOR UPDATE`,
    packageIDs
  );

  const returned = new Set(rows.map(row => row.pack_ID));
  const missing = packageIDs.filter(id => !returned.has(id));
  if (missing.length) {
    const err = new Error('Some packages were not found.');
    err.httpStatus = 404;
    err.missingPackages = missing;
    throw err;
  }

  return rows;
}

function assertPackagesAvailableForNewOrder(packageRows) {
  const blocked = packageRows
    .filter(row => [PACKAGE_DRAFT_STATUS, PACKAGE_CONFIRMED_STATUS].includes(normalizeStatus(row.package_status)))
    .map(row => ({ pack_ID: row.pack_ID, package_status: row.package_status }));

  if (blocked.length) {
    const err = new Error('Some packages are already reserved in a draft or confirmed order.');
    err.httpStatus = 409;
    err.blockedPackages = blocked;
    throw err;
  }
}

async function setPackageStatus(conn, packageIDs, status) {
  if (!packageIDs.length) return;
  const placeholders = packageIDs.map(() => '?').join(',');
  await conn.query(
    `UPDATE packages SET package_status = ? WHERE pack_ID IN (${placeholders})`,
    [status, ...packageIDs]
  );
}

function buildPackageMap(rows) {
  return Object.fromEntries(rows.map(row => [row.pack_ID, row]));
}

function buildOrderData(allocation, packToLocMap, unallocatedPackages = []) {
  const packages = Array.isArray(allocation.packages) ? allocation.packages : [];
  const routeInfo = allocation.route?.[0] || {};
  const distanceVal = parseFloat(String(routeInfo.distance || '').replace(/[^\d.]/g, '')) || 0;
  const weightVal = Number(allocation.occupiedWeight || 0);

  const firstPackage = packages[0];
  const lastPackage = packages[packages.length - 1];

  const startLocID = packToLocMap[firstPackage]?.ship_from || null;
  const endLocID = packToLocMap[lastPackage]?.ship_to || null;

  const packageRadiusData = packages.map(packageID => ({
    pack_ID: packageID,
    ship_to: packToLocMap[packageID]?.ship_to || null,
    destination_radius: packToLocMap[packageID]?.destination_radius ?? null
  }));

  return {
    totalCost: Number(allocation.cost || 0),
    allocationJSON: JSON.stringify([allocation]),
    totalWeight: weightVal.toFixed(2),
    totalDistance: Number(distanceVal).toFixed(2),
    startLocID,
    endLocID,
    allocatedPackagesJSON: JSON.stringify(packages),
    unallocatedPackagesJSON: JSON.stringify(unallocatedPackages || []),
    allocatedVehiclesJSON: JSON.stringify([allocation.vehicle_ID]),
    packageRadiusJSON: JSON.stringify(packageRadiusData)
  };
}

async function insertOrderRow(conn, {
  orderID,
  scenarioLabel,
  allocation,
  packToLocMap,
  unallocatedPackages,
  createdAt,
  updatedAt,
  orderDocs,
  billOfLading,
  draft,
  orderStatus
}) {
  const data = buildOrderData(allocation, packToLocMap, unallocatedPackages);

  await conn.query(
    `INSERT INTO orders
      (order_ID, scenario_label, total_cost, allocations, total_weight, total_distance,
       start_loc_ID, end_loc_ID, allocated_packages, unallocated_packages, allocated_vehicles,
       package_dest_radius, created_at, updated_at, order_docs, order_status,
       bill_of_lading, draft)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderID,
      scenarioLabel,
      data.totalCost,
      data.allocationJSON,
      data.totalWeight,
      data.totalDistance,
      data.startLocID,
      data.endLocID,
      data.allocatedPackagesJSON,
      data.unallocatedPackagesJSON,
      data.allocatedVehiclesJSON,
      data.packageRadiusJSON,
      createdAt || new Date().toISOString(),
      updatedAt || new Date().toISOString(),
      JSON.stringify(orderDocs || []),
      orderStatus,
      JSON.stringify(billOfLading || []),
      draft ? 1 : 0
    ]
  );

  return data;
}

async function getNextLRNum(conn) {
  const [rows] = await conn.query(
    `SELECT CAST(SUBSTRING(lr_num, 6, 8) AS UNSIGNED) AS num
       FROM lr_invoice
      WHERE lr_num LIKE CONCAT(?, '%')
      ORDER BY num DESC
      LIMIT 1
      FOR UPDATE`,
    [LR_PREFIX]
  );

  const last = rows.length ? Number(rows[0].num) || 0 : -1;
  return `${LR_PREFIX}${String(last + 1).padStart(8, '0')}${LR_CUSTOMER}`;
}

async function createLRRowsForAllocation(conn, { orderID, startLocID, allocation, packToLocMap }) {
  const stops = Array.isArray(allocation.loadArrangement) ? allocation.loadArrangement : [];

  for (const stop of stops) {
    const packagesAtStop = Array.isArray(stop.packages) ? stop.packages : [];
    if (!packagesAtStop.length) continue;

    const byShipTo = new Map();
    for (const packageID of packagesAtStop) {
      const meta = packToLocMap[packageID];
      if (!meta?.ship_to) continue;
      if (!byShipTo.has(meta.ship_to)) byShipTo.set(meta.ship_to, []);
      byShipTo.get(meta.ship_to).push(packageID);
    }

    for (const [shipTo, packageIDs] of byShipTo.entries()) {
      const packagesInData = packageIDs.map(packageID => {
        const meta = packToLocMap[packageID] || {};
        const additionalInfo = tryJson(meta.additional_info, {});
        return {
          pack_ID: packageID,
          invoice: additionalInfo?.invoice ?? null,
          e_way: null
        };
      });

      const lrNum = await getNextLRNum(conn);
      await conn.query(
        `INSERT INTO lr_invoice (lr_num, order_ID, ship_from, ship_to, packages_in_data)
         VALUES (?, ?, ?, ?, ?)`,
        [lrNum, orderID, startLocID, shipTo, JSON.stringify(packagesInData)]
      );
    }
  }
}

async function createFinalOrderSideEffects(conn, { orderID, allocation, data, packToLocMap }) {
  await createTrackingSession({
    conn,
    order_ID: orderID,
    vehicle_ID: allocation.vehicle_ID,
    device_ID: allocation.device_ID || null,
    loadArrangement: allocation.loadArrangement,
    packToLocMap,
    route: allocation.route
  });

  await createLRRowsForAllocation(conn, {
    orderID,
    startLocID: data.startLocID,
    allocation,
    packToLocMap
  });
}

function sendError(res, error, defaultMessage) {
  const status = error.httpStatus || 500;
  const payload = { message: error.message || defaultMessage };
  if (error.blockedPackages) payload.blockedPackages = error.blockedPackages;
  if (error.missingPackages) payload.missingPackages = error.missingPackages;
  return res.status(status).json(payload);
}

/* ============================================================================
   1) DIRECT FINAL CONFIRMATION — no draft is saved
   POST /confirm-order
============================================================================ */
router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const {
      scenario_label,
      total_cost,
      allocations = [],
      unallocated_packages = [],
      created_at,
      updated_at,
      order_docs = [],
      bill_of_lading = []
    } = req.body;

    if (!scenario_label || total_cost == null) {
      const err = new Error('Missing required fields: scenario_label, total_cost.');
      err.httpStatus = 400;
      throw err;
    }

    const packageIDs = validateAllocations(allocations);
    const packageRows = await lockPackageRows(conn, packageIDs);
    assertPackagesAvailableForNewOrder(packageRows);
    const packToLocMap = buildPackageMap(packageRows);

    let nextNumber = await getNextOrderNumber(conn);
    const createdOrders = [];

    for (const allocation of allocations) {
      const orderID = makeOrderID(++nextNumber);
      const data = await insertOrderRow(conn, {
        orderID,
        scenarioLabel: scenario_label,
        allocation,
        packToLocMap,
        unallocatedPackages: unallocated_packages,
        createdAt: created_at,
        updatedAt: updated_at,
        orderDocs: order_docs,
        billOfLading: bill_of_lading,
        draft: false,
        orderStatus: 'assignment pending'
      });

      await createFinalOrderSideEffects(conn, {
        orderID,
        allocation,
        data,
        packToLocMap
      });

      createdOrders.push({
        order_ID: orderID,
        vehicle_ID: allocation.vehicle_ID,
        allocated_packages: allocation.packages || [],
        cost: allocation.cost || 0,
        draft: false
      });
    }

    await setPackageStatus(conn, packageIDs, PACKAGE_CONFIRMED_STATUS);
    await conn.commit();

    return res.status(201).json({
      message: 'Orders confirmed successfully.',
      scenario_label,
      created_orders: createdOrders,
      unallocated_packages
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    logger.error('Error confirming order:', error);
    return sendError(res, error, 'Server error.');
  } finally {
    conn.release();
  }
});

/* ============================================================================
   2) SAVE AS DRAFT — packages become reserved, no tracking and no LR yet
   POST /save-order-draft
============================================================================ */
router.post('/save-order-draft', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const {
      scenario_label,
      total_cost,
      allocations = [],
      unallocated_packages = [],
      created_at,
      updated_at,
      order_docs = [],
      bill_of_lading = []
    } = req.body;

    if (!scenario_label || total_cost == null) {
      const err = new Error('Missing required fields: scenario_label, total_cost.');
      err.httpStatus = 400;
      throw err;
    }

    const packageIDs = validateAllocations(allocations);
    const packageRows = await lockPackageRows(conn, packageIDs);
    assertPackagesAvailableForNewOrder(packageRows);
    const packToLocMap = buildPackageMap(packageRows);

    let nextNumber = await getNextOrderNumber(conn);
    const draftOrders = [];

    for (const allocation of allocations) {
      const orderID = makeOrderID(++nextNumber);
      await insertOrderRow(conn, {
        orderID,
        scenarioLabel: scenario_label,
        allocation,
        packToLocMap,
        unallocatedPackages: unallocated_packages,
        createdAt: created_at,
        updatedAt: updated_at,
        orderDocs: order_docs,
        billOfLading: bill_of_lading,
        draft: true,
        orderStatus: 'draft'
      });

      draftOrders.push({
        order_ID: orderID,
        vehicle_ID: allocation.vehicle_ID,
        allocated_packages: allocation.packages || [],
        cost: allocation.cost || 0,
        draft: true
      });
    }

    await setPackageStatus(conn, packageIDs, PACKAGE_DRAFT_STATUS);
    await conn.commit();

    return res.status(201).json({
      message: 'Order draft saved successfully. Packages are reserved.',
      draft_orders: draftOrders,
      unallocated_packages
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    logger.error('Error saving order draft:', error);
    return sendError(res, error, 'Server error.');
  } finally {
    conn.release();
  }
});

/* ============================================================================
   3) UPDATE ONE DRAFT ORDER — same order_ID, exactly one recalculated allocation
   PUT /update-order-draft?order_ID=ORD000001
============================================================================ */
router.put('/update-order-draft', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { order_ID } = req.query;
    const {
      scenario_label,
      total_cost,
      allocations = [],
      unallocated_packages = [],
      updated_at,
      order_docs = [],
      bill_of_lading = []
    } = req.body;

    if (!order_ID) {
      const err = new Error('Missing required query parameter: order_ID.');
      err.httpStatus = 400;
      throw err;
    }
    if (!scenario_label || total_cost == null) {
      const err = new Error('Missing required fields: scenario_label, total_cost.');
      err.httpStatus = 400;
      throw err;
    }
    if (!Array.isArray(allocations) || allocations.length !== 1) {
      const err = new Error('Updating one draft order requires exactly one allocation. Each allocation is an independent order_ID.');
      err.httpStatus = 400;
      throw err;
    }

    const [[draftOrder]] = await conn.query(
      `SELECT * FROM orders WHERE order_ID = ? AND draft = 1 FOR UPDATE`,
      [order_ID]
    );
    if (!draftOrder) {
      const err = new Error('Draft order not found or order is already confirmed.');
      err.httpStatus = 404;
      throw err;
    }

    const oldPackageIDs = uniqueStrings(jsonArray(draftOrder.allocated_packages));
    const newPackageIDs = validateAllocations(allocations);
    const unionIDs = uniqueStrings([...oldPackageIDs, ...newPackageIDs]);
    const packageRows = await lockPackageRows(conn, unionIDs);
    const statusByID = Object.fromEntries(packageRows.map(row => [row.pack_ID, normalizeStatus(row.package_status)]));
    const oldSet = new Set(oldPackageIDs);
    const newSet = new Set(newPackageIDs);

    const blockedPackages = newPackageIDs
      .filter(packageID => {
        const status = statusByID[packageID];
        if (oldSet.has(packageID)) return status !== PACKAGE_DRAFT_STATUS;
        return status === PACKAGE_DRAFT_STATUS || status === PACKAGE_CONFIRMED_STATUS;
      })
      .map(packageID => ({ pack_ID: packageID, package_status: statusByID[packageID] }));

    if (blockedPackages.length) {
      const err = new Error('Some selected packages are no longer available for this draft.');
      err.httpStatus = 409;
      err.blockedPackages = blockedPackages;
      throw err;
    }

    const removedPackageIDs = oldPackageIDs.filter(packageID => !newSet.has(packageID));
    const addedPackageIDs = newPackageIDs.filter(packageID => !oldSet.has(packageID));
    const allocation = allocations[0];
    const packToLocMap = buildPackageMap(packageRows);
    const data = buildOrderData(allocation, packToLocMap, unallocated_packages);

    await conn.query(
      `UPDATE orders
          SET scenario_label = ?, total_cost = ?, allocations = ?, total_weight = ?,
              total_distance = ?, start_loc_ID = ?, end_loc_ID = ?, allocated_packages = ?,
              unallocated_packages = ?, allocated_vehicles = ?, package_dest_radius = ?,
              updated_at = ?, order_docs = ?, bill_of_lading = ?, order_status = 'draft', draft = 1
        WHERE order_ID = ?`,
      [
        scenario_label,
        data.totalCost,
        data.allocationJSON,
        data.totalWeight,
        data.totalDistance,
        data.startLocID,
        data.endLocID,
        data.allocatedPackagesJSON,
        data.unallocatedPackagesJSON,
        data.allocatedVehiclesJSON,
        data.packageRadiusJSON,
        updated_at || new Date().toISOString(),
        JSON.stringify(order_docs || []),
        JSON.stringify(bill_of_lading || []),
        order_ID
      ]
    );

    if (removedPackageIDs.length) {
      await setPackageStatus(conn, removedPackageIDs, getAvailablePackageStatus());
    }
    if (addedPackageIDs.length) {
      await setPackageStatus(conn, addedPackageIDs, PACKAGE_DRAFT_STATUS);
    }

    await conn.commit();

    return res.status(200).json({
      message: 'Draft order updated successfully.',
      order_ID,
      draft: true,
      allocated_packages: newPackageIDs,
      released_packages: removedPackageIDs,
      newly_reserved_packages: addedPackageIDs
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    logger.error('Error updating order draft:', error);
    return sendError(res, error, 'Server error.');
  } finally {
    conn.release();
  }
});

/* ============================================================================
   4) CONFIRM AN EXISTING DRAFT WITHOUT RE-CALCULATING — same order_ID
   POST /confirm-draft-order
   body: { "order_ID": "ORD000001" }
============================================================================ */
router.post('/confirm-draft-order', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { order_ID } = req.body;
    if (!order_ID) {
      const err = new Error('order_ID is required.');
      err.httpStatus = 400;
      throw err;
    }

    const [[draftOrder]] = await conn.query(
      `SELECT * FROM orders WHERE order_ID = ? AND draft = 1 FOR UPDATE`,
      [order_ID]
    );
    if (!draftOrder) {
      const err = new Error('Draft order not found or already confirmed.');
      err.httpStatus = 404;
      throw err;
    }

    const allocations = jsonArray(draftOrder.allocations);
    if (allocations.length !== 1) {
      const err = new Error('Draft order must contain exactly one allocation.');
      err.httpStatus = 400;
      throw err;
    }

    const allocation = allocations[0];
    const packageIDs = uniqueStrings(jsonArray(draftOrder.allocated_packages));
    if (!packageIDs.length) {
      const err = new Error('Draft does not contain valid packages.');
      err.httpStatus = 400;
      throw err;
    }

    const packageRows = await lockPackageRows(conn, packageIDs);
    const notReservedByDraft = packageRows
      .filter(row => normalizeStatus(row.package_status) !== PACKAGE_DRAFT_STATUS)
      .map(row => ({ pack_ID: row.pack_ID, package_status: row.package_status }));

    if (notReservedByDraft.length) {
      const err = new Error('Some draft packages are no longer reserved for confirmation.');
      err.httpStatus = 409;
      err.blockedPackages = notReservedByDraft;
      throw err;
    }

    const packToLocMap = buildPackageMap(packageRows);
    const data = buildOrderData(allocation, packToLocMap, jsonArray(draftOrder.unallocated_packages));

    await conn.query(
      `UPDATE orders
          SET draft = 0,
              order_status = 'assignment pending',
              updated_at = ?
        WHERE order_ID = ?`,
      [new Date().toISOString(), order_ID]
    );

    await createFinalOrderSideEffects(conn, {
      orderID: order_ID,
      allocation,
      data,
      packToLocMap
    });

    await setPackageStatus(conn, packageIDs, PACKAGE_CONFIRMED_STATUS);
    await conn.commit();

    return res.status(200).json({
      message: 'Draft order confirmed successfully.',
      created_order: {
        order_ID,
        vehicle_ID: allocation.vehicle_ID,
        allocated_packages: packageIDs,
        cost: draftOrder.total_cost,
        draft: false
      }
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    logger.error('Error confirming draft order:', error);
    return sendError(res, error, 'Server error.');
  } finally {
    conn.release();
  }
});

/* ============================================================================
   READ APIs
============================================================================ */
router.get('/all-orders', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { page, limit, draft } = req.query;
    let query = 'SELECT * FROM orders';
    const values = [];

    if (draft === 'true' || draft === '1') {
      query += ' WHERE draft = 1';
    } else if (draft === 'false' || draft === '0') {
      query += ' WHERE draft = 0';
    }

    query += ' ORDER BY created_at DESC';
    query = applyPagination(query, page, limit);

    const [orders] = await db.query(query, values);
    return res.status(200).json({ message: 'Orders retrieved successfully.', orders });
  } catch (error) {
    logger.error('Error fetching all orders:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

router.get('/draft-orders', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { page, limit } = req.query;
    let query = 'SELECT * FROM orders WHERE draft = 1 ORDER BY created_at DESC';
    query = applyPagination(query, page, limit);
    const [orders] = await db.query(query);
    return res.status(200).json({ message: 'Draft orders retrieved successfully.', orders });
  } catch (error) {
    logger.error('Error fetching draft orders:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

router.get('/order-by-id', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    if (!order_ID) return res.status(400).json({ message: 'Missing required query parameter: order_ID' });

    const [orderRows] = await db.query('SELECT * FROM orders WHERE order_ID = ?', [order_ID]);
    if (!orderRows.length) return res.status(404).json({ message: 'Order not found.' });
    const order = orderRows[0];

    const allocatedPackages = jsonArray(order.allocated_packages);
    const allocatedVehicles = jsonArray(order.allocated_vehicles);
    let packageDetails = [];

    if (allocatedPackages.length) {
      const placeholders = allocatedPackages.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT p.pac_id, p.pack_ID, p.ship_from, p.ship_to, p.destination_radius,
                p.product_ID, p.package_info, p.bill_to, p.return_label, p.additional_info,
                p.pickup_date_time, p.dropoff_date_time, p.tax_info, p.package_status
           FROM packages p
          WHERE p.pack_ID IN (${placeholders})`,
        allocatedPackages
      );

      packageDetails = rows.map(row => ({
        ...row,
        product_lines: jsonArray(row.product_ID),
        additional_info: tryJson(row.additional_info, {}),
        tax_info: tryJson(row.tax_info, {})
      }));
    }

    const productIDs = uniqueStrings(packageDetails.flatMap(item => item.product_lines.map(line => line.prod_ID)));
    let weightMap = {};
    if (productIDs.length) {
      const [products] = await db.query(
        'SELECT product_ID, weight, weight_uom FROM master_products WHERE product_ID IN (?)',
        [productIDs]
      );
      weightMap = Object.fromEntries(products.map(product => [product.product_ID, product]));
    }

    const packagesAndWeights = packageDetails.map(packageDetail => ({
      pack_ID: packageDetail.pack_ID,
      package_weight: Number(packageDetail.product_lines.reduce((sum, line) => {
        const product = weightMap[line.prod_ID];
        return sum + (Number(product?.weight || 0) * Number(line.quantity || 0));
      }, 0).toFixed(2)),
      weight_uom: weightMap[packageDetail.product_lines[0]?.prod_ID]?.weight_uom || null
    }));

    let vehicleDetails = [];
    if (allocatedVehicles.length) {
      const [vehicles] = await db.query(
        'SELECT * FROM master_resources WHERE vehicle_ID IN (?)',
        [allocatedVehicles]
      );
      vehicleDetails = vehicles;
    }

    const [lrRows] = await db.query(
      `SELECT lr_id, lr_num, order_ID, ship_from, ship_to, packages_in_data
         FROM lr_invoice WHERE order_ID = ? ORDER BY lr_id ASC`,
      [order_ID]
    );

    return res.status(200).json({
      message: 'Order retrieved successfully.',
      order,
      allocated_packages_details: packageDetails,
      packages_and_weights: packagesAndWeights,
      allocated_vehicles: vehicleDetails,
      lr_invoices: lrRows.map(row => ({ ...row, packages_in_data: jsonArray(row.packages_in_data) }))
    });
  } catch (error) {
    logger.error('Error fetching order by ID:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

/* ============================================================================
   EXISTING MANUAL EDIT API (documents/status only; draft allocations use the
   dedicated /update-order-draft endpoint)
============================================================================ */
router.put('/edit-order', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    const { order_status, order_docs, bill_of_lading } = req.body;
    if (!order_ID) return res.status(400).json({ message: 'Missing required query parameter: order_ID' });

    const [[order]] = await db.query('SELECT order_ID, draft FROM orders WHERE order_ID = ?', [order_ID]);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    const fields = [];
    const values = [];
    if (order_status !== undefined) { fields.push('order_status = ?'); values.push(order_status); }
    if (order_docs !== undefined) { fields.push('order_docs = ?'); values.push(JSON.stringify(order_docs)); }
    if (bill_of_lading !== undefined) { fields.push('bill_of_lading = ?'); values.push(JSON.stringify(bill_of_lading)); }
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(order_ID);

    await db.query(`UPDATE orders SET ${fields.join(', ')} WHERE order_ID = ?`, values);
    return res.status(200).json({ message: 'Order updated successfully.', order_ID });
  } catch (error) {
    logger.error('Error updating order:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

router.put('/edit-lr-invoice', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { lr_num } = req.query;
    if (!lr_num) return res.status(400).json({ message: 'Missing required query parameter: lr_num' });

    const [rows] = await db.query('SELECT * FROM lr_invoice WHERE lr_num = ?', [lr_num]);
    if (!rows.length) return res.status(404).json({ message: 'LR not found.' });

    const { ship_from, ship_to, packages_in_data, order_ID } = req.body;
    const updates = [];
    const values = [];
    if (order_ID !== undefined) { updates.push('order_ID = ?'); values.push(order_ID); }
    if (ship_from !== undefined) { updates.push('ship_from = ?'); values.push(ship_from); }
    if (ship_to !== undefined) { updates.push('ship_to = ?'); values.push(ship_to); }
    if (packages_in_data !== undefined) {
      const parsed = typeof packages_in_data === 'string' ? tryJson(packages_in_data, null) : packages_in_data;
      if (!Array.isArray(parsed) || !parsed.every(item => item && typeof item === 'object' && item.pack_ID)) {
        return res.status(400).json({ message: 'packages_in_data must be an array of objects with at least { pack_ID }.' });
      }
      updates.push('packages_in_data = ?');
      values.push(JSON.stringify(parsed));
    }
    if (!updates.length) return res.status(400).json({ message: 'No fields provided for update.' });

    values.push(lr_num);
    await db.query(`UPDATE lr_invoice SET ${updates.join(', ')} WHERE lr_num = ?`, values);
    const [[updated]] = await db.query(
      'SELECT lr_id, lr_num, order_ID, ship_from, ship_to, packages_in_data FROM lr_invoice WHERE lr_num = ?',
      [lr_num]
    );
    return res.status(200).json({
      message: 'LR updated successfully.',
      lr_invoice: { ...updated, packages_in_data: jsonArray(updated.packages_in_data) }
    });
  } catch (error) {
    logger.error('Error updating LR invoice:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

/* Deleting a draft releases its packages. Existing confirmed deletion behaviour
   remains unchanged; add stricter restrictions later if confirmed orders must
   not be physically deleted. */
router.delete('/delete-order', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { order_ID } = req.query;
    if (!order_ID) {
      await conn.rollback();
      return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
    }

    const [[order]] = await conn.query('SELECT * FROM orders WHERE order_ID = ? FOR UPDATE', [order_ID]);
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ message: 'Order not found.' });
    }

    const packageIDs = uniqueStrings(jsonArray(order.allocated_packages));
    if (Number(order.draft) === 1 && packageIDs.length) {
      await setPackageStatus(conn, packageIDs, getAvailablePackageStatus());
    }

    await conn.query('DELETE FROM orders WHERE order_ID = ?', [order_ID]);
    await conn.commit();
    return res.status(200).json({
      message: Number(order.draft) === 1 ? 'Draft deleted and packages released successfully.' : 'Order deleted successfully.',
      order_ID
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    logger.error('Error deleting order:', error);
    return sendError(res, error, 'Server error.');
  } finally {
    conn.release();
  }
});

module.exports = router;
