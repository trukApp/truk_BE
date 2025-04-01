const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

// router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const {
//             scenario_label,
//             total_cost,
//             allocations,
//             unallocated_packages,
//             created_at,
//             updated_at
//         } = req.body;

//         if (!scenario_label || total_cost == null) {
//             return res.status(400).json({
//                 message: 'Missing required fields: scenario_label, total_cost.'
//             });
//         }

//         const allocatedPackagesSet = new Set();
//         const allocatedVehiclesSet = new Set();

//         if (Array.isArray(allocations)) {
//             allocations.forEach(alloc => {
//                 if (alloc.vehicle_ID) {
//                     allocatedVehiclesSet.add(alloc.vehicle_ID);
//                 }

//                 if (Array.isArray(alloc.packages)) {
//                     alloc.packages.forEach(packID => {
//                         allocatedPackagesSet.add(packID);
//                     });
//                 }
//             });
//         }

//         const allocatedPackages = Array.from(allocatedPackagesSet);
//         const allocatedVehicles = Array.from(allocatedVehiclesSet);

//         if (allocatedPackages.length === 0) {
//             return res.status(400).json({
//                 message: 'No valid packages found for confirmation.'
//             });
//         }

//         const placeholders = allocatedPackages.map(() => '?').join(',');
//         const [existingPackages] = await db.query(`
//             SELECT pack_ID FROM packages WHERE pack_ID IN (${placeholders}) AND package_status = 'ordered'
//         `, allocatedPackages);

//         if (existingPackages.length > 0) {
//             const alreadyConfirmedPackages = existingPackages.map(row => row.pack_ID);
//             return res.status(400).json({
//                 message: 'Some packages are already confirmed in an existing order.',
//                 alreadyConfirmedPackages
//             });
//         }

//         const [result] = await db.query(`
//             SELECT order_ID FROM orders ORDER BY ord_id DESC LIMIT 1 FOR UPDATE
//         `);
//         let lastOrderID = result[0]?.order_ID || 'ORD000000';
//         const numericPart = parseInt(lastOrderID.slice(3), 10);
//         const newNumeric = numericPart + 1;
//         const padded = String(newNumeric).padStart(6, '0');
//         const newOrderID = 'ORD' + padded;

//         await db.query(`
//             INSERT INTO orders 
//             (order_ID, scenario_label, total_cost, allocations, unallocated_packages, allocated_packages, allocated_vehicles, created_at, updated_at, order_status)
//             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//         `, [
//             newOrderID,
//             scenario_label,
//             total_cost,
//             JSON.stringify(allocations || []),
//             JSON.stringify(unallocated_packages || []),
//             JSON.stringify(allocatedPackages),
//             JSON.stringify(allocatedVehicles),
//             created_at,
//             updated_at,
//             "order placed"
//         ]);

//         await db.query(`
//             UPDATE packages
//             SET package_status = 'ordered'
//             WHERE pack_ID IN (${placeholders})
//         `, allocatedPackages);

//         return res.status(201).json({
//             message: 'Order confirmed successfully.',
//             order_ID: newOrderID,
//             scenario_label,
//             total_cost,
//             allocated_packages: allocatedPackages,
//             allocated_vehicles: allocatedVehicles,
//             unallocated_packages: unallocated_packages || []
//         });

//     } catch (error) {
//         logger.error('Error confirming order:', error);
//         return res.status(500).json({
//             message: error.message || 'Server error.'
//         });
//     }
// });

router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
    try {
      const {
        scenario_label,
        total_cost,             
        allocations,
        unallocated_packages,
        created_at,
        updated_at
      } = req.body;
  
      if (!scenario_label || total_cost == null) {
        return res.status(400).json({
          message: 'Missing required fields: scenario_label, total_cost.'
        });
      }
  
      const alreadyOrderedSet = new Set();
  
      const placeholdersAll = [];
      const allPackages = [];
      if (Array.isArray(allocations)) {
        allocations.forEach(alloc => {
          if (alloc.packages && Array.isArray(alloc.packages)) {
            alloc.packages.forEach(pk => allPackages.push(pk));
          }
        });
      }
  
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
  
      const createdOrders = [];
  
      for (const alloc of allocations) {
        const vehicle_ID = alloc.vehicle_ID;
        if (!vehicle_ID) {
          throw new Error("Allocation is missing vehicle_ID property");
        }
      
        const costThis = alloc.cost || 0;
        const pkgArr = alloc.packages || [];
      
        numericPart++;
        const newNumeric = numericPart;
        const padded = String(newNumeric).padStart(6, '0');
        const newOrderID = 'ORD' + padded;
      
        const singleAllocJson = JSON.stringify([alloc]);
        const allocatedPackagesJson = JSON.stringify(pkgArr);
        const allocatedVehiclesJson = JSON.stringify([vehicle_ID]);
      
        await db.query(`
          INSERT INTO orders
            (order_ID, scenario_label, total_cost, allocations, unallocated_packages,
             allocated_packages, allocated_vehicles, created_at, updated_at, order_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          newOrderID,
          scenario_label,
          costThis,
          singleAllocJson,
          JSON.stringify(unallocated_packages || []),
          allocatedPackagesJson,
          allocatedVehiclesJson,
          created_at || new Date().toISOString(),
          updated_at || new Date().toISOString(),
          "order placed"
        ]);
      
        if (pkgArr.length > 0) {
          const placeholders2 = pkgArr.map(() => '?').join(',');
          await db.query(`
            UPDATE packages
            SET package_status = 'ordered'
            WHERE pack_ID IN (${placeholders2})
          `, pkgArr);
        }
      
        createdOrders.push({
          order_ID: newOrderID,
          vehicle_ID,
          allocated_packages: pkgArr,
          cost: costThis
        });
      }
      
      return res.status(201).json({
        message: 'Orders confirmed successfully (per vehicle).',
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

router.get('/order-by-id', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID } = req.query;
        if (!order_ID) {
            return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
        }

        const [orderResult] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderResult.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const order = orderResult[0];
        let allocatedPackages = [];
        let allocatedVehicles = [];

        // Safe JSON parsing function
        const safeParse = (data) => {
            if (!data) return [];
            if (Array.isArray(data)) return data;
            if (typeof data === 'string') {
                try {
                    return JSON.parse(data);
                } catch {
                    return data.split(',').map(item => item.trim());
                }
            }
            return [];
        };

        allocatedPackages = safeParse(order.allocated_packages);
        allocatedVehicles = safeParse(order.allocated_vehicles);

        let packageDetails = [];
        if (allocatedPackages.length > 0) {
            const packagePlaceholders = allocatedPackages.map(() => '?').join(',');
            const [packages] = await db.query(`
                SELECT * FROM packages WHERE pack_ID IN (${packagePlaceholders})
            `, allocatedPackages);
            packageDetails = packages;
        }

        let vehicleDetails = [];
        if (allocatedVehicles.length > 0) {
            const vehiclePlaceholders = allocatedVehicles.map(() => '?').join(',');
            const [vehicles] = await db.query(`
                SELECT * FROM master_vehicles WHERE vehicle_ID IN (${vehiclePlaceholders})
            `, allocatedVehicles);
            vehicleDetails = vehicles;
        }

        return res.status(200).json({
            message: 'Order retrieved successfully.',
            order,
            allocated_packages_details: packageDetails,
            allocated_vehicles: vehicleDetails
        });

    } catch (error) {
        logger.error('Error fetching order by ID:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});



router.put('/edit-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID } = req.query;
        const { order_status, allocated_packages, allocated_vehicles } = req.body;

        if (!order_ID) {
            return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
        }

        const [orderExists] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderExists.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const now = new Date().toISOString();

        await db.query(`
            UPDATE orders
            SET order_status = ?, allocated_packages = ?, allocated_vehicles = ?, updated_at = ?
            WHERE order_ID = ?
        `, [
            order_status,
            JSON.stringify(allocated_packages || []),
            JSON.stringify(allocated_vehicles || []),
            now,
            order_ID
        ]);

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
