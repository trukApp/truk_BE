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

            const phone = carrier_correspondence?.phone || null;

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
                    pricing,
                    carrier_password
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    JSON.stringify(pricing || {}),
                    phone
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



router.put('/update-carrier-password', jwtAuth.verifyToken, async (req, res) => {
    const { carrier_ID } = req.query;
    const { existing_carrier_password, new_carrier_password } = req.body;

    if (!carrier_ID || !existing_carrier_password || !new_carrier_password) {
        return res.status(400).json({ message: 'carrier_ID, existing_carrier_password, and new_carrier_password are required.' });
    }

    if (existing_carrier_password === new_carrier_password) {
        return res.status(400).json({ message: 'New password should not be the same as the existing password.' });
    }

    try {
        const [carrierRows] = await db.query(
            `SELECT carrier_password FROM carriers WHERE carrier_ID = ?`,
            [carrier_ID]
        );

        if (carrierRows.length === 0) {
            return res.status(404).json({ message: 'Carrier not found.' });
        }

        const currentPassword = carrierRows[0].carrier_password;

        if (currentPassword !== existing_carrier_password) {
            return res.status(401).json({ message: 'Existing password is incorrect.' });
        }

        await db.query(
            `UPDATE carriers SET carrier_password = ? WHERE carrier_ID = ?`,
            [new_carrier_password, carrier_ID]
        );

        res.status(200).json({ message: 'Carrier password updated successfully.' });
    } catch (error) {
        logger.error("Error updating carrier password:", error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});



router.post('/carrier-login', async (req, res) => {
    const { carrier_ID, carrier_password } = req.body;

    if (!carrier_ID || !carrier_password) {
        return res.status(400).json({ message: 'carrier_ID and carrier_password are required.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT * FROM carriers WHERE carrier_ID = ?`,
            [carrier_ID]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Carrier not found.' });
        }

        const carrier = rows[0];

        if (carrier.carrier_password !== carrier_password) {
            return res.status(401).json({ message: 'Invalid carrier password.' });
        }

        const accessToken = jwtAuth.generateToken(carrier_ID, "carrier");
        const refreshToken = jwtAuth.generateRefreshToken(carrier_ID, "carrier");

        res.status(200).json({
            message: 'Carrier login successful.',
            accessToken,
            refreshToken,
            carrier_ID
        });

    } catch (error) {
        console.error('Error in carrier login:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
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


// ✅ API 1: Edit carrier details (excluding carrier_password)
router.put('/edit-carrier', jwtAuth.verifyToken, async (req, res) => {
    const { cr_id } = req.query;
    const {
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
    } = req.body;

    if (!cr_id) {
        return res.status(400).json({ message: 'Please provide cr_id in query parameters.' });
    }

    try {
        const updateFields = [];
        const values = [];

        if (carrier_name) {
            updateFields.push('carrier_name = ?');
            values.push(carrier_name);
        }
        if (carrier_address) {
            updateFields.push('carrier_address = ?');
            values.push(carrier_address);
        }
        if (carrier_correspondence) {
            updateFields.push('carrier_correspondence = ?');
            values.push(JSON.stringify(carrier_correspondence));
        }
        if (carrier_network_portal !== undefined) {
            updateFields.push('carrier_network_portal = ?');
            values.push(carrier_network_portal);
        }
        if (vehicle_types_handling) {
            updateFields.push('vehicle_types_handling = ?');
            values.push(JSON.stringify(vehicle_types_handling));
        }
        if (carrier_loc_of_operation) {
            updateFields.push('carrier_loc_of_operation = ?');
            values.push(JSON.stringify(carrier_loc_of_operation));
        }
        if (carrier_lanes) {
            updateFields.push('carrier_lanes = ?');
            values.push(JSON.stringify(carrier_lanes));
        }
        if (contract !== undefined) {
            updateFields.push('contract = ?');
            values.push(contract);
        }
        if (contract_valid_upto) {
            updateFields.push('contract_valid_upto = ?');
            values.push(contract_valid_upto);
        }
        if (pricing) {
            updateFields.push('pricing = ?');
            values.push(JSON.stringify(pricing));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(cr_id);
        const query = `UPDATE carriers SET ${updateFields.join(', ')} WHERE cr_id = ?`;
        await db.query(query, values);

        res.status(200).json({ message: 'Carrier details updated successfully.' });
    } catch (error) {
        logger.error('Error updating carrier:', error);
        res.status(500).json({ message: 'An error occurred while updating the carrier.', error: error.message });
    }
});


router.put('/update-carrier-contract', jwtAuth.verifyToken, async (req, res) => {
    const { carrier_ID } = req.query;
    const { existing_carrier_password, new_carrier_password, contract, contract_valid_upto } = req.body;

    if (!carrier_ID || !existing_carrier_password || !new_carrier_password) {
        return res.status(400).json({ message: 'carrier_ID, existing_carrier_password, and new_carrier_password are required.' });
    }

    if (existing_carrier_password === new_carrier_password) {
        return res.status(400).json({ message: 'New password should not be same as existing password.' });
    }

    try {
        const [rows] = await db.query(`SELECT carrier_password FROM carriers WHERE carrier_ID = ?`, [carrier_ID]);

        if (!rows.length) {
            return res.status(404).json({ message: 'Carrier not found.' });
        }

        if (rows[0].carrier_password !== existing_carrier_password) {
            return res.status(401).json({ message: 'Existing password does not match.' });
        }

        const updateFields = ['carrier_password = ?'];
        const values = [new_carrier_password];

        if (contract !== undefined) {
            updateFields.push('contract = ?');
            values.push(contract);
        }

        if (contract_valid_upto) {
            updateFields.push('contract_valid_upto = ?');
            values.push(contract_valid_upto);
        }

        values.push(carrier_ID);
        const updateQuery = `UPDATE carriers SET ${updateFields.join(', ')} WHERE carrier_ID = ?`;

        await db.query(updateQuery, values);
        res.status(200).json({ message: 'Carrier password and contract fields updated successfully.' });

    } catch (error) {
        logger.error('Error updating carrier password/contract:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
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