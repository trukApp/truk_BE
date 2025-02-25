const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/create-location', jwtAuth.verifyToken, async (req, res) => {
    try {
        const locations = req.body.locations;

        if (!Array.isArray(locations) || locations.length === 0) {
            return res.status(400).json({ message: 'Invalid input. Provide at least one location.' });
        }

        const insertValues = [];
        const insertredLocationIDs = []
        const [result] = await db.query(
            "SELECT loc_ID FROM master_locations ORDER BY location_id DESC LIMIT 1 FOR UPDATE"
        );
        let lastLocID = result[0]?.loc_ID || 'LOC0000';

        locations.forEach(location => {
            const {
                loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type,
                gln_code, iata_code, address_1, address_2, contact_name, contact_phone_number, contact_email
            } = location;

            if (!loc_desc || !longitude || !latitude || !city || !state || !country || !pincode || !loc_type || !contact_name || !contact_phone_number || !contact_email) {
                throw new Error('Missing required fields in one of the locations.');
            }

            lastLocID = `LOC${String(parseInt(lastLocID.slice(3)) + 1).padStart(6, '0')}`;
            insertredLocationIDs.push(lastLocID);

            insertValues.push([
                lastLocID, loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type,
                gln_code, iata_code, address_1 || null, address_2 || null, contact_name || null, contact_phone_number || null, contact_email || null
            ]);
        });

        await db.query(
            "INSERT INTO master_locations (loc_ID, loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type, gln_code, iata_code, address_1, address_2,  contact_name, contact_phone_number, contact_email) VALUES ?",
            [insertValues]
        );

        const [createdRecords] = await db.query(
            `SELECT * FROM master_locations WHERE loc_ID IN (?)`,
            [insertredLocationIDs]
        );

        res.status(201).json({
            message: 'Locations created successfully.',
            count: insertValues.length,
            created_records: createdRecords.map(record => record.loc_ID)
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: error || 'Server error.' });
    }
});



// router.get('/all-locations',jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const [locations] = await db.query("SELECT * FROM master_locations");
//         res.status(200).json({ locations });
//     } catch (error) {
//         logger.error(error);
//         res.status(500).json({ message: 'Server error.' });
//     }
// });

router.get('/all-locations', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
        const query = `SELECT * FROM master_locations`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [locations] = await db.query(paginatedQuery);

        res.status(200).json({
            message: 'Locations retrieved successfully',
            locations,
        });
    } catch (error) {
        logger.error('Error fetching locations:', error);
        res.status(500).json({ message: 'An error occurred while fetching locations.', error: error.message });
    }
});


router.get('/search-locations', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { searchKey, page, limit } = req.query;

        if (!searchKey || searchKey.trim().length < 1) {
            return res.status(400).json({ message: 'Search key is required in the query.' });
        }

        const query = `
            SELECT * FROM master_locations 
            WHERE 
                loc_ID LIKE ? 
                OR city LIKE ? 
                OR state LIKE ? 
                OR pincode LIKE ? 
                OR loc_type LIKE ?
        `;

        const searchPattern = `%${searchKey}%`;

        const paginatedQuery = applyPagination(query, page, limit);
        const [locations] = await db.query(paginatedQuery, [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern]);

        if (locations.length === 0) {
            return res.status(404).json({ message: 'No locations found matching the search criteria.' });
        }

        return res.status(200).json({
            message: 'Locations retrieved successfully.',
            searchKey,
            results: locations
        });

    } catch (error) {
        logger.error('Error searching locations:', error);
        return res.status(500).json({ message: 'An error occurred while searching locations.', error: error.message });
    }
});



router.get('/location-ID', jwtAuth.verifyToken, async (req, res) => {
    const { loc_ID } = req.query;
    try {
        const query = "SELECT * FROM master_locations where loc_ID = ?";
        const [locations] = await db.query(query, loc_ID);
        res.status(200).json({ locations });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});


router.put('/edit-location', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { id } = req.query;
        const {
            loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type,
            gln_code, iata_code, address_1, address_2, contact_name, contact_email, contact_phone_number
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'location_id is required in the query.' });
        }

        const [updateResult] = await db.query(
            `UPDATE master_locations 
            SET 
                loc_desc = COALESCE(?, loc_desc), 
                longitude = COALESCE(?, longitude), 
                latitude = COALESCE(?, latitude), 
                time_zone = COALESCE(?, time_zone), 
                city = COALESCE(?, city), 
                state = COALESCE(?, state), 
                country = COALESCE(?, country), 
                pincode = COALESCE(?, pincode), 
                loc_type = COALESCE(?, loc_type), 
                gln_code = COALESCE(?, gln_code), 
                iata_code = COALESCE(?, iata_code),
                address_1 = COALESCE(?, address_1),
                address_2 = COALESCE(?, address_2),
                contact_name = COALESCE(?, contact_name),
                contact_phone_number = COALESCE(?, contact_phone_number),
                contact_email = COALESCE(?, contact_email)
            WHERE location_id = ?`,
            [
                loc_desc || null, longitude || null, latitude || null, time_zone || null,
                city || null, state || null, country || null, pincode || null, loc_type || null,
                gln_code || null, iata_code || null, address_1 || null, address_2 || null,
                contact_name || null, contact_phone_number || null, contact_email || null, id
            ]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }
        const [updatedLocation] = await db.query(
            `SELECT * FROM master_locations WHERE location_id = ?`,
            [id]
        );

        res.status(200).json({
            message: 'Location updated successfully.',
            updated_record: updatedLocation[0]?.loc_ID
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});



