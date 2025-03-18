const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


// router.post('/add-drivers', jwtAuth.verifyToken, async (req, res) => {
//     const { drivers } = req.body;

//     if (!drivers || !Array.isArray(drivers) || drivers.length === 0) {
//         return res.status(400).json({ message: 'Invalid payload. Provide an array of drivers.' });
//     }

//     try {
//         const [latestDriver] = await db.query(`
//             SELECT dri_ID 
//             FROM master_drivers 
//             ORDER BY driver_id DESC 
//             LIMIT 1 FOR UPDATE
//         `);

//         let nextId = latestDriver.length > 0
//             ? parseInt(latestDriver[0].dri_ID.replace('DRI', '')) + 1
//             : 1;

//         const values = drivers.map(driver => {
//             const dri_ID = `DRI${nextId.toString().padStart(6, '0')}`;
//             nextId++;
//             return [
//                 dri_ID,
//                 JSON.stringify(driver.locations),
//                 driver.driver_name,
//                 driver.address,
//                 JSON.stringify(driver.driver_correspondence),
//                 JSON.stringify(driver.vehicle_types),
//                 driver.logged_in || 0
//             ];
//         });
//         console.log("values: ", values)
//         await db.query(`
//             INSERT INTO master_drivers (
//                 dri_ID,
//                 locations,
//                 driver_name,
//                 address,
//                 driver_correspondence,
//                 vehicle_types,
//                 logged_in
//             ) VALUES ?
//         `, [values]);

//         res.status(201).json({
//             message: 'Drivers added successfully',
//             addedDrivers: drivers.length
//         });
//     } catch (error) {
//         logger.error('Error adding drivers:', error);
//         res.status(500).json({ message: 'An error occurred while adding drivers', error: error.message });
//     }
// });


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

        // Create an array to store newly created drivers
        const createdDrivers = [];

        const values = drivers.map(driver => {
            const dri_ID = `DRI${nextId.toString().padStart(6, '0')}`;
            nextId++;

            const newDriver = {
                dri_ID,
                locations: driver.locations,
                driver_name: driver.driver_name,
                address: driver.address,
                driver_correspondence: driver.driver_correspondence,
                vehicle_types: driver.vehicle_types,
                logged_in: driver.logged_in || 0
            };

            createdDrivers.push(newDriver);

            return [
                dri_ID,
                JSON.stringify(driver.locations),
                driver.driver_name,
                driver.address,
                JSON.stringify(driver.driver_correspondence),
                JSON.stringify(driver.vehicle_types),
                driver.logged_in || 0,
                driver_availability ||0
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
                logged_in,
                driver_availability
            ) VALUES ?
        `, [values]);

        res.status(201).json({
            message: 'Drivers added successfully',
            // addedDrivers: createdDrivers
            created_records: createdDrivers.map(record => record.dri_ID)
        });
    } catch (error) {
        logger.error('Error adding drivers:', error);
        res.status(500).json({ message: 'An error occurred while adding drivers', error: error.message });
    }
});

router.post('/driver-authenticate', async (req, res) => {
    try {
        const { dri_ID, phone } = req.body;

        if (!dri_ID || !phone) {
            return res.status(400).json({ message: "dri_ID and phone are required." });
        }

        const query = `SELECT dri_ID, driver_correspondence FROM master_drivers WHERE dri_ID = ?`;
        const [drivers] = await db.query(query, [dri_ID]);

        if (drivers.length === 0) {
            return res.status(404).json({ message: "Driver not found." });
        }

        const driver = drivers[0];
        let driverCorrespondence = driver.driver_correspondence;

        if (typeof driverCorrespondence === "string") {
            try {
                driverCorrespondence = JSON.parse(driverCorrespondence);
            } catch (error) {
                logger.error("Error parsing driver_correspondence:", error);
                return res.status(500).json({ message: "Invalid driver_correspondence format in database." });
            }
        }

        if (!driverCorrespondence || !driverCorrespondence.phone || driverCorrespondence.phone !== phone) {
            return res.status(401).json({ message: "Invalid phone number." });
        }

        const accessToken = jwtAuth.generateToken(dri_ID, "driver");
        const refreshToken = jwtAuth.generateRefreshToken(dri_ID, "driver");

        res.status(200).json({
            message: "Authentication successful.",
            dri_ID,
            accessToken,
            refreshToken
        });
    } catch (error) {
        logger.error("Error in driver authentication:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});


router.get('/get-drivers', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
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


router.get('/search-drivers', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { searchKey, page, limit } = req.query;

        if (!searchKey || searchKey.trim().length < 1) {
            return res.status(400).json({ message: 'Search key is required in the query.' });
        }

        const query = `
            SELECT * FROM master_drivers 
            WHERE 
                dri_ID LIKE ? 
                OR driver_name LIKE ? 
                OR JSON_EXTRACT(driver_correspondence, '$.phone') LIKE ?
        `;

        const searchPattern = `%${searchKey}%`;

        const paginatedQuery = applyPagination(query, page, limit);
        const [drivers] = await db.query(paginatedQuery, [searchPattern, searchPattern, searchPattern]);

        if (drivers.length === 0) {
            return res.status(404).json({ message: 'No drivers found matching the search criteria.' });
        }

        return res.status(200).json({
            message: 'Drivers retrieved successfully.',
            searchKey,
            results: drivers
        });
    } catch (error) {
        logger.error('Error searching drivers:', error);
        return res.status(500).json({ message: 'An error occurred while searching drivers.', error: error.message });
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
                logged_in,
                driver_availability
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
    const { locations, driver_name, address, driver_correspondence, vehicle_types, driver_availability, logged_in } = req.body;

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
                logged_in = ? ,
                driver_availability =?
            WHERE 
                driver_id = ?
        `, [
            JSON.stringify(locations),
            driver_name,
            address,
            JSON.stringify(driver_correspondence),
            JSON.stringify(vehicle_types),
            logged_in,
            driver_availability,
            driver_id,
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Driver not found or no changes made' });
        }
        const [updatedRecord] = await db.query(
            `SELECT * FROM master_drivers WHERE driver_id  = ?`,
            [driver_id]
        );
        res.status(200).json({
            message: 'Driver updated successfully',
            updated_record: updatedRecord[0]?.dri_ID
        });
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
        const query = "SELECT * FROM master_drivers where driver_id = ?";
        const [getData] = await db.query(query, driver_id);

        const [result] = await db.query(`
            DELETE FROM 
                master_drivers 
            WHERE 
                driver_id = ?
        `, [driver_id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        res.status(200).json({
            message: 'Driver deleted successfully',
            deleted_record: getData[0].dri_ID
        });
    } catch (error) {
        logger.error('Error deleting driver:', error);
        res.status(500).json({ message: 'An error occurred while deleting the driver', error: error.message });
    }
});



module.exports = router;