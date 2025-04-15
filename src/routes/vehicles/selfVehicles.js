const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

const generateStrkID = (lastNumericPart) => {
    const numPart = lastNumericPart + 1;
    const numDigits = numPart.toString().length;
    const requiredZeros = Math.max(6 - numDigits, 0);
    return `STR${'0'.repeat(requiredZeros)}${numPart}`;
};

// Add self vehicles
router.post('/add-self-vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { vehicles } = req.body;

        if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
            return res.status(400).json({ message: 'Invalid payload. Provide an array of vehicles.' });
        }

        const [lastResult] = await db.query(`
            SELECT strk_ID FROM self_vehicles 
            ORDER BY LENGTH(strk_ID) DESC, strk_ID DESC LIMIT 1
        `);

        let lastNumericPart = 0;
        if (lastResult.length > 0) {
            lastNumericPart = parseInt(lastResult[0].strk_ID.slice(3));
        }

        const values = [];

        for (const vehicle of vehicles) {
            lastNumericPart += 1;
            const strk_ID = generateStrkID(lastNumericPart);

            values.push([
                strk_ID,
                vehicle.vehicle_ID,
                vehicle.self_vehicle_num,
                vehicle.available || 0,
                JSON.stringify(vehicle.costing || {}),
                JSON.stringify(vehicle.self_vehicle_docs || {})
            ]);
        }

        await db.query(`
            INSERT INTO self_vehicles 
                (strk_ID, vehicle_ID, self_vehicle_num, available, costing, self_vehicle_docs)
            VALUES ?
        `, [values]);

        res.status(201).json({ message: 'Self vehicles added successfully.' });
    } catch (error) {
        logger.error('Error adding self vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Get all self vehicles
router.get('/all-self-vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [vehicles] = await db.query(`
            SELECT * FROM self_vehicles ORDER BY str_id DESC
        `);
        res.status(200).json({ data: vehicles });
    } catch (error) {
        logger.error('Error fetching self vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Search self vehicles
router.get('/search-self-vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { searchKey, page, limit } = req.query;

        if (!searchKey || searchKey.trim().length < 1) {
            return res.status(400).json({ message: 'Search key is required in the query.' });
        }

        const searchPattern = `%${searchKey}%`;

        const query = `
            SELECT * FROM self_vehicles
            WHERE strk_ID LIKE ? OR self_vehicle_num LIKE ?
            ORDER BY str_id DESC
        `;

        const paginatedQuery = applyPagination(query, page, limit);
        const [vehicles] = await db.query(paginatedQuery, [searchPattern, searchPattern]);

        if (vehicles.length === 0) {
            return res.status(404).json({ message: 'No self vehicles found matching the search criteria.' });
        }

        res.status(200).json({
            message: 'Self vehicles retrieved successfully.',
            searchKey,
            results: vehicles
        });
    } catch (error) {
        logger.error('Error searching self vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Get self vehicle by filters
router.get('/self-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { strk_ID, vehicle_ID, available } = req.query;

        if (!strk_ID && !vehicle_ID && available === undefined) {
            return res.status(400).json({ message: 'Please provide strk_ID, vehicle_ID, or available status.' });
        }

        let condition = [];
        let values = [];

        if (strk_ID) {
            condition.push('sv.strk_ID = ?');
            values.push(strk_ID);
        }
        if (vehicle_ID) {
            condition.push('sv.vehicle_ID = ?');
            values.push(vehicle_ID);
        }
        if (available !== undefined) {
            condition.push('sv.available = ?');
            values.push(available);
        }

        const query = `
            SELECT sv.*, mv.*
            FROM self_vehicles sv
            LEFT JOIN master_vehicles mv ON sv.vehicle_ID = mv.vehicle_ID
            WHERE ${condition.join(' OR ')}
        `;

        const [result] = await db.query(query, values);
        res.status(200).json({ data: result });
    } catch (error) {
        logger.error('Error fetching self vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Edit self vehicle
router.put('/edit-self-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { str_id } = req.query;
        const {
            vehicle_ID,
            self_vehicle_num,
            available,
            costing,
            self_vehicle_docs
        } = req.body;

        if (!str_id) {
            return res.status(400).json({ message: 'str_id is required in query.' });
        }

        let updateFields = [];
        let values = [];

        if (vehicle_ID) {
            updateFields.push('vehicle_ID = ?');
            values.push(vehicle_ID);
        }
        if (self_vehicle_num) {
            updateFields.push('self_vehicle_num = ?');
            values.push(self_vehicle_num);
        }
        if (available !== undefined) {
            updateFields.push('available = ?');
            values.push(available);
        }
        if (costing) {
            updateFields.push('costing = ?');
            values.push(JSON.stringify(costing));
        }
        if (self_vehicle_docs) {
            updateFields.push('self_vehicle_docs = ?');
            values.push(JSON.stringify(self_vehicle_docs));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(str_id);
        const query = `UPDATE self_vehicles SET ${updateFields.join(', ')} WHERE str_id = ?`;

        await db.query(query, values);
        res.status(200).json({ message: 'Self vehicle updated successfully.' });
    } catch (error) {
        logger.error('Error updating self vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Delete self vehicle
router.delete('/delete-self-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { str_id } = req.query;

        if (!str_id) {
            return res.status(400).json({ message: 'str_id is required in query.' });
        }

        await db.query(`DELETE FROM self_vehicles WHERE str_id = ?`, [str_id]);
        res.status(200).json({ message: 'Self vehicle deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting self vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

module.exports = router;