router.delete('/delete-location', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { id } = req.query;
        const query = "SELECT * FROM master_locations where location_id = ?";
        const [locationData] = await db.query(query, id);

        const [deleteResult] = await db.query(
            "DELETE FROM master_locations WHERE location_id = ?",
            [id]
        );

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }

        res.status(200).json({
            message: 'Location deleted successfully.',
            deleted_record: locationData[0].loc_ID
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});


router.put('/update-location-flag', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { loc_ID, def_ship_from, def_ship_to, def_bill_to } = req.query;

        if (!loc_ID) {
            return res.status(400).json({ message: 'loc_ID is required in the query.' });
        }

        const updateFields = {};
        if (def_ship_from !== undefined) updateFields.def_ship_from = def_ship_from;
        if (def_ship_to !== undefined) updateFields.def_ship_to = def_ship_to;
        if (def_bill_to !== undefined) updateFields.def_bill_to = def_bill_to;

        if (Object.keys(updateFields).length !== 1) {
            return res.status(400).json({
                message: 'Pass exactly one of def_ship_from, def_ship_to, or def_bill_to in the query.'
            });
        }

        const fieldToUpdate = Object.keys(updateFields)[0];
        const fieldValue = Object.values(updateFields)[0];

        const [existingFlags] = await db.query(
            `SELECT def_ship_from, def_ship_to, def_bill_to FROM master_locations WHERE loc_ID = ?`,
            [loc_ID]
        );

        if (existingFlags.length === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }

        const currentFlags = existingFlags[0];

        if (fieldValue === '1' &&
            (
                (fieldToUpdate === 'def_ship_from' && currentFlags.def_ship_to === 1) ||
                (fieldToUpdate === 'def_ship_to' && currentFlags.def_ship_from === 1)
            )
        ) {
            return res.status(400).json({
                message: `Cannot set ${fieldToUpdate} to 1. This loc_ID already has the other flag set to 1.`
            });
        }

        if (fieldValue === '1') {
            await db.query(
                `UPDATE master_locations SET ${fieldToUpdate} = NULL WHERE ${fieldToUpdate} = 1 AND loc_ID <> ?`,
                [loc_ID]
            );
        }

        const [updateResult] = await db.query(
            `UPDATE master_locations SET ${fieldToUpdate} = ? WHERE loc_ID = ?`,
            [fieldValue, loc_ID]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Location not found or no changes made.' });
        }

        const [updatedLocation] = await db.query(
            `SELECT loc_ID, loc_desc, def_ship_from, def_ship_to, def_bill_to FROM master_locations WHERE loc_ID = ?`,
            [loc_ID]
        );

        return res.status(200).json({
            message: `Successfully updated ${fieldToUpdate}.`,
            updated_record: updatedLocation[0]
        });

    } catch (error) {
        logger.error(error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});


router.get('/fetch-location-by-flag', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { def_ship_from, def_ship_to, def_bill_to } = req.query;

        if (
            [def_ship_from, def_ship_to, def_bill_to].filter(v => v !== undefined).length !== 1
        ) {
            return res.status(400).json({
                message: 'Pass exactly one of def_ship_from, def_ship_to, or def_bill_to in the query.'
            });
        }

        let fieldToQuery;
        if (def_ship_from !== undefined) fieldToQuery = 'def_ship_from';
        if (def_ship_to !== undefined) fieldToQuery = 'def_ship_to';
        if (def_bill_to !== undefined) fieldToQuery = 'def_bill_to';

        const query = `SELECT * FROM master_locations WHERE ${fieldToQuery} = 1`;
        const [locations] = await db.query(query);

        if (locations.length === 0) {
            return res.status(404).json({
                message: `No locations found where ${fieldToQuery} = 1.`
            });
        }

        return res.status(200).json({
            message: `Locations retrieved successfully for ${fieldToQuery} = 1`,
            locations
        });

    } catch (error) {
        logger.error(error);
        return res.status(500).json({
            message: 'Server error.',
            error: error.message
        });
    }
});



module.exports = router;