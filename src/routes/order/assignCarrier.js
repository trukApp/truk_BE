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

        // Get valid carriers (contract = 1 and contract_valid_upto >= today)
        const [validCarriers] = await db.query(`
            SELECT carrier_ID FROM carriers
            WHERE contract = 1 AND DATE(contract_valid_upto) >= CURDATE()
        `);

        if (!validCarriers.length) {
            return res.status(400).json({ message: 'No valid contracted carriers found.' });
        }

        const req_sent_to = validCarriers.map(c => c.carrier_ID);
        const cas_ID = await generateCasID();

        await db.query(`
            INSERT INTO carrier_assignments 
            (cas_ID, order_ID, req_sent_to, assigned_time, order_status)
            VALUES (?, ?, ?, ?, ?)
        `, [
            cas_ID,
            order_ID,
            JSON.stringify(req_sent_to),
            assigned_time,
            'Pending'
        ]);

        res.status(201).json({
            message: 'Carrier assignment initialized successfully.',
            cas_ID,
            req_sent_to
        });
    } catch (error) {
        logger.error("Error assigning carrier:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
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
