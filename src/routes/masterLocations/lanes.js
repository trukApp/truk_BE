const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/create-lanes', jwtAuth.verifyToken, async (req, res) => {
    const lanes = req.body.lanes;

    if (!lanes || lanes.length === 0) {
        return res.status(400).json({ message: 'Please provide lane data.' });
    }

    try {
        const laneData = Array.isArray(lanes) ? lanes : [lanes];

        // Fetch the last `lane_ID` from the database
        const [lastLane] = await db.query(`
            SELECT lane_ID FROM master_lanes ORDER BY ln_id DESC LIMIT 1 FOR UPDATE
        `);

        let lastLaneNumber = 0;
        if (lastLane.length > 0 && lastLane[0].lane_ID) {
            lastLaneNumber = parseInt(lastLane[0].lane_ID.replace('LN', '')) || 0;
        }

        const newLanes = laneData.map((lane, index) => {
            const lane_ID = `LN${String(lastLaneNumber + index + 1).padStart(6, '0')}`;
            return {
                ...lane,
                lane_ID,
            };
        });

        // Insert all lanes into the database
        const insertPromises = newLanes.map(async (lane) => {
            const { src_loc_ID, des_loc_ID, lane_transport_data } = lane;

            return db.query(
                `
                INSERT INTO master_lanes (
                    lane_ID, 
                    src_loc_ID, 
                    des_loc_ID, 
                    lane_transport_data
                ) VALUES (?, ?, ?, ?)
                `,
                [
                    lane.lane_ID,
                    src_loc_ID,
                    des_loc_ID,
                    JSON.stringify(lane_transport_data || {}),
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Lanes created successfully',
            lanes: newLanes,
        });
    } catch (error) {
        logger.error('Error creating lanes:', error);
        res.status(500).json({ message: 'An error occurred while creating lanes.', error: error.message });
    }
});


router.get('/all-lanes', jwtAuth.verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                ml.ln_id, 
                ml.lane_ID, 
                ml.lane_transport_data,
                ml.src_loc_ID, 
                src.loc_ID AS src_loc_ID, 
                src.loc_desc AS src_loc_desc, 
                src.longitude AS src_longitude, 
                src.latitude AS src_latitude, 
                src.city AS src_city, 
                src.state AS src_state,
                ml.des_loc_ID, 
                des.loc_ID AS des_loc_ID, 
                des.loc_desc AS des_loc_desc, 
                des.longitude AS des_longitude, 
                des.latitude AS des_latitude, 
                des.city AS des_city, 
                des.state AS des_state
            FROM master_lanes ml
            LEFT JOIN master_locations src ON ml.src_loc_ID = src.loc_ID
            LEFT JOIN master_locations des ON ml.des_loc_ID = des.loc_ID
        `;

        const [lanes] = await db.query(query);

        res.status(200).json({
            message: 'Lanes retrieved successfully',
            lanes,
        });
    } catch (error) {
        logger.error('Error retrieving lanes:', error);
        res.status(500).json({ message: 'An error occurred while retrieving lanes.', error: error.message });
    }
});


router.get('/lane-by-id', jwtAuth.verifyToken, async (req, res) => {
    const { lane_ID } = req.query;

    if (!lane_ID) {
        return res.status(400).json({ message: 'Please provide lane_ID in query parameters.' });
    }

    try {
        const query = `
            SELECT 
                ml.ln_id, 
                ml.lane_ID, 
                ml.lane_transport_data, 
                ml.src_loc_ID, 
                src.loc_ID AS src_loc_ID, 
                src.loc_desc AS src_loc_desc, 
                src.longitude AS src_longitude, 
                src.latitude AS src_latitude, 
                src.time_zone AS src_time_zone, 
                src.city AS src_city, 
                src.state AS src_state, 
                src.country AS src_country, 
                src.pincode AS src_pincode, 
                src.loc_type AS src_loc_type, 
                src.gln_code AS src_gln_code, 
                src.iata_code AS src_iata_code, 
                ml.des_loc_ID,  
                des.loc_ID AS des_loc_ID, 
                des.loc_desc AS des_loc_desc, 
                des.longitude AS des_longitude, 
                des.latitude AS des_latitude, 
                des.time_zone AS des_time_zone, 
                des.city AS des_city, 
                des.state AS des_state, 
                des.country AS des_country, 
                des.pincode AS des_pincode, 
                des.loc_type AS des_loc_type, 
                des.gln_code AS des_gln_code, 
                des.iata_code AS des_iata_code
            FROM master_lanes ml
            LEFT JOIN master_locations src ON ml.src_loc_ID = src.loc_ID
            LEFT JOIN master_locations des ON ml.des_loc_ID = des.loc_ID
            WHERE ml.lane_ID = ?
        `;

        const [lane] = await db.query(query, [lane_ID]);

        if (lane.length === 0) {
            return res.status(404).json({ message: 'Lane not found.' });
        }

        res.status(200).json({
            message: 'Lane retrieved successfully',
            lane: lane[0],
        });
    } catch (error) {
        logger.error('Error retrieving lane:', error);
        res.status(500).json({ message: 'An error occurred while retrieving the lane.', error: error.message });
    }
});


router.put('/edit-lane', jwtAuth.verifyToken, async (req, res) => {
    const { ln_id } = req.query;
    const { src_loc_ID, des_loc_ID, lane_transport_data } = req.body;

    if (!ln_id) {
        return res.status(400).json({ message: 'Please provide ln_id in query parameters.' });
    }

    try {
        const updateQuery = `
            UPDATE master_lanes 
            SET 
                src_loc_ID = COALESCE(?, src_loc_ID), 
                des_loc_ID = COALESCE(?, des_loc_ID), 
                lane_transport_data = COALESCE(?, lane_transport_data)
            WHERE ln_id = ?
        `;

        const [result] = await db.query(updateQuery, [
            src_loc_ID || null,
            des_loc_ID || null,
            JSON.stringify(lane_transport_data || {}),
            ln_id,
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Lane not found or no changes made.' });
        }

        res.status(200).json({ message: 'Lane updated successfully.' });
    } catch (error) {
        logger.error('Error updating lane:', error);
        res.status(500).json({ message: 'An error occurred while updating the lane.', error: error.message });
    }
});



router.delete('/delete-lane', jwtAuth.verifyToken, async (req, res) => {
    const { ln_id } = req.query;

    if (!ln_id) {
        return res.status(400).json({ message: 'Please provide ln_id in query parameters.' });
    }

    try {
        const deleteQuery = `
            DELETE FROM master_lanes WHERE ln_id = ?
        `;

        const [result] = await db.query(deleteQuery, [ln_id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Lane not found or already deleted.' });
        }

        res.status(200).json({ message: 'Lane deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting lane:', error);
        res.status(500).json({ message: 'An error occurred while deleting the lane.', error: error.message });
    }
});


module.exports = router;