const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

router.post('/add-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const vehicles = req.body.vehicles;

    if (!vehicles || vehicles.length === 0) {
        return res.status(400).json({ message: 'Please provide vehicle data.' });
    }

    try {
        const vehicleData = Array.isArray(vehicles) ? vehicles : [vehicles];
        const [lastVehicle] = await db.query(`
            SELECT vehicle_ID FROM master_resources ORDER BY veh_id DESC LIMIT 1 FOR UPDATE
        `);

        let lastVehicleNumber = 0;
        if (lastVehicle.length > 0 && lastVehicle[0].vehicle_ID) {
            lastVehicleNumber = parseInt(lastVehicle[0].vehicle_ID.replace('RES', '')) || 0;
        }

        const newVehicles = vehicleData.map((vehicle, index) => {
            const vehicle_ID = `RES${String(lastVehicleNumber + index + 1).padStart(6, '0')}`;
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
                fragile_vehicle,
                danger_proof,
                hazardous_proof,
                temp_controlled_vehicle
            } = vehicle;

            return db.query(
                `
                INSERT INTO master_resources (
                    vehicle_ID, 
                    loc_ID, 
                    unlimited_usage, 
                    individual_resource, 
                    transportation_details, 
                    capacity, 
                    physical_properties, 
                    downtimes, 
                    vehicle_group,
                    additional_details,
                    fragile_vehicle,
                    danger_proof,
                    hazardous_proof,
                    temp_controlled_vehicle
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    vehicle.vehicle_ID,
                    JSON.stringify(loc_ID || {}),
                    unlimited_usage || null,
                    individual_resource || null,
                    JSON.stringify(transportation_details || {}),
                    JSON.stringify(capacity || {}),
                    JSON.stringify(physical_properties || {}),
                    JSON.stringify(downtimes || {}),
                    JSON.stringify(vehicle_group || {}),
                    JSON.stringify(additional_details || {}),
                    fragile_vehicle,
                    danger_proof,
                    hazardous_proof,
                    temp_controlled_vehicle
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Resources added successfully',
            created_records: newVehicles.map(record => record.vehicle_ID),
            vehicles: newVehicles,
        });
    } catch (error) {
        logger.error('Error adding resources:', error);
        res.status(500).json({ message: 'An error occurred while adding resources.', error: error.message });
    }
});

router.get('/vehicles', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
        const query = `SELECT * FROM master_resources`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [vehicles] = await db.query(paginatedQuery);

        res.status(200).json({
            message: 'Resources fetched successfully',
            vehicles,
        });
    } catch (error) {
        logger.error('Error fetching resources:', error);
        res.status(500).json({ message: 'An error occurred while fetching resources.', error: error.message });
    }
});

router.get('/vehicle', jwtAuth.verifyToken, async (req, res) => {
    const { vehicle_ID } = req.query;

    if (!vehicle_ID) {
        return res.status(400).json({ message: 'vehicle_ID is required in the query.' });
    }

    try {
        const [vehicle] = await db.query(
            `SELECT * FROM master_resources WHERE vehicle_ID = ?`,
            [vehicle_ID]
        );

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
    try {
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
            fragile_vehicle,
            danger_proof,
            hazardous_proof,
            temp_controlled_vehicle
        } = req.body;

        if (!veh_id) {
            return res.status(400).json({ message: 'Missing required query parameter: veh_id' });
        }

        const [[exists]] = await db.query(`SELECT 1 FROM master_resources WHERE veh_id = ?`, [veh_id]);
        if (!exists) {
            return res.status(404).json({ message: 'Vehicle not found.' });
        }

        const updateFields = [];
        const values = [];

        if (loc_ID !== undefined) {
            updateFields.push('loc_ID = ?');
            values.push(JSON.stringify(loc_ID));
        }
        if (unlimited_usage !== undefined) {
            updateFields.push('unlimited_usage = ?');
            values.push(unlimited_usage);
        }
        if (individual_resource !== undefined) {
            updateFields.push('individual_resource = ?');
            values.push(individual_resource);
        }
        if (transportation_details !== undefined) {
            updateFields.push('transportation_details = ?');
            values.push(JSON.stringify(transportation_details));
        }
        if (capacity !== undefined) {
            updateFields.push('capacity = ?');
            values.push(JSON.stringify(capacity));
        }
        if (physical_properties !== undefined) {
            updateFields.push('physical_properties = ?');
            values.push(JSON.stringify(physical_properties));
        }
        if (downtimes !== undefined) {
            updateFields.push('downtimes = ?');
            values.push(JSON.stringify(downtimes));
        }
        if (vehicle_group !== undefined) {
            updateFields.push('vehicle_group = ?');
            values.push(JSON.stringify(vehicle_group));
        }
        if (additional_details !== undefined) {
            updateFields.push('additional_details = ?');
            values.push(JSON.stringify(additional_details));
        }
        if (fragile_vehicle !== undefined) {
            updateFields.push('fragile_vehicle = ?');
            values.push(fragile_vehicle);
        }
        if (danger_proof !== undefined) {
            updateFields.push('danger_proof = ?');
            values.push(danger_proof);
        }
        if (hazardous_proof !== undefined) {
            updateFields.push('hazardous_proof = ?');
            values.push(hazardous_proof);
        }
        if (temp_controlled_vehicle !== undefined) {
            updateFields.push('temp_controlled_vehicle = ?');
            values.push(temp_controlled_vehicle);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided to update.' });
        }

        values.push(veh_id);
        const sql = `UPDATE master_resources SET ${updateFields.join(', ')} WHERE veh_id = ?`;
        await db.query(sql, values);

        const [[{ vehicle_ID }]] = await db.query(
            `SELECT vehicle_ID FROM master_resources WHERE veh_id = ?`,
            [veh_id]
        );

        return res.status(200).json({
            message: 'Vehicle updated successfully.',
            veh_id,
            vehicle_ID
        });
    } catch (error) {
        logger.error('Error updating vehicle:', error);
        return res.status(500).json({
            message: 'Server error while updating vehicle.',
            error: error.message
        });
    }
});

router.delete('/delete-vehicle', jwtAuth.verifyToken, async (req, res) => {
    const { veh_id } = req.query;
    if (!veh_id) {
        return res.status(400).json({ message: 'Missing required query parameter: veh_id' });
    }

    try {
        const [masterRows] = await db.query(
            `SELECT vehicle_ID FROM master_resources WHERE veh_id = ?`,
            [veh_id]
        );
        if (!masterRows.length) {
            return res.status(404).json({ message: 'Vehicle not found.' });
        }
        const vehicleID = masterRows[0].vehicle_ID;

        const [selfRows] = await db.query(
            `SELECT 1 FROM self_vehicles WHERE vehicle_ID = ? LIMIT 1`,
            [vehicleID]
        );
        if (selfRows.length) {
            return res.status(400).json({
                message: `Cannot delete vehicle ${vehicleID} because it exists in self_vehicles.`
            });
        }

        await db.query(`DELETE FROM master_resources WHERE veh_id = ?`, [veh_id]);

        return res.status(200).json({
            message: 'Vehicle deleted successfully.',
            deleted_record: vehicleID
        });
    } catch (error) {
        logger.error('Error deleting vehicle:', error);
        return res.status(500).json({
            message: 'Server error while deleting vehicle.',
            error: error.message
        });
    }
});

module.exports = router;
