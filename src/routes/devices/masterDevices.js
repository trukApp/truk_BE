const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/add-devices', jwtAuth.verifyToken, async (req, res) => {
    const devices = req.body.devices;

    if (!devices || devices.length === 0) {
        return res.status(400).json({ message: 'Please provide device data.' });
    }

    try {
        const deviceData = Array.isArray(devices) ? devices : [devices];

        const [lastDevice] = await db.query(`
            SELECT dev_ID FROM master_devices ORDER BY device_id DESC LIMIT 1
        `);

        let lastDeviceNumber = 0;
        if (lastDevice.length > 0 && lastDevice[0].dev_ID) {
            lastDeviceNumber = parseInt(lastDevice[0].dev_ID.replace('DEV', '')) || 0;
        }

        const newDevices = deviceData.map((device, index) => {
            const dev_ID = `DEV${String(lastDeviceNumber + index + 1).padStart(6, '0')}`;
            return {
                ...device,
                dev_ID,
            };
        });

        const insertPromises = newDevices.map(async (device) => {
            const {
                dev_ID,
                device_type,
                device_UID,
                sim_imei_num,
                vehicle_number,
                carrier_id,
                location_id,
            } = device;

            return db.query(
                `
                INSERT INTO master_devices (
                    dev_ID,
                    device_type,
                    device_UID,
                    sim_imei_num,
                    vehicle_number,
                    carrier_id,
                    location_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    dev_ID,
                    device_type || null,
                    device_UID || null,
                    sim_imei_num || null,
                    vehicle_number || null,
                    carrier_id || null,
                    location_id || null,
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Devices added successfully',
            devices: newDevices,
        });
    } catch (error) {
        logger.error('Error adding devices:', error);
        res.status(500).json({ message: 'An error occurred while adding devices.', error: error.message });
    }
});


router.get('/all-devices', jwtAuth.verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                d.device_id, d.dev_ID, d.device_type, d.device_UID, d.sim_imei_num, 
                d.vehicle_number, d.carrier_id, d.location_id,
                c.cr_id, c.carrier_ID,
                l.location_id, l.loc_ID
            FROM master_devices d
            LEFT JOIN carriers c ON d.carrier_id = c.cr_id
            LEFT JOIN master_locations l ON d.location_id = l.location_id
        `;

        const [devices] = await db.query(query);

        res.status(200).json({
            message: 'Devices retrieved successfully',
            devices,
        });
    } catch (error) {
        logger.error('Error fetching devices:', error);
        res.status(500).json({ message: 'An error occurred while fetching devices.', error: error.message });
    }
});



router.get('/device', jwtAuth.verifyToken, async (req, res) => {
    const { dev_ID } = req.query;

    if (!dev_ID) {
        return res.status(400).json({ message: 'Please provide dev_ID in query parameters.' });
    }

    try {
        const query = `
            SELECT 
                d.device_id, d.dev_ID, d.device_type, d.device_UID, d.sim_imei_num, 
                d.vehicle_number, d.carrier_id, d.location_id,
                c.cr_id, c.carrier_ID, c.carrier_name, c.carrier_address, 
                c.carrier_correspondence, c.carrier_network_portal, c.vehicle_types_handling, 
                c.carrier_loc_of_operation, c.carrier_lanes,
                l.location_id, l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
                l.city, l.state, l.country, l.pincode, l.loc_type, l.gln_code, l.iata_code
            FROM master_devices d
            LEFT JOIN carriers c ON d.carrier_id = c.cr_id
            LEFT JOIN master_locations l ON d.location_id = l.location_id
            WHERE d.dev_ID = ?
        `;

        const [device] = await db.query(query, [dev_ID]);

        if (device.length === 0) {
            return res.status(404).json({ message: 'Device not found.' });
        }

        res.status(200).json({
            message: 'Device retrieved successfully',
            device: device[0],
        });
    } catch (error) {
        logger.error('Error fetching device:', error);
        res.status(500).json({ message: 'An error occurred while fetching the device.', error: error.message });
    }
});


router.put('/edit-device', jwtAuth.verifyToken, async (req, res) => {
    const { device_id } = req.query;
    const {
        dev_ID,
        device_type,
        device_UID,
        sim_imei_num,
        vehicle_number,
        carrier_id,
        location_id,
    } = req.body;

    if (!device_id) {
        return res.status(400).json({ message: 'Please provide device_id in query parameters.' });
    }

    try {
        const updateQuery = `
            UPDATE master_devices
            SET 
                dev_ID = COALESCE(?, dev_ID),
                device_type = COALESCE(?, device_type),
                device_UID = COALESCE(?, device_UID),
                sim_imei_num = COALESCE(?, sim_imei_num),
                vehicle_number = COALESCE(?, vehicle_number),
                carrier_id = COALESCE(?, carrier_id),
                location_id = COALESCE(?, location_id)
            WHERE device_id = ?
        `;

        const [result] = await db.query(updateQuery, [
            dev_ID,
            device_type,
            device_UID,
            sim_imei_num,
            vehicle_number,
            carrier_id,
            location_id,
            device_id,
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Device not found or no changes made.' });
        }

        res.status(200).json({ message: 'Device updated successfully.' });
    } catch (error) {
        logger.error('Error updating device:', error);
        res.status(500).json({ message: 'An error occurred while updating the device.', error: error.message });
    }
});


router.delete('/delete-device', jwtAuth.verifyToken, async (req, res) => {
    const { device_id } = req.query;

    if (!device_id) {
        return res.status(400).json({ message: 'Please provide device_id in query parameters.' });
    }

    try {
        const deleteQuery = `
            DELETE FROM master_devices WHERE device_id = ?
        `;

        const [result] = await db.query(deleteQuery, [device_id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Device not found.' });
        }

        res.status(200).json({ message: 'Device deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting device:', error);
        res.status(500).json({ message: 'An error occurred while deleting the device.', error: error.message });
    }
});



module.exports = router;