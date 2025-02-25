const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/confirm-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            scenario_label,
            total_cost,
            allocations,
            unallocated_packages
        } = req.body;

        if (!scenario_label || total_cost == null) {
            return res.status(400).json({
                message: 'Missing required fields: scenario_label, total_cost.'
            });
        }

        const packagesToConfirm = new Set();
        if (Array.isArray(allocations)) {
            allocations.forEach(alloc => {
                if (Array.isArray(alloc.packages)) {
                    alloc.packages.forEach(packID => {
                        packagesToConfirm.add(packID);
                    });
                }
            });
        }
        
        const packageList = Array.from(packagesToConfirm);
        if (packageList.length === 0) {
            return res.status(400).json({
                message: 'No valid packages found for confirmation.'
            });
        }

        const placeholders = packageList.map(() => '?').join(',');
        const [existingPackages] = await db.query(`
            SELECT pack_ID FROM packages WHERE pack_ID IN (${placeholders}) AND package_status = 'ordered'
        `, packageList);

        if (existingPackages.length > 0) {
            const alreadyConfirmedPackages = existingPackages.map(row => row.pack_ID);
            return res.status(400).json({
                message: 'Some packages are already confirmed in an existing order.',
                alreadyConfirmedPackages
            });
        }

        const [result] = await db.query(`
            SELECT order_ID FROM orders ORDER BY ord_id DESC LIMIT 1 FOR UPDATE
        `);
        let lastOrderID = result[0]?.order_ID || 'ORD000000';
        const numericPart = parseInt(lastOrderID.slice(3), 10);
        const newNumeric = numericPart + 1;
        const padded = String(newNumeric).padStart(6, '0');
        const newOrderID = 'ORD' + padded;

        const now = new Date().toISOString();

        await db.query(`
            INSERT INTO orders
            (order_ID, scenario_label, total_cost, allocations, unallocated_packages, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            newOrderID,
            scenario_label,
            total_cost,
            JSON.stringify(allocations || []),
            JSON.stringify(unallocated_packages || []),
            now,
            now
        ]);

        await db.query(`
            UPDATE packages
            SET package_status = 'ordered'
            WHERE pack_ID IN (${placeholders})
        `, packageList);

        return res.status(201).json({
            message: 'Order confirmed successfully.',
            order_ID: newOrderID,
            scenario_label,
            total_cost,
            allocated_packages: packageList,
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

        const [order] = await db.query(`SELECT * FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!order.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        return res.status(200).json({ message: 'Order retrieved successfully.', order: order[0] });
    } catch (error) {
        logger.error('Error fetching order by ID:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});



router.put('/edit-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID } = req.query;
        const { scenario_label, total_cost, allocations, unallocated_packages } = req.body;

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
            SET scenario_label = ?, total_cost = ?, allocations = ?, unallocated_packages = ?, updated_at = ?
            WHERE order_ID = ?
        `, [
            scenario_label || orderExists[0].scenario_label,
            total_cost !== undefined ? total_cost : orderExists[0].total_cost,
            JSON.stringify(allocations || orderExists[0].allocations),
            JSON.stringify(unallocated_packages || orderExists[0].unallocated_packages),
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