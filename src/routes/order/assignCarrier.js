const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

// Generate unique cas_ID like "CA000001"
const generateCasID = async () => {
    try {
        const [result] = await db.query(
            `SELECT cas_ID FROM carrier_assignments ORDER BY LENGTH(cas_ID) DESC, cas_ID DESC LIMIT 1`
        );

        let nextID = "CA000001";
        if (result.length > 0 && result[0].cas_ID) {
            let lastID = result[0].cas_ID;
            let numPart = parseInt(lastID.slice(2)) + 1;
            let numDigits = numPart.toString().length;
            let requiredZeros = Math.max(6 - numDigits, 0);
            nextID = `CA${"0".repeat(requiredZeros)}${numPart}`;
        }

        return nextID;
    } catch (error) {
        logger.error("Error generating cas_ID:", error);
        throw new Error("Failed to generate cas_ID");
    }
};

// Add carrier assignment
// router.post('/assign-carrier', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const {
//             order_ID,
//             req_sent_to,
//             confirmed_to,
//             vehicle_num,
//             driver_data,
//             device_ID,
//             total_cost,
//             assigned_time,
//             confirmed_time,
//             order_status
//         } = req.body;

//         if (!order_ID) {
//             return res.status(400).json({ message: 'order_ID is required.' });
//         }

//         const cas_ID = await generateCasID();

//         await db.query(`
//             INSERT INTO carrier_assignments 
//             (cas_ID, order_ID, req_sent_to, confirmed_to, vehicle_num, driver_data, device_ID, total_cost, assigned_time, confirmed_time, order_status)
//             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//         `, [
//             cas_ID,
//             order_ID,
//             JSON.stringify(req_sent_to || []),
//             confirmed_to,
//             vehicle_num,
//             JSON.stringify(driver_data || {}),
//             device_ID,
//             total_cost,
//             assigned_time,
//             confirmed_time,
//             order_status
//         ]);

//         res.status(201).json({ message: 'Carrier assignment created successfully.', cas_ID });
//     } catch (error) {
//         logger.error("Error assigning carrier:", error);
//         res.status(500).json({ message: "Internal Server Error", error: error.message });
//     }
// });

router.post('/assign-carrier', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID, assigned_time } = req.body;

        if (!order_ID) {
            return res.status(400).json({ message: 'order_ID is required.' });
        }

        // Step 1: Get valid carriers
        const [validCarriers] = await db.query(`
            SELECT carrier_ID, pricing FROM carriers
            WHERE contract = 1 AND DATE(contract_valid_upto) >= CURDATE()
        `);

        if (!validCarriers.length) {
            return res.status(400).json({ message: 'No valid contracted carriers found.' });
        }

        const req_sent_to = validCarriers.map(c => c.carrier_ID);
        const selectedCarrier = validCarriers[0]; // using first eligible carrier for cost calculation

        // Step 2: Fetch the order's allocation data
        const [orders] = await db.query(`SELECT allocations FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orders.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const allocations = JSON.parse(orders[0].allocations || '[]');
        let totalWeight = 0;
        let totalDistance = 0;

        allocations.forEach(allocation => {
            const occupiedWeight = allocation.occupiedWeight || 0;
            const distanceStr = allocation.route?.[0]?.distance || '';
            const distanceVal = parseFloat(distanceStr.replace(/[^\d.]/g, '')) || 0;

            totalWeight += occupiedWeight;
            totalDistance += distanceVal;
        });

        let pricing = {};

        try {
            if (typeof selectedCarrier.pricing === 'string') {
                pricing = JSON.parse(selectedCarrier.pricing);
            } else if (typeof selectedCarrier.pricing === 'object' && selectedCarrier.pricing !== null) {
                pricing = selectedCarrier.pricing;
            } else {
                pricing = {};
            }
        } catch (err) {
            return res.status(400).json({ message: 'Invalid pricing format in selected carrier.' });
        }
        


        let calculatedCost = 0;
        const assignment_cost = {
            cost_criteria_considered: pricing.cost_criteria_per || '',
            total_weight: null,
            total_distance: null,
            cost: 0
        };

        if (pricing.cost_criteria_per === 'ton') {
            assignment_cost.total_weight = totalWeight;
            calculatedCost = (parseFloat(pricing.cost) || 0) * (totalWeight / 1000);
        } else if (pricing.cost_criteria_per === 'km') {
            assignment_cost.total_distance = totalDistance;
            calculatedCost = (parseFloat(pricing.cost) || 0) * totalDistance;
        }

        assignment_cost.cost = calculatedCost.toFixed(2);

        // Step 4: Insert into carrier_assignments
        const cas_ID = await generateCasID();

        await db.query(`
            INSERT INTO carrier_assignments 
            (cas_ID, order_ID, req_sent_to, assigned_time, assignment_status, assignment_cost)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            cas_ID,
            order_ID,
            JSON.stringify(req_sent_to),
            assigned_time,
            'Pending',
            JSON.stringify(assignment_cost)
        ]);

        // Step 5: Update order status
        await db.query(
            `UPDATE orders SET order_status = ? WHERE order_ID = ?`,
            ['carrier assignment', order_ID]
        );

        res.status(201).json({
            message: 'Carrier assignment initialized successfully.',
            cas_ID,
            req_sent_to,
            assignment_cost
        });
    } catch (error) {
        logger.error("Error assigning carrier:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});


router.get('/carrier-assignments', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'carrier_ID is required in query.' });
        }

        // Step 1: Get assignments with matching carrier_ID and assignment_status = 'Pending'
        const [assignments] = await db.query(`
            SELECT ca.*, o.*
            FROM carrier_assignments ca
            LEFT JOIN orders o ON ca.order_ID = o.order_ID
            WHERE JSON_CONTAINS(ca.req_sent_to, JSON_QUOTE(?), '$')
              AND ca.assignment_status = 'Pending'
            ORDER BY ca.ca_id DESC
        `, [carrier_ID]);

        if (assignments.length === 0) {
            return res.status(404).json({ message: 'No assignments found for this carrier with status Pending.' });
        }

        // Step 2: Collect all unique allocated package IDs
        const allPackageIDs = new Set();

        for (const a of assignments) {
            let allocated = [];

            if (Array.isArray(a.allocated_packages)) {
                allocated = a.allocated_packages;
            } else if (typeof a.allocated_packages === 'string') {
                try {
                    const parsed = JSON.parse(a.allocated_packages);
                    if (Array.isArray(parsed)) {
                        allocated = parsed;
                    } else {
                        allocated = a.allocated_packages
                            .replace(/[\[\]"]/g, '')
                            .split(',')
                            .map(s => s.trim())
                            .filter(Boolean);
                    }
                } catch {
                    allocated = a.allocated_packages
                        .replace(/[\[\]"]/g, '')
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean);
                }
            }

            allocated.forEach(pkg => allPackageIDs.add(pkg));
        }

        // Step 3: Fetch all package details
        const packageList = [...allPackageIDs];
        let packagesData = [];

        if (packageList.length > 0) {
            const placeholders = packageList.map(() => '?').join(',');
            const [packages] = await db.query(
                `SELECT * FROM packages WHERE pack_ID IN (${placeholders})`,
                packageList
            );
            packagesData = packages;
        }

        res.status(200).json({
            assignments,
            packages: packagesData
        });
    } catch (error) {
        logger.error('Error fetching carrier assignments:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});






// Get all assignments with pagination
router.get('/all-assignments', jwtAuth.verifyToken, async (req, res) => {
    try {
        let { page, limit } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;

        const query = `SELECT * FROM carrier_assignments ORDER BY ca_id DESC`;
        const paginatedQuery = applyPagination(query, page, limit);

        const [result] = await db.query(paginatedQuery);
        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching carrier assignments:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Get single assignment by cas_ID or order_ID
router.get('/assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { cas_ID, order_ID } = req.query;

        if (!cas_ID && !order_ID) {
            return res.status(400).json({ message: 'Please provide cas_ID or order_ID in query.' });
        }

        let condition = '';
        let value = '';

        if (cas_ID) {
            condition = 'cas_ID = ?';
            value = cas_ID;
        } else if (order_ID) {
            condition = 'order_ID = ?';
            value = order_ID;
        }

        const [result] = await db.query(`
            SELECT * FROM carrier_assignments WHERE ${condition}
        `, [value]);

        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Update assignment
router.put('/edit-assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { ca_id } = req.query;
        const {
            order_ID,
            req_sent_to,
            confirmed_to,
            vehicle_num,
            driver_data,
            device_ID,
            total_cost,
            assigned_time,
            confirmed_time,
            order_status
        } = req.body;

        if (!ca_id) {
            return res.status(400).json({ message: "ca_id is required in query." });
        }

        let updateFields = [];
        let values = [];

        if (order_ID) {
            updateFields.push("order_ID = ?");
            values.push(order_ID);
        }
        if (req_sent_to) {
            updateFields.push("req_sent_to = ?");
            values.push(JSON.stringify(req_sent_to));
        }
        if (confirmed_to) {
            updateFields.push("confirmed_to = ?");
            values.push(confirmed_to);
        }
        if (vehicle_num) {
            updateFields.push("vehicle_num = ?");
            values.push(vehicle_num);
        }
        if (driver_data) {
            updateFields.push("driver_data = ?");
            values.push(JSON.stringify(driver_data));
        }
        if (device_ID) {
            updateFields.push("device_ID = ?");
            values.push(device_ID);
        }
        if (total_cost) {
            updateFields.push("total_cost = ?");
            values.push(total_cost);
        }
        if (assigned_time) {
            updateFields.push("assigned_time = ?");
            values.push(assigned_time);
        }
        if (confirmed_time) {
            updateFields.push("confirmed_time = ?");
            values.push(confirmed_time);
        }
        if (order_status) {
            updateFields.push("order_status = ?");
            values.push(order_status);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: "No fields provided for update." });
        }

        values.push(ca_id);
        const query = `UPDATE carrier_assignments SET ${updateFields.join(", ")} WHERE ca_id = ?`;

        await db.query(query, values);
        res.status(200).json({ message: "Carrier assignment updated successfully." });
    } catch (error) {
        logger.error("Error updating assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Delete assignment
router.delete('/delete-assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { ca_id } = req.query;

        if (!ca_id) {
            return res.status(400).json({ message: "ca_id is required in query." });
        }

        await db.query(`DELETE FROM carrier_assignments WHERE ca_id = ?`, [ca_id]);
        res.status(200).json({ message: "Carrier assignment deleted successfully." });
    } catch (error) {
        logger.error("Error deleting assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

module.exports = router;
