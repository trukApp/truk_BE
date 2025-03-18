const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

const generateTrukID = (lastNumericPart) => {
    const numPart = lastNumericPart + 1;
    const numDigits = numPart.toString().length;
    const requiredZeros = Math.max(6 - numDigits, 0);
    return `TR${"0".repeat(requiredZeros)}${numPart}`;
};

router.post('/add-vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { vehicles } = req.body;

        if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
            return res.status(400).json({ message: 'Invalid payload. Provide an array of vehicles.' });
        }

        const [lastResult] = await db.query(`
            SELECT act_truk_ID FROM act_vehicles 
            ORDER BY LENGTH(act_truk_ID) DESC, act_truk_ID DESC LIMIT 1
        `);

        let lastNumericPart = 0;
        if (lastResult.length > 0) {
            lastNumericPart = parseInt(lastResult[0].act_truk_ID.slice(2));
        }

        const values = [];

        for (const vehicle of vehicles) {
            lastNumericPart += 1;
            const act_truk_ID = generateTrukID(lastNumericPart);

            values.push([
                act_truk_ID,
                vehicle.vehicle_ID,
                vehicle.act_vehicle_num,
                vehicle.available || 0,
                vehicle.costing,
                JSON.stringify(vehicle.vehicle_docs || {})
            ]);
        }

        await db.query(`
            INSERT INTO act_vehicles (act_truk_ID, vehicle_ID, act_vehicle_num, available, costing, vehicle_docs)
            VALUES ?`, [values]
        );

        res.status(201).json({ message: 'Vehicles added successfully.' });
    } catch (error) {
        logger.error('Error adding vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


router.get('/all-vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [vehicles] = await db.query(`
            SELECT * FROM act_vehicles ORDER BY truk_id DESC
        `);
        res.status(200).json({ data: vehicles });
    } catch (error) {
        logger.error('Error fetching vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});



router.get('/search-trucks', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { searchKey, page, limit } = req.query;

        if (!searchKey || searchKey.trim().length < 1) {
            return res.status(400).json({ message: 'Search key is required in the query.' });
        }

        const query = `
            SELECT * FROM act_vehicles 
            WHERE 
                act_truk_ID LIKE ? 
                OR act_vehicle_num LIKE ?
        `;

        const searchPattern = `%${searchKey}%`;

        const paginatedQuery = applyPagination(query, page, limit);
        const [trucks] = await db.query(paginatedQuery, [searchPattern, searchPattern]);

        if (trucks.length === 0) {
            return res.status(404).json({ message: 'No trucks found matching the search criteria.' });
        }

        return res.status(200).json({
            message: 'Trucks retrieved successfully.',
            searchKey,
            results: trucks
        });
    } catch (error) {
        logger.error('Error searching trucks:', error);
        return res.status(500).json({ message: 'An error occurred while searching trucks.', error: error.message });
    }
});


router.get('/vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { act_truk_ID, vehicle_ID, available } = req.query;

        if (!act_truk_ID && !vehicle_ID && available === undefined) {
            return res.status(400).json({ message: 'Please provide act_truk_ID, vehicle_ID, or available status.' });
        }

        let condition = [];
        let values = [];

        if (act_truk_ID) {
            condition.push('av.act_truk_ID = ?');
            values.push(act_truk_ID);
        }
        if (vehicle_ID) {
            condition.push('av.vehicle_ID = ?');
            values.push(vehicle_ID);
        }
        if (available !== undefined) {
            condition.push('av.available = ?');
            values.push(available);
        }

        const query = `
            SELECT av.*, mv.*
            FROM act_vehicles av
            LEFT JOIN master_vehicles mv ON av.vehicle_ID = mv.vehicle_ID
            WHERE ${condition.join(' OR ')}
        `;

        const [result] = await db.query(query, values);

        res.status(200).json({ data: result });
    } catch (error) {
        logger.error('Error fetching vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


router.put('/edit-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { truk_id } = req.query;
        const { vehicle_ID, act_vehicle_num, available, costing, vehicle_docs } = req.body;

        if (!truk_id) {
            return res.status(400).json({ message: 'truk_id is required in query.' });
        }

        let updateFields = [];
        let values = [];

        if (vehicle_ID) {
            updateFields.push('vehicle_ID = ?');
            values.push(vehicle_ID);
        }
        if (act_vehicle_num) {
            updateFields.push('act_vehicle_num = ?');
            values.push(act_vehicle_num);
        }
        if (available !== undefined) {
            updateFields.push('available = ?');
            values.push(available);
        }
        if (costing) {
            updateFields.push('costing = ?');
            values.push(costing);
        }
        if (vehicle_docs) {
            updateFields.push('vehicle_docs = ?');
            values.push(JSON.stringify(vehicle_docs));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(truk_id);
        const query = `UPDATE act_vehicles SET ${updateFields.join(', ')} WHERE truk_id = ?`;

        await db.query(query, values);
        res.status(200).json({ message: 'Vehicle updated successfully.' });
    } catch (error) {
        logger.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


router.delete('/delete-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { truk_id } = req.query;

        if (!truk_id) {
            return res.status(400).json({ message: 'truk_id is required in query.' });
        }

        await db.query(`DELETE FROM act_vehicles WHERE truk_id = ?`, [truk_id]);
        res.status(200).json({ message: 'Vehicle deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

module.exports = router;
