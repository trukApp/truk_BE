const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/create-carriers', jwtAuth.verifyToken, async (req, res) => {
    const carriers = req.body.carriers;

    if (!carriers || carriers.length === 0) {
        return res.status(400).json({ message: 'Please provide carrier data.' });
    }

    try {
        const carrierData = Array.isArray(carriers) ? carriers : [carriers];

        const [lastCarrier] = await db.query(`
            SELECT carrier_ID FROM carriers ORDER BY cr_id DESC LIMIT 1 FOR UPDATE
        `);

        let lastCarrierNumber = 0;
        if (lastCarrier.length > 0 && lastCarrier[0].carrier_ID) {
            lastCarrierNumber = parseInt(lastCarrier[0].carrier_ID.replace('CR', '')) || 0;
        }

        const newCarriers = carrierData.map((carrier, index) => {
            const carrier_ID = `CR${String(lastCarrierNumber + index + 1).padStart(6, '0')}`;
            return {
                ...carrier,
                carrier_ID,
            };
        });


        const insertPromises = newCarriers.map(async (carrier) => {
            const {
                carrier_ID,
                carrier_name,
                carrier_address,
                carrier_correspondence,
                carrier_network_portal,
                vehicle_types_handling,
                carrier_loc_of_operation,
                carrier_lanes,
                contract,
                contract_valid_upto,
                pricing,
            } = carrier;

            return db.query(
                `
                INSERT INTO carriers (
                    carrier_ID,
                    carrier_name,
                    carrier_address,
                    carrier_correspondence,
                    carrier_network_portal,
                    vehicle_types_handling,
                    carrier_loc_of_operation,
                    carrier_lanes,
                    contract,
                    contract_valid_upto,
                    pricing
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    carrier_ID,
                    carrier_name,
                    carrier_address,
                    JSON.stringify(carrier_correspondence || {}),
                    carrier_network_portal,
                    JSON.stringify(vehicle_types_handling || {}),
                    JSON.stringify(carrier_loc_of_operation || {}),
                    JSON.stringify(carrier_lanes || {}),
                    contract,
                    contract_valid_upto,
                    JSON.stringify(pricing|| {}),
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Carriers added successfully',
            created_records: newCarriers.map(record => record.carrier_ID),
            carriers: newCarriers,
        });
    } catch (error) {
        logger.error('Error creating carriers:', error);
        res.status(500).json({ message: 'An error occurred while creating carriers.', error: error.message });
    }
});


// router.get('/all-carriers', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const [carriers] = await db.query(`SELECT * FROM carriers`);

//         if (carriers.length === 0) {
//             return res.status(404).json({ message: 'No carriers found.' });
//         }

//         res.status(200).json({
//             message: 'Carriers retrieved successfully',
//             carriers,
//         });
//     } catch (error) {
//         logger.error('Error retrieving carriers:', error);
//         res.status(500).json({ message: 'An error occurred while retrieving carriers.', error: error.message });
//     }
// });


router.get('/all-carriers', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
        const query = `SELECT * FROM carriers`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [carriers] = await db.query(paginatedQuery);

        if (carriers.length === 0) {
            return res.status(404).json({ message: 'No carriers found.' });
        }

        res.status(200).json({
            message: 'Carriers retrieved successfully',
            carriers,
        });
    } catch (error) {
        logger.error('Error retrieving carriers:', error);
        res.status(500).json({ message: 'An error occurred while retrieving carriers.', error: error.message });
    }
});



router.get('/carrier-by-id', jwtAuth.verifyToken, async (req, res) => {
    const { carrier_ID } = req.query;

    if (!carrier_ID) {
        return res.status(400).json({ message: 'Please provide carrier_ID in query parameters.' });
    }

    try {
        const [carriers] = await db.query(`SELECT * FROM carriers WHERE carrier_ID = ?`, [carrier_ID]);

        if (carriers.length === 0) {
            return res.status(404).json({ message: 'Carrier not found.' });
        }

        const carrier = carriers[0];

        // Parse JSON fields safely
        const parseJson = (data) => {
            if (!data) return []; // Return empty array if data is null or undefined
            if (typeof data === 'string') {
                try {
                    return JSON.parse(data); // Parse if it's a valid JSON string
                } catch {
                    // Fallback for comma-separated strings
                    return data.split(',').map((item) => item.trim().replace(/["[\]]/g, ''));
                }
            }
            // Return as-is if already an array
            return Array.isArray(data) ? data : [];
        };

        const locOfOperation = parseJson(carrier.carrier_loc_of_operation);
        const carrierLanes = parseJson(carrier.carrier_lanes);

        // Fetch locations based on locOfOperation
        const [locations] = locOfOperation.length
            ? await db.query(`SELECT * FROM master_locations WHERE loc_ID IN (?)`, [locOfOperation])
            : [[], []]; // Return empty array if no locations

        // Fetch lanes based on carrierLanes
        const [lanes] = carrierLanes.length
            ? await db.query(
                `
                  SELECT 
                      ml.ln_id, 
                      ml.lane_ID, 
                      ml.lane_transport_data, 
                      ml.src_loc_id, 
                      src.loc_ID AS src_loc_ID, 
                      src.loc_desc AS src_loc_desc, 
                      src.longitude AS src_longitude, 
                      src.latitude AS src_latitude, 
                      src.city AS src_city, 
                      src.state AS src_state,
                      ml.des_loc_id, 
                      des.loc_ID AS des_loc_ID, 
                      des.loc_desc AS des_loc_desc, 
                      des.longitude AS des_longitude, 
                      des.latitude AS des_latitude, 
                      des.city AS des_city, 
                      des.state AS des_state
                  FROM master_lanes ml
                  LEFT JOIN master_locations src ON ml.src_loc_id = src.location_id
                  LEFT JOIN master_locations des ON ml.des_loc_id = des.location_id
                  WHERE ml.lane_ID IN (?)
                  `,
                [carrierLanes]
            )
            : [[], []];

        res.status(200).json({
            message: 'Carrier retrieved successfully',
            carrier: {
                ...carrier,
                carrier_loc_of_operation: locations,
                carrier_lanes: lanes,
            },
        });
    } catch (error) {
        logger.error('Error retrieving carrier by ID:', error);
        res.status(500).json({ message: 'An error occurred while retrieving the carrier.', error: error.message });
    }
});


router.put('/edit-carrier', jwtAuth.verifyToken, async (req, res) => {
    const { cr_id } = req.query;
    const { carrier_name, carrier_address, carrier_correspondence, carrier_network_portal, vehicle_types_handling, carrier_loc_of_operation, carrier_lanes, contract, contract_valid_upto, pricing } = req.body;

    if (!cr_id) {
        return res.status(400).json({ message: 'Please provide cr_id in query parameters.' });
    }

    try {
        const updateQuery = `
            UPDATE carriers 
            SET 
                carrier_name = ?, 
                carrier_address = ?, 
                carrier_correspondence = ?, 
                carrier_network_portal = ?, 
                vehicle_types_handling = ?, 
                carrier_loc_of_operation = ?, 
                carrier_lanes = ?,
                contract = ?,
                contract_valid_upto = ?,
                pricing = ?
            WHERE cr_id = ?
        `;

        const [result] = await db.query(updateQuery, [
            carrier_name || null,
            carrier_address || null,
            carrier_correspondence ? JSON.stringify(carrier_correspondence) : '{}',
            carrier_network_portal || null,
            vehicle_types_handling ? JSON.stringify(vehicle_types_handling) : '[]',
            carrier_loc_of_operation ? JSON.stringify(carrier_loc_of_operation) : '[]',
            carrier_lanes ? JSON.stringify(carrier_lanes) : '[]',
            contract || null,
            contract_valid_upto || null,
            pricing ? JSON.stringify(pricing) : '[]',
            cr_id,
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Carrier not found or no changes made.' });
        }

        const [updatedRecord] = await db.query(
            `SELECT * FROM carriers WHERE cr_id  = ?`,
            [cr_id]
        );

        res.status(200).json({
            message: 'Carrier updated successfully.',
            updated_record: updatedRecord[0]?.carrier_ID
        });
    } catch (error) {
        logger.error('Error updating carrier:', error);
        res.status(500).json({ message: 'An error occurred while updating the carrier.', error: error.message });
    }
});


router.delete('/delete-carrier', jwtAuth.verifyToken, async (req, res) => {
    const { cr_id } = req.query;


    if (!cr_id) {
        return res.status(400).json({ message: 'Please provide cr_id in query parameters.' });
    }

    try {

        const [existingCarrier] = await db.query(`SELECT * FROM carriers WHERE cr_id = ?`, [cr_id]);

        if (existingCarrier.length === 0) {
            return res.status(404).json({ message: 'Carrier not found.' });
        }
        const deleteQuery = `DELETE FROM carriers WHERE cr_id = ?`;
        const [result] = await db.query(deleteQuery, [cr_id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Failed to delete carrier, no changes made.' });
        }

        res.status(200).json({
            message: 'Carrier deleted successfully.',
            deleted_record: existingCarrier[0].carrier_ID
        });
    } catch (error) {
        logger.error('Error deleting carrier:', error);
        res.status(500).json({ message: 'An error occurred while deleting the carrier.', error: error.message });
    }
});




module.exports = router;