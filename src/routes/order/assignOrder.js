const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

const generateAssignID = async () => {
    try {
        const [result] = await db.query(
            `SELECT assign_ID FROM assigning_orders ORDER BY LENGTH(assign_ID) DESC, assign_ID DESC LIMIT 1`
        );

        let nextID = "AO000001";
        if (result.length > 0 && result[0].assign_ID) {
            let lastID = result[0].assign_ID;
            let numPart = parseInt(lastID.slice(2)) + 1;
            let numDigits = numPart.toString().length;
            let requiredZeros = Math.max(6 - numDigits, 0);
            nextID = `AO${"0".repeat(requiredZeros)}${numPart}`;
        }

        return nextID;
    } catch (error) {
        logger.error("Error generating assign_ID:", error);
        throw new Error("Failed to generate assign_ID");
    }
};

router.post('/assign-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID, assigned_vehicle_data, vehicle_docs, self_transport, dri_ID } = req.body;
        if (!order_ID || !dri_ID) {
            return res.status(400).json({ message: "order_ID and dri_ID are required." });
        }

        const assign_ID = await generateAssignID();

        await db.query(
            `INSERT INTO assigning_orders (assign_ID, order_ID, assigned_vehicle_data, vehicle_docs, self_transport, dri_ID)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [assign_ID, order_ID, JSON.stringify(assigned_vehicle_data), JSON.stringify(vehicle_docs), self_transport, dri_ID]
        );

        res.status(201).json({ message: "Assigned order created successfully", assign_ID });
    } catch (error) {
        logger.error("Error assigning order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.get('/assigned-orders', jwtAuth.verifyToken, async (req, res) => {
    try {
        let { page, limit } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;

        let query = `SELECT * FROM assigning_orders ORDER BY assigning_id DESC`;
        let paginatedQuery = applyPagination(query, page, limit);

        const [result] = await db.query(paginatedQuery);
        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching assigned orders:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.get('/assigned-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { assign_ID, order_ID, dri_ID } = req.query;

        const filters = [assign_ID, order_ID, dri_ID].filter(param => param !== undefined);
        if (filters.length !== 1) {
            return res.status(400).json({ message: "Please provide only one of assign_ID, order_ID, or dri_ID." });
        }

        let condition = "";
        let value = "";

        if (assign_ID) {
            condition = "ao.assign_ID = ?";
            value = assign_ID;
        } else if (order_ID) {
            condition = "ao.order_ID = ?";
            value = order_ID;
        } else if (dri_ID) {
            condition = "ao.dri_ID = ?";
            value = dri_ID;
        }

        const query = `
            SELECT 
                ao.*, 
                o.scenario_label, o.total_cost, o.allocations, o.unallocated_packages, o.created_at, o.updated_at, o.order_status,
                md.driver_name, md.address, md.locations, md.driver_correspondence, md.vehicle_types, md.logged_in
            FROM assigning_orders ao
            LEFT JOIN orders o ON ao.order_ID = o.order_ID
            LEFT JOIN master_drivers md ON ao.dri_ID = md.dri_ID
            WHERE ${condition}`;

        const [result] = await db.query(query, [value]);

        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching assigned order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.put('/update-assigned-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { assigning_id } = req.query;
        const { order_ID, assigned_vehicle_data, vehicle_docs, self_transport, dri_ID } = req.body;

        if (!assigning_id) {
            return res.status(400).json({ message: "assigning_id is required in query." });
        }

        let updateFields = [];
        let values = [];

        if (order_ID) {
            updateFields.push("order_ID = ?");
            values.push(order_ID);
        }
        if (assigned_vehicle_data) {
            updateFields.push("assigned_vehicle_data = ?");
            values.push(JSON.stringify(assigned_vehicle_data));
        }
        if (vehicle_docs) {
            updateFields.push("vehicle_docs = ?");
            values.push(JSON.stringify(vehicle_docs));
        }
        if (self_transport !== undefined) {
            updateFields.push("self_transport = ?");
            values.push(self_transport);
        }
        if (dri_ID) {
            updateFields.push("dri_ID = ?");
            values.push(dri_ID);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: "No fields provided for update." });
        }

        values.push(assigning_id);
        const query = `UPDATE assigning_orders SET ${updateFields.join(", ")} WHERE assigning_id = ?`;

        await db.query(query, values);
        res.status(200).json({ message: "Assigned order updated successfully." });
    } catch (error) {
        logger.error("Error updating assigned order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.delete('/delete-assigned-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { assigning_id } = req.query;

        if (!assigning_id) {
            return res.status(400).json({ message: "assigning_id is required in query." });
        }

        await db.query(`DELETE FROM assigning_orders WHERE assigning_id = ?`, [assigning_id]);
        res.status(200).json({ message: "Assigned order deleted successfully." });
    } catch (error) {
        logger.error("Error deleting assigned order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

module.exports = router;
