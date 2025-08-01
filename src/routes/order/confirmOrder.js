const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');



// router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
//     try {
//       const {
//         scenario_label,
//         total_cost,
//         allocations,
//         unallocated_packages,
//         created_at,
//         updated_at,
//         order_docs
//       } = req.body;

//       if (!scenario_label || total_cost == null) {
//         return res.status(400).json({
//           message: 'Missing required fields: scenario_label, total_cost.'
//         });
//       }

//       const allPackages = allocations.flatMap(alloc => alloc.packages || []);

//       if (allPackages.length === 0) {
//         return res.status(400).json({
//           message: 'No valid packages found for confirmation.'
//         });
//       }

//       const placeholders = allPackages.map(() => '?').join(',');
//       const [existingPackages] = await db.query(
//         `SELECT pack_ID FROM packages 
//          WHERE pack_ID IN (${placeholders}) 
//            AND package_status = 'ordered'`,
//         allPackages
//       );
//       if (existingPackages.length > 0) {
//         const alreadyConfirmedPackages = existingPackages.map(row => row.pack_ID);
//         return res.status(400).json({
//           message: 'Some packages are already confirmed in an existing order.',
//           alreadyConfirmedPackages
//         });
//       }

//       const [result] = await db.query(`
//         SELECT order_ID 
//         FROM orders 
//         ORDER BY ord_id DESC 
//         LIMIT 1 FOR UPDATE
//       `);
//       let lastOrderID = result[0]?.order_ID || 'ORD000000';
//       let numericPart = parseInt(lastOrderID.slice(3), 10);

//       // Get package -> location mapping
//       const [packageLocs] = await db.query(
//         `SELECT pack_ID, ship_from, ship_to FROM packages WHERE pack_ID IN (${placeholders})`,
//         allPackages
//       );
//       const packToLocMap = Object.fromEntries(packageLocs.map(row => [row.pack_ID, row]));

//       const createdOrders = [];

//       for (const alloc of allocations) {
//         numericPart++;
//         const padded = String(numericPart).padStart(6, '0');
//         const newOrderID = 'ORD' + padded;

//         const allocJson = JSON.stringify([alloc]);
//         const allocatedPackagesJson = JSON.stringify(alloc.packages || []);
//         const allocatedVehiclesJson = JSON.stringify([alloc.vehicle_ID]);

//         // Extract route-based data
//         const routeInfo = alloc.route?.[0] || {};
//         const distanceVal = parseFloat((routeInfo.distance || '').replace(/[^\d.]/g, '')) || 0;
//         const weightVal = alloc.occupiedWeight || 0;

//         const firstPkg = alloc.packages?.[0];
//         const lastPkg = alloc.packages?.[alloc.packages.length - 1];
//         const startLocID = packToLocMap[firstPkg]?.ship_from || null;
//         const endLocID = packToLocMap[lastPkg]?.ship_to || null;

//         await db.query(`
//           INSERT INTO orders
//             (order_ID, scenario_label, total_cost, allocations, total_weight, total_distance, start_loc_ID, end_loc_ID,
//              allocated_packages, unallocated_packages, allocated_vehicles, created_at, updated_at, order_docs, order_status)
//           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//         `, [
//           newOrderID,
//           scenario_label,
//           alloc.cost || 0,
//           allocJson,
//           weightVal.toFixed(2),
//           distanceVal.toFixed(2),
//           startLocID,
//           endLocID,
//           allocatedPackagesJson,
//           JSON.stringify(unallocated_packages || []),
//           allocatedVehiclesJson,
//           created_at || new Date().toISOString(),
//           updated_at || new Date().toISOString(),
//           JSON.stringify(order_docs || []),
//           "assignment pending"
//         ]);

//         if (alloc.packages?.length) {
//           const pkgPlaceholders = alloc.packages.map(() => '?').join(',');
//           await db.query(
//             `UPDATE packages SET package_status = 'ordered' WHERE pack_ID IN (${pkgPlaceholders})`,
//             alloc.packages
//           );
//         }

//         createdOrders.push({
//           order_ID: newOrderID,
//           vehicle_ID: alloc.vehicle_ID,
//           allocated_packages: alloc.packages || [],
//           cost: alloc.cost || 0
//         });
//       }

