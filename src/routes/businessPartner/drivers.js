const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const {applyPagination} = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/add-drivers', jwtAuth.verifyToken, async (req, res) => {
    const { drivers } = req.body;

    if (!drivers || !Array.isArray(drivers) || drivers.length === 0) {
        return res.status(400).json({ message: 'Invalid payload. Provide an array of drivers.' });
    }

    try {
        const [latestDriver] = await db.query(`
            SELECT dri_ID 
            FROM master_drivers 
            ORDER BY driver_id DESC 
            LIMIT 1 FOR UPDATE
        `);

        let nextId = latestDriver.length > 0
            ? parseInt(latestDriver[0].dri_ID.replace('DRI', '')) + 1
            : 1;

        const values = drivers.map(driver => {
            const dri_ID = `DRI${nextId.toString().padStart(6, '0')}`;
            nextId++;
            return [
                dri_ID,
                JSON.stringify(driver.locations),
                driver.driver_name,
                driver.address,
                JSON.stringify(driver.driver_correspondence),
                JSON.stringify(driver.vehicle_types),
                driver.logged_in || 0
            ];
        });

        await db.query(`
            INSERT INTO master_drivers (
                dri_ID,
                locations,
                driver_name,
                address,
                driver_correspondence,
                vehicle_types,
                logged_in
            ) VALUES ?
        `, [values]);

        res.status(201).json({
            message: 'Drivers added successfully',
            addedDrivers: drivers.length
        });
    } catch (error) {
        logger.error('Error adding drivers:', error);
        res.status(500).json({ message: 'An error occurred while adding drivers', error: error.message });
    }
});


// router.get('/get-drivers', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const [drivers] = await db.query(`
//             SELECT * FROM master_drivers
//         `);

//         res.status(200).json({
//             message: 'Drivers retrieved successfully',
//             drivers,
//         });
//     } catch (error) {
//         logger.error('Error retrieving drivers:', error);
//         res.status(500).json({ message: 'An error occurred while retrieving drivers', error: error.message });
//     }
// });


router.get('/get-drivers', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page , limit  } = req.query;
        const query = `SELECT * FROM master_drivers`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [drivers] = await db.query(paginatedQuery);

        res.status(200).json({
            message: 'Drivers retrieved successfully',
            drivers,
        });
    } catch (error) {
        logger.error('Error retrieving drivers:', error);
        res.status(500).json({ message: 'An error occurred while retrieving drivers', error: error.message });
    }
});



router.get('/get-driver', jwtAuth.verifyToken, async (req, res) => {
    const { dri_ID } = req.query;

    if (!dri_ID) {
        return res.status(400).json({ message: 'dri_ID is required in query parameters.' });
    }

    try {
        const [drivers] = await db.query(`
            SELECT 
                driver_id,
                dri_ID,
                locations,
                driver_name,
                address,
                driver_correspondence,
                vehicle_types,
                logged_in
            FROM 
                master_drivers
            WHERE 
                dri_ID = ?
        `, [dri_ID]);

        if (drivers.length === 0) {
            return res.status(404).json({ message: 'Driver not found.' });
        }

        const driver = drivers[0];

        // Parse JSON fields safely
        const parseJson = (data) => {
            if (!data) return [];
            if (typeof data === 'string') {
                try {
                    return JSON.parse(data);
                } catch {
                    return data.split(',').map((item) => item.trim().replace(/["[\]]/g, ''));
                }
            }
            return Array.isArray(data) ? data : [];
        };

        const driverLocations = parseJson(driver.locations);

        // Fetch locations based on driver's locations
        const [locations] = driverLocations.length
            ? await db.query(`SELECT * FROM master_locations WHERE loc_ID IN (?)`, [driverLocations])
            : [[], []]; // Return empty array if no locations

        res.status(200).json({
            message: 'Driver retrieved successfully',
            driver: {
                ...driver,
                locations: locations,
            },
        });
    } catch (error) {
        logger.error('Error retrieving driver:', error);
        res.status(500).json({ message: 'An error occurred while retrieving the driver.', error: error.message });
    }
});



router.put('/edit-driver', jwtAuth.verifyToken, async (req, res) => {
    const { driver_id } = req.query;
    const { locations, driver_name, address, driver_correspondence, vehicle_types, logged_in } = req.body;

    if (!driver_id) {
        return res.status(400).json({ message: 'driver_id is required in query parameters' });
    }

    try {
        const [result] = await db.query(`
            UPDATE 
                master_drivers 
            SET 
                locations = ?, 
                driver_name = ?, 
                address = ?, 
                driver_correspondence = ?, 
                vehicle_types = ?, 
                logged_in = ? 
            WHERE 
                driver_id = ?
        `, [
            JSON.stringify(locations),
            driver_name,
            address,
            JSON.stringify(driver_correspondence),
            JSON.stringify(vehicle_types),
            logged_in,
            driver_id,
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Driver not found or no changes made' });
        }

        res.status(200).json({ message: 'Driver updated successfully' });
    } catch (error) {
        logger.error('Error updating driver:', error);
        res.status(500).json({ message: 'An error occurred while updating the driver', error: error.message });
    }
});


router.delete('/delete-driver', jwtAuth.verifyToken, async (req, res) => {
    const { driver_id } = req.query;

    if (!driver_id) {
        return res.status(400).json({ message: 'driver_id is required in query parameters' });
    }

    try {
        const [result] = await db.query(`
            DELETE FROM 
                master_drivers 
            WHERE 
                driver_id = ?
        `, [driver_id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        res.status(200).json({ message: 'Driver deleted successfully' });
    } catch (error) {
        logger.error('Error deleting driver:', error);
        res.status(500).json({ message: 'An error occurred while deleting the driver', error: error.message });
    }
});



module.exports = router;