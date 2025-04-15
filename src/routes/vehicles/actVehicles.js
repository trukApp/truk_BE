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
            SELECT act_truk_ID FROM carrier_vehicles 
            ORDER BY LENGTH(act_truk_ID) DESC, act_truk_ID DESC LIMIT 1
        `);

        let lastNumericPart = 0;
        if (lastResult.length > 0) {
            lastNumericPart = parseInt(lastResult[0].act_truk_ID.slice(2));
        }

        const values = [];

        for (const vehicle of vehicles) {
            if (!vehicle.carrier_ID) {
                return res.status(400).json({ message: 'carrier_ID is required for each vehicle.' });
            }

            lastNumericPart += 1;
            const act_truk_ID = generateTrukID(lastNumericPart);

            values.push([
                act_truk_ID,
                vehicle.vehicle_ID,
                vehicle.act_vehicle_num,
                vehicle.available || 0,
                JSON.stringify(vehicle.costing || {}),
                JSON.stringify(vehicle.vehicle_docs || {}),
                vehicle.carrier_ID
            ]);
        }

        await db.query(`
            INSERT INTO carrier_vehicles 
                (act_truk_ID, vehicle_ID, act_vehicle_num, available, costing, vehicle_docs, carrier_ID)
            VALUES ?
        `, [values]);

        res.status(201).json({ message: 'Vehicles added successfully.' });
    } catch (error) {
        logger.error('Error adding vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Get all vehicles
router.get('/all-vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [vehicles] = await db.query(`
            SELECT * FROM carrier_vehicles ORDER BY truk_id DESC
        `);
        res.status(200).json({ data: vehicles });
    } catch (error) {
        logger.error('Error fetching vehicles:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Search trucks
router.get('/search-trucks', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { searchKey, page, limit } = req.query;

        if (!searchKey || searchKey.trim().length < 1) {
            return res.status(400).json({ message: 'Search key is required in the query.' });
        }

        const searchPattern = `%${searchKey}%`;

        const query = `
            SELECT 
                cv.*, 
                c.carrier_name, 
                c.carrier_address,
                c.carrier_correspondence,
                c.vehicle_types_handling,
                c.carrier_network_portal,
                c.carrier_loc_of_operation,
                c.carrier_lanes
            FROM carrier_vehicles cv
            LEFT JOIN carriers c ON cv.carrier_ID = c.carrier_ID
            WHERE 
                cv.act_truk_ID LIKE ? 
                OR cv.act_vehicle_num LIKE ?
                OR cv.carrier_ID LIKE ?
                OR c.carrier_name LIKE ?
            ORDER BY cv.truk_id DESC
        `;

        const paginatedQuery = applyPagination(query, page, limit);
        const [trucks] = await db.query(paginatedQuery, [
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern
        ]);

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


// Get vehicle by filters
router.get('/vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { act_truk_ID, vehicle_ID, available, carrier_ID } = req.query;

        if (!act_truk_ID && !vehicle_ID && available === undefined && !carrier_ID) {
            return res.status(400).json({ message: 'Please provide act_truk_ID, vehicle_ID, available status, or carrier_ID.' });
        }

        let condition = [];
        let values = [];

        if (act_truk_ID) {
            condition.push('cv.act_truk_ID = ?');
            values.push(act_truk_ID);
        }
        if (vehicle_ID) {
            condition.push('cv.vehicle_ID = ?');
            values.push(vehicle_ID);
        }
        if (available !== undefined) {
            condition.push('cv.available = ?');
            values.push(available);
        }
        if (carrier_ID) {
            condition.push('cv.carrier_ID = ?');
            values.push(carrier_ID);
        }

        const query = `
            SELECT 
                cv.*, 
                mv.*, 
                c.carrier_name,
                c.carrier_address,
                c.carrier_correspondence,
                c.carrier_network_portal,
                c.vehicle_types_handling,
                c.carrier_loc_of_operation,
                c.carrier_lanes
            FROM carrier_vehicles cv
            LEFT JOIN master_vehicles mv ON cv.vehicle_ID = mv.vehicle_ID
            LEFT JOIN carriers c ON cv.carrier_ID = c.carrier_ID
            WHERE ${condition.join(' OR ')}
        `;

        const [result] = await db.query(query, values);
        res.status(200).json({ data: result });
    } catch (error) {
        logger.error('Error fetching vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


// Edit vehicle
router.put('/edit-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { truk_id } = req.query;
        const {
            vehicle_ID,
            act_vehicle_num,
            available,
            costing,
            vehicle_docs,
            carrier_ID
        } = req.body;

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
            values.push(JSON.stringify(costing));
        }
        if (vehicle_docs) {
            updateFields.push('vehicle_docs = ?');
            values.push(JSON.stringify(vehicle_docs));
        }
        if (carrier_ID) {
            updateFields.push('carrier_ID = ?');
            values.push(carrier_ID);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(truk_id);
        const query = `UPDATE carrier_vehicles SET ${updateFields.join(', ')} WHERE truk_id = ?`;

        await db.query(query, values);
        res.status(200).json({ message: 'Vehicle updated successfully.' });
    } catch (error) {
        logger.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

// Delete vehicle
router.delete('/delete-vehicle', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { truk_id } = req.query;

        if (!truk_id) {
            return res.status(400).json({ message: 'truk_id is required in query.' });
        }

        await db.query(`DELETE FROM carrier_vehicles WHERE truk_id = ?`, [truk_id]);
        res.status(200).json({ message: 'Vehicle deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});

module.exports = router;