//       return res.status(201).json({
//         message: 'Orders confirmed successfully.',
//         scenario_label,
//         created_orders: createdOrders,
//         unallocated_packages: unallocated_packages || []
//       });

//     } catch (error) {
//       logger.error('Error confirming order:', error);
//       return res.status(500).json({
//         message: error.message || 'Server error.'
//       });
//     }
//   });


router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            scenario_label,
            total_cost,
            allocations,
            unallocated_packages,
            created_at,
            updated_at,
            order_docs,
            bill_of_lading
        } = req.body;

        if (!scenario_label || total_cost == null) {
            return res.status(400).json({
                message: 'Missing required fields: scenario_label, total_cost.'
            });
        }

        const allPackages = allocations.flatMap(alloc => alloc.packages || []);

        if (allPackages.length === 0) {
            return res.status(400).json({
                message: 'No valid packages found for confirmation.'
            });
        }

        const placeholders = allPackages.map(() => '?').join(',');
        const [existingPackages] = await db.query(
            `SELECT pack_ID FROM packages 
           WHERE pack_ID IN (${placeholders}) 
             AND package_status = 'ordered'`,
            allPackages
        );
        if (existingPackages.length > 0) {
            const alreadyConfirmedPackages = existingPackages.map(row => row.pack_ID);
            return res.status(400).json({
                message: 'Some packages are already confirmed in an existing order.',
                alreadyConfirmedPackages
            });
        }

        const [result] = await db.query(`
          SELECT order_ID 
          FROM orders 
          ORDER BY ord_id DESC 
          LIMIT 1 FOR UPDATE
      `);
        let lastOrderID = result[0]?.order_ID || 'ORD000000';
        let numericPart = parseInt(lastOrderID.slice(3), 10);

        // Get package -> location mapping
        const [packageLocs] = await db.query(
            `SELECT pack_ID, ship_from, ship_to, destination_radius FROM packages WHERE pack_ID IN (${placeholders})`,
            allPackages
        );
        const packToLocMap = Object.fromEntries(packageLocs.map(row => [row.pack_ID, row]));

        const createdOrders = [];

        for (const alloc of allocations) {
            numericPart++;
            const padded = String(numericPart).padStart(6, '0');
            const newOrderID = 'ORD' + padded;

            const allocJson = JSON.stringify([alloc]);
            const allocatedPackagesJson = JSON.stringify(alloc.packages || []);
            const allocatedVehiclesJson = JSON.stringify([alloc.vehicle_ID]);

            // Extract route-based data
            const routeInfo = alloc.route?.[0] || {};
            const distanceVal = parseFloat((routeInfo.distance || '').replace(/[^\d.]/g, '')) || 0;
            const weightVal = alloc.occupiedWeight || 0;

            const firstPkg = alloc.packages?.[0];
            const lastPkg = alloc.packages?.[alloc.packages.length - 1];
            const startLocID = packToLocMap[firstPkg]?.ship_from || null;
            const endLocID = packToLocMap[lastPkg]?.ship_to || null;

            // Extract package_dest_radius info
            const packageRadiusData = alloc.packages.map(packID => {
                const pkg = packToLocMap[packID];
                return {
                    pack_ID: pkg.pack_ID,
                    ship_to: pkg.ship_to,
                    destination_radius: pkg.destination_radius || null
                };
            });

            await db.query(`
              INSERT INTO orders
                (order_ID, scenario_label, total_cost, allocations, total_weight, total_distance, start_loc_ID, end_loc_ID,
                 allocated_packages, unallocated_packages, allocated_vehicles, package_dest_radius,
                 created_at, updated_at, order_docs, order_status, bill_of_lading)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
                newOrderID,
                scenario_label,
                alloc.cost || 0,
                allocJson,
                weightVal.toFixed(2),
                distanceVal.toFixed(2),
                startLocID,
                endLocID,
                allocatedPackagesJson,
                JSON.stringify(unallocated_packages || []),
                allocatedVehiclesJson,
                JSON.stringify(packageRadiusData),
                created_at || new Date().toISOString(),
                updated_at || new Date().toISOString(),
                JSON.stringify(order_docs || []),
                "assignment pending",
                JSON.stringify(bill_of_lading)
            ]);

            if (alloc.packages?.length) {
                const pkgPlaceholders = alloc.packages.map(() => '?').join(',');
                await db.query(
                    `UPDATE packages SET package_status = 'ordered' WHERE pack_ID IN (${pkgPlaceholders})`,
                    alloc.packages
                );
            }

            createdOrders.push({
                order_ID: newOrderID,
                vehicle_ID: alloc.vehicle_ID,
                allocated_packages: alloc.packages || [],
                cost: alloc.cost || 0
            });
        }

        return res.status(201).json({
            message: 'Orders confirmed successfully.',
            scenario_label,
            created_orders: createdOrders,
            unallocated_packages: unallocated_packages || []
        });

    } catch (error) {
        logger.error('Error confirming order:', error);
        return res.status(500).json({
            message: error.message || 'Server error.'
        });
    }
});


router.get('/all-orders', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
        let query = `SELECT * FROM orders ORDER BY created_at DESC`;
        query = applyPagination(query, page, limit);

        const [orders] = await db.query(query);
        if (!orders.length) {
            return res.status(404).json({ message: 'No orders found.' });
        }

        return res.status(200).json({ message: 'Orders retrieved successfully.', orders });
    } catch (error) {
        logger.error('Error fetching all orders:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// router.get('/order-by-id', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { order_ID } = req.query;
//         if (!order_ID) {
//             return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
//         }

//         const [orderResult] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
//         if (!orderResult.length) {
//             return res.status(404).json({ message: 'Order not found.' });
//         }

//         const order = orderResult[0];
//         let allocatedPackages = [];
//         let allocatedVehicles = [];

//         // Safe JSON parsing function
//         const safeParse = (data) => {
//             if (!data) return [];
//             if (Array.isArray(data)) return data;
//             if (typeof data === 'string') {
//                 try {
//                     return JSON.parse(data);
//                 } catch {
//                     return data.split(',').map(item => item.trim());
//                 }
//             }
//             return [];
//         };

//         allocatedPackages = safeParse(order.allocated_packages);
//         allocatedVehicles = safeParse(order.allocated_vehicles);

//         let packageDetails = [];
//         if (allocatedPackages.length > 0) {
//             const packagePlaceholders = allocatedPackages.map(() => '?').join(',');
//             const [packages] = await db.query(`
//                 SELECT * FROM packages WHERE pack_ID IN (${packagePlaceholders})
//             `, allocatedPackages);
//             packageDetails = packages;
//         }

//         let vehicleDetails = [];
//         if (allocatedVehicles.length > 0) {
//             const vehiclePlaceholders = allocatedVehicles.map(() => '?').join(',');
//             const [vehicles] = await db.query(`
//                 SELECT * FROM master_resources WHERE vehicle_ID IN (${vehiclePlaceholders})
//             `, allocatedVehicles);
//             vehicleDetails = vehicles;
//         }

//         return res.status(200).json({
//             message: 'Order retrieved successfully.',
//             order,
//             allocated_packages_details: packageDetails,
//             allocated_vehicles: vehicleDetails
//         });

//     } catch (error) {
//         logger.error('Error fetching order by ID:', error);
//         return res.status(500).json({ message: 'Server error.', error: error.message });
//     }
// });


// router.get('/order-by-id', jwtAuth.verifyToken, async (req, res) => {
//     try {
//       const { order_ID } = req.query;
//       if (!order_ID) {
//         return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
//       }

//       // 1) fetch the order
//       const [orderRows] = await db.query(
//         `SELECT * FROM orders WHERE order_ID = ?`, 
//         [order_ID]
//       );
//       if (!orderRows.length) {
//         return res.status(404).json({ message: 'Order not found.' });
//       }
//       const order = orderRows[0];

//       // 2) parse the allocated package and vehicle arrays
//       const safeParseList = val => {
//         if (!val) return [];
//         if (Array.isArray(val)) return val;
//         try { return JSON.parse(val); }
//         catch { return String(val).split(',').map(s => s.trim()); }
//       };
//       const allocatedPackages = safeParseList(order.allocated_packages);
//       const allocatedVehicles = safeParseList(order.allocated_vehicles);

//       // 3) load package details (with bill_to)
//       let packageDetails = [];
//       if (allocatedPackages.length) {
//         const ph = allocatedPackages.map(() => '?').join(',');
//         const [rows] = await db.query(
//           `SELECT pac_id, pack_ID, ship_from, ship_to, destination_radius,
//                   product_ID, package_info, bill_to, return_label,
//                   additional_info, pickup_date_time, dropoff_date_time,
//                   tax_info, package_status
//            FROM packages
//            WHERE pack_ID IN (${ph})`,
//           allocatedPackages
//         );

//         packageDetails = rows.map(r => ({
//           pac_id:      r.pac_id,
//           pack_ID:     r.pack_ID,
//           ship_from:   r.ship_from,
//           ship_to:     r.ship_to,
//           destination_radius: r.destination_radius,
//           // parse JSON columns into JS objects/arrays
//           product_ID:  (() => {
//             try { return JSON.parse(r.product_ID); }
//             catch { return []; }
//           })(),
//           package_info: r.package_info,
//           bill_to:      r.bill_to,
//           return_label: r.return_label,
//           additional_info: (() => {
//             try { return JSON.parse(r.additional_info); }
//             catch { return {}; }
//           })(),
//           pickup_date_time: r.pickup_date_time,
//           dropoff_date_time:r.dropoff_date_time,
//           tax_info:    (() => {
//             try { return JSON.parse(r.tax_info); }
//             catch { return {}; }
//           })(),
//           package_status: r.package_status
//         }));
//       }

//       // 4) load vehicle details
//       let vehicleDetails = [];
//       if (allocatedVehicles.length) {
//         const ph = allocatedVehicles.map(() => '?').join(',');
//         const [rows] = await db.query(
//           `SELECT * FROM master_resources WHERE vehicle_ID IN (${ph})`,
//           allocatedVehicles
//         );
//         vehicleDetails = rows;
//       }

//       // 5) respond
//       return res.status(200).json({
//         message: 'Order retrieved successfully.',
//         order,
//         allocated_packages_details: packageDetails,
//         allocated_vehicles: vehicleDetails
//       });
//     }
//     catch (err) {
//       logger.error('Error fetching order by ID:', err);
//       return res.status(500).json({ message: 'Server error.', error: err.message });
//     }
//   });


router.get('/order-by-id',jwtAuth.verifyToken,async (req, res) => {
        try {
            const { order_ID } = req.query;
            if (!order_ID) {
                return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
            }

            // 1) fetch the order
            const [orderRows] = await db.query(
                `SELECT * FROM orders WHERE order_ID = ?`,
                [order_ID]
            );
            if (!orderRows.length) {
                return res.status(404).json({ message: 'Order not found.' });
            }
            const order = orderRows[0];

            // 2) parse the allocated package and vehicle arrays
            const safeParseList = val => {
                if (!val) return [];
                if (Array.isArray(val)) return val;
                try { return JSON.parse(val); }
                catch { return String(val).split(',').map(s => s.trim()); }
            };
            const allocatedPackages = safeParseList(order.allocated_packages);
            const allocatedVehicles = safeParseList(order.allocated_vehicles);

            // 3) load package details (with bill_to, product_ID, etc.)
            let packageDetails = [];
            if (allocatedPackages.length) {
                const ph = allocatedPackages.map(() => '?').join(',');
                const [rows] = await db.query(
                    `SELECT 
               p.pac_id, p.pack_ID, p.ship_from, p.ship_to, p.destination_radius,
               p.product_ID, p.package_info, p.bill_to, p.return_label,
               p.additional_info, p.pickup_date_time, p.dropoff_date_time,
               p.tax_info, p.package_status
             FROM packages p
             WHERE p.pack_ID IN (${ph})`,
                    allocatedPackages
                );

                // parse JSON columns & extract a uniform `product_lines` array
                packageDetails = rows.map(r => {
                    let product_lines = [];
                    if (typeof r.product_ID === 'string') {
                        try { product_lines = JSON.parse(r.product_ID); }
                        catch { product_lines = []; }
                    } else if (Array.isArray(r.product_ID)) {
                        product_lines = r.product_ID;
                    }

                    return {
                        pac_id: r.pac_id,
                        pack_ID: r.pack_ID,
                        ship_from: r.ship_from,
                        ship_to: r.ship_to,
                        destination_radius: r.destination_radius,
                        product_lines,                      // [{ prod_ID, quantity, package_info }, …]
                        package_info: r.package_info,
                        bill_to: r.bill_to,
                        return_label: r.return_label,
                        additional_info: (() => { try { return JSON.parse(r.additional_info) } catch { return {} } })(),
                        pickup_date_time: r.pickup_date_time,
                        dropoff_date_time: r.dropoff_date_time,
                        tax_info: (() => { try { return JSON.parse(r.tax_info) } catch { return {} } })(),
                        package_status: r.package_status
                    };
                });
            }

            // 4) fetch all involved master_products to get weight & uom
            const allProdIDs = [
                ...new Set(
                    packageDetails
                        .flatMap(pd => pd.product_lines.map(pl => pl.prod_ID))
                        .filter(id => id)
                )
            ];

            let weightMap = {};
            if (allProdIDs.length) {
                const [prodRows] = await db.query(
                    `SELECT product_ID, weight, weight_uom 
             FROM master_products 
             WHERE product_ID IN (?)`,
                    [allProdIDs]
                );
                weightMap = prodRows.reduce((m, pr) => {
                    m[pr.product_ID] = {
                        weight: parseFloat(pr.weight) || 0,
                        weight_uom: pr.weight_uom
                    };
                    return m;
                }, {});
            }

            // 5) compute per-package weights in a separate array
            const packagesAndWeights = packageDetails.map(pd => {
                const package_weight = pd.product_lines.reduce((sum, pl) => {
                    const info = weightMap[pl.prod_ID] || { weight: 0 };
                    return sum + info.weight * (pl.quantity || 0);
                }, 0);
                const uom = pd.product_lines.length
                    ? (weightMap[pd.product_lines[0].prod_ID]?.weight_uom || null)
                    : null;
                return {
                    pack_ID: pd.pack_ID,
                    package_weight: +package_weight.toFixed(2),
                    weight_uom: uom
                };
            });

            // 6) load vehicle details
            let vehicleDetails = [];
            if (allocatedVehicles.length) {
                const ph = allocatedVehicles.map(() => '?').join(',');
                const [rows] = await db.query(
                    `SELECT * FROM master_resources WHERE vehicle_ID IN (${ph})`,
                    allocatedVehicles
                );
                vehicleDetails = rows;
            }

            // 7) respond
            return res.status(200).json({
                message: 'Order retrieved successfully.',
                order,
                allocated_packages_details: packageDetails,
                packages_and_weights: packagesAndWeights,
                allocated_vehicles: vehicleDetails
            });
        }
        catch (err) {
            logger.error('Error fetching order by ID:', err);
            return res.status(500).json({ message: 'Server error.', error: err.message });
        }
    }
);


router.put('/edit-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID } = req.query;
        const {
            order_status,
            allocated_packages,
            allocated_vehicles,
            order_docs,
            bill_of_lading
        } = req.body;

        if (!order_ID) {
            return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
        }

        const [orderExists] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderExists.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        let updateFields = [];
        let values = [];

        if (order_status) {
            updateFields.push('order_status = ?');
            values.push(order_status);
        }

        if (allocated_packages) {
            updateFields.push('allocated_packages = ?');
            values.push(JSON.stringify(allocated_packages));
        }

        if (allocated_vehicles) {
            updateFields.push('allocated_vehicles = ?');
            values.push(JSON.stringify(allocated_vehicles));
        }

        if (order_docs) {
            updateFields.push('order_docs = ?');
            values.push(JSON.stringify(order_docs));
        }

        if (bill_of_lading) {
            updateFields.push('bill_of_lading = ?');
            values.push(JSON.stringify(bill_of_lading));
        }

        // Always update the timestamp
        const now = new Date().toISOString();
        updateFields.push('updated_at = ?');
        values.push(now);

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(order_ID);
        const query = `UPDATE orders SET ${updateFields.join(', ')} WHERE order_ID = ?`;

        await db.query(query, values);

        return res.status(200).json({ message: 'Order updated successfully.', order_ID });
    } catch (error) {
        logger.error('Error updating order:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});


router.delete('/delete-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID } = req.query;
        if (!order_ID) {
            return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
        }

        const [orderExists] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderExists.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        await db.query(`DELETE FROM orders WHERE order_ID = ?`, [order_ID]);

        return res.status(200).json({ message: 'Order deleted successfully.', order_ID });
    } catch (error) {
        logger.error('Error deleting order:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

module.exports = router;
