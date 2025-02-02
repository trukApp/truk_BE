const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const {applyPagination} = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

router.post('/add-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const vehicles = req.body.vehicles;

    if (!vehicles || vehicles.length === 0) {
        return res.status(400).json({ message: 'Please provide vehicle data.' });
    }

    try {
        const vehicleData = Array.isArray(vehicles) ? vehicles : [vehicles];
        const [lastVehicle] = await db.query(`
            SELECT vehicle_ID FROM master_vehicles ORDER BY veh_id DESC LIMIT 1 FOR UPDATE
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
                loc_ID,
                unlimited_usage,
                individual_resource,
                transportation_details,
                capacity,
                physical_properties,
                downtimes,
                vehicle_group,
                additional_details,
            } = vehicle;

            return db.query(
                `
                INSERT INTO master_vehicles (
                    vehicle_ID, 
                    loc_ID, 
                    unlimited_usage, 
                    individual_resource, 
                    transportation_details, 
                    capacity, 
                    physical_properties, 
                    downtimes, 
                    vehicle_group,
                    additional_details
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    vehicle.vehicle_ID,
                    loc_ID || null,
                    unlimited_usage || null,
                    individual_resource || null,
                    JSON.stringify(transportation_details || {}),
                    JSON.stringify(capacity || {}),
                    JSON.stringify(physical_properties || {}),
                    JSON.stringify(downtimes || {}),
                    JSON.stringify(vehicle_group || {}),
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


// router.get('/vehicles', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const [vehicles] = await db.query(`
//             SELECT 
//                 v.*, 
//                 l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
//                 l.city, l.state, l.country, l.pincode, l.loc_type, 
//                 l.gln_code, l.iata_code
//             FROM master_vehicles v
//             LEFT JOIN master_locations l ON v.loc_ID = l.loc_ID
//         `);

//         res.status(200).json({
//             message: 'Vehicles fetched successfully',
//             vehicles,
//         });
//     } catch (error) {
//         logger.error('Error fetching vehicles:', error);
//         res.status(500).json({ message: 'An error occurred while fetching vehicles.', error: error.message });
//     }
// });


router.get('/vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const query = `
            SELECT 
                v.*, 
                l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
                l.city, l.state, l.country, l.pincode, l.loc_type, 
                l.gln_code, l.iata_code
            FROM master_vehicles v
            LEFT JOIN master_locations l ON v.loc_ID = l.loc_ID
        `;
        const paginatedQuery = applyPagination(query, page, limit);
        const [vehicles] = await db.query(paginatedQuery);

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
            LEFT JOIN master_locations l ON v.loc_ID = l.loc_ID
            WHERE v.vehicle_ID = ?
        `, [vehicle_ID]);

        if (vehicle.length === 0) {
            return res.status(404).json({ message: 'Vehicle not found.' });
        }

        res.status(200).json({
            message: 'Vehicle fetched successfully',
            vehicle: vehicle[0],
        });
    } catch (error) {
        logger.error('Error fetching vehicle:', error);
        res.status(500).json({ message: 'An error occurred while fetching the vehicle.', error: error.message });
    }
});


router.put('/edit-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const { veh_id } = req.query;
    const {
        loc_ID,
        unlimited_usage,
        individual_resource,
        transportation_details,
        capacity,
        physical_properties,
        downtimes,
        vehicle_group,
        additional_details,
    } = req.body;

    if (!veh_id) {
        return res.status(400).json({ message: 'veh_id is required in the query.' });
    }

    try {
        const updateResult = await db.query(`
            UPDATE master_vehicles 
            SET 
                loc_ID = COALESCE(?, loc_ID), 
                unlimited_usage = COALESCE(?, unlimited_usage), 
                individual_resource = COALESCE(?, individual_resource), 
                transportation_details = COALESCE(?, transportation_details), 
                capacity = COALESCE(?, capacity), 
                physical_properties = COALESCE(?, physical_properties), 
                downtimes = COALESCE(?, downtimes), 
                vehicle_group = COALESCE(?, vehicle_group),
                additional_details = COALESCE(?, additional_details)
            WHERE veh_id = ?
        `, [
            loc_ID || null,
            unlimited_usage || null,
            individual_resource || null,
            JSON.stringify(transportation_details || {}),
            JSON.stringify(capacity || {}),
            JSON.stringify(physical_properties || {}),
            JSON.stringify(downtimes || {}),
            JSON.stringify(vehicle_group || {}),
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