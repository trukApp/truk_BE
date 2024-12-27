const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const logger = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


// POST API to create one or multiple locations
router.post('/create-location', async (req, res) => {
    try {
        const locations = req.body.locations; // Expecting an array of locations

        if (!Array.isArray(locations) || locations.length === 0) {
            return res.status(400).json({ message: 'Invalid input. Provide at least one location.' });
        }

        const insertValues = [];
        const [result] = await db.query(
            "SELECT loc_ID FROM dummy_master_locations ORDER BY location_id DESC LIMIT 1"
        );
        let lastLocID = result[0]?.loc_ID || 'LOC0000';

        locations.forEach(location => {
            const {
                loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type, gln_code, iata_code
            } = location;

            if (!loc_desc || !longitude || !latitude || !city || !state || !country || !pincode || !loc_type) {
                throw new Error('Missing required fields in one of the locations.');
            }

            lastLocID = `LOC${String(parseInt(lastLocID.slice(3)) + 1).padStart(4, '0')}`;
            insertValues.push([
                lastLocID, loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type, gln_code, iata_code
            ]);
        });

        // Insert all locations into the database
        await db.query(
            "INSERT INTO dummy_master_locations (loc_ID, loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type, gln_code, iata_code) VALUES ?",
            [insertValues]
        );

        res.status(201).json({ message: 'Locations created successfully.', count: insertValues.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message || 'Server error.' });
    }
});

// GET API to fetch all locations
router.get('/all-locations', async (req, res) => {
    try {
        const [locations] = await db.query("SELECT * FROM dummy_master_locations");
        res.status(200).json({ locations });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT API to edit a location
router.put('/edit-location', async (req, res) => {
    try {
        const { id } = req.query;
        const {
            loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type, gln_code, iata_code
        } = req.body;

        const [updateResult] = await db.query(
            "UPDATE dummy_master_locations SET loc_desc = ?, longitude = ?, latitude = ?, time_zone = ?, city = ?, state = ?, country = ?, pincode = ?, loc_type = ?, gln_code = ?, iata_code = ? WHERE location_id = ?",
            [loc_desc, longitude, latitude, time_zone, city, state, country, pincode, loc_type, gln_code, iata_code, id]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }

        res.status(200).json({ message: 'Location updated successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE API to remove a location
router.delete('/delete-location', async (req, res) => {
    try {
        const { id } = req.query;

        const [deleteResult] = await db.query(
            "DELETE FROM dummy_master_locations WHERE location_id = ?",
            [id]
        );

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }

        res.status(200).json({ message: 'Location deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});





module.exports=router;