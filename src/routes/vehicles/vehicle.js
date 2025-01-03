const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');

router.post('/add-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const vehicles = req.body.vehicles; 

    if (!vehicles || vehicles.length === 0) {
        return res.status(400).json({ message: 'Please provide vehicle data.' });
    }

    try {
        const vehicleData = Array.isArray(vehicles) ? vehicles : [vehicles];

        const [lastVehicle] = await db.query(`
            SELECT vehicle_ID FROM master_vehicles ORDER BY veh_id DESC LIMIT 1
        `);

        let lastVehicleNumber = 0;
        if (lastVehicle.length > 0 && lastVehicle[0].vehicle_ID) {
            lastVehicleNumber = parseInt(lastVehicle[0].vehicle_ID.replace('VEH', '')) || 0;
        }

        const newVehicles = vehicleData.map((vehicle, index) => {
            const vehicle_ID = `VEH${String(lastVehicleNumber + index + 1).padStart(6, '0')}`;
            return {
                ...vehicle,
                vehicle_ID,
            };
        });

        const insertPromises = newVehicles.map(async (vehicle) => {
            const {
                location_id,
                unlimited_usage,
                individual_resource,
                transportation_details,
                capacity,
                physical_properties,
                downtimes,
                additional_details,
            } = vehicle;

            return db.query(
                `
                INSERT INTO master_vehicles (
                    vehicle_ID, 
                    location_id, 
                    unlimited_usage, 
                    individual_resource, 
                    transportation_details, 
                    capacity, 
                    physical_properties, 
                    downtimes, 
                    additional_details
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    vehicle.vehicle_ID,
                    location_id,
                    unlimited_usage,
                    individual_resource,
                    JSON.stringify(transportation_details || {}),
                    JSON.stringify(capacity || {}),
                    JSON.stringify(physical_properties || {}),
                    JSON.stringify(downtimes || {}),
                    JSON.stringify(additional_details || {}),
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Vehicles added successfully',
            vehicles: newVehicles,
        });
    } catch (error) {
        logger.error('Error adding vehicles:', error);
        res.status(500).json({ message: 'An error occurred while adding vehicles.', error: error.message });
    }
});


router.get('/vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [vehicles] = await db.query(`
            SELECT 
                v.*, 
                l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
                l.city, l.state, l.country, l.pincode, l.loc_type, 
                l.gln_code, l.iata_code
            FROM master_vehicles v
            LEFT JOIN master_locations l ON v.location_id = l.location_id
        `);

        res.status(200).json({
            message: 'Vehicles fetched successfully',
            vehicles,
        });
    } catch (error) {
        logger.error('Error fetching vehicles:', error);
        res.status(500).json({ message: 'An error occurred while fetching vehicles.', error: error.message });
    }
});



router.get('/vehicle', jwtAuth.verifyToken, async (req, res) => {
    const { vehicle_ID } = req.query;

    if (!vehicle_ID) {
        return res.status(400).json({ message: 'vehicle_ID is required in the query.' });
    }

    try {
        const [vehicle] = await db.query(`
            SELECT 
                v.*, 
                l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
                l.city, l.state, l.country, l.pincode, l.loc_type, 
                l.gln_code, l.iata_code
            FROM master_vehicles v
            LEFT JOIN master_locations l ON v.location_id = l.location_id
            WHERE v.vehicle_ID = ?
        `, [vehicle_ID]);

        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found.' });
        }

        res.status(200).json({
            message: 'Vehicle fetched successfully',
            vehicle,
        });
    } catch (error) {
        logger.error('Error fetching vehicle:', error);
        res.status(500).json({ message: 'An error occurred while fetching the vehicle.', error: error.message });
    }
});


router.put('/edit-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const { veh_id } = req.query;
    const {
        location_id,
        unlimited_usage,
        individual_resource,
        transportation_details,
        capacity,
        physical_properties,
        downtimes,
        additional_details,
    } = req.body;

    if (!veh_id) {
        return res.status(400).json({ message: 'veh_id is required in the query.' });
    }

    try {
        const updateResult = await db.query(`
            UPDATE master_vehicles 
            SET 
                location_id = ?, 
                unlimited_usage = ?, 
                individual_resource = ?, 
                transportation_details = ?, 
                capacity = ?, 
                physical_properties = ?, 
                downtimes = ?, 
                additional_details = ?
            WHERE veh_id = ?
        `, [
            location_id,
            unlimited_usage,
            individual_resource,
            JSON.stringify(transportation_details || {}),
            JSON.stringify(capacity || {}),
            JSON.stringify(physical_properties || {}),
            JSON.stringify(downtimes || {}),
            JSON.stringify(additional_details || {}),
            veh_id,
        ]);

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Vehicle not found or no changes made.' });
        }

        res.status(200).json({ message: 'Vehicle updated successfully' });
    } catch (error) {
        logger.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'An error occurred while updating the vehicle.', error: error.message });
    }
});


router.delete('/delete-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const { veh_id } = req.query;

    if (!veh_id) {
        return res.status(400).json({ message: 'veh_id is required in the query.' });
    }

    try {
        const deleteResult = await db.query(`
            DELETE FROM master_vehicles WHERE veh_id = ?
        `, [veh_id]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Vehicle not found.' });
        }

        res.status(200).json({ message: 'Vehicle deleted successfully' });
    } catch (error) {
        logger.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'An error occurred while deleting the vehicle.', error: error.message });
    }
});


module.exports = router;