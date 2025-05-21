const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

const nodemailer = require('nodemailer');


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    // user: process.env.MAIL_USER, 
    // pass: process.env.MAIL_PASS
    user:'itsupport@trukapp.com',
    pass:'iytz zfrm cktq isyw'
  }
});



router.post('/create-dock', jwtAuth.verifyToken, async (req, res) => {
    try {
        const docks = req.body.docks;

        if (!Array.isArray(docks) || docks.length === 0) {
            return res.status(400).json({ message: 'Invalid input. Provide at least one dock.' });
        }

        const insertValues = [];
        const insertedDockIDs = [];

        const [result] = await db.query("SELECT dock_ID FROM master_docks ORDER BY dk_id DESC LIMIT 1 FOR UPDATE");
        let lastDockID = result[0]?.dock_ID || 'DCK0000';

        docks.forEach(dock => {
            const { loc_ID, dock_name, dock_timings, dock_availability, default_carriers } = dock;

            if (!loc_ID || !dock_name || !dock_timings || dock_availability === undefined) {
                throw new Error('Missing required fields in one of the docks.');
            }

            lastDockID = `DCK${String(parseInt(lastDockID.slice(3)) + 1).padStart(6, '0')}`;
            insertedDockIDs.push(lastDockID);

            insertValues.push([
                lastDockID,
                loc_ID,
                dock_name,
                dock_timings,
                dock_availability,
                JSON.stringify(default_carriers || [])
            ]);
        });

        await db.query(
            `INSERT INTO master_docks 
            (dock_ID, loc_ID, dock_name, dock_timings, dock_availability, default_carriers) 
            VALUES ?`,
            [insertValues]
        );

        const [createdRecords] = await db.query(
            `SELECT * FROM master_docks WHERE dock_ID IN (?)`,
            [insertedDockIDs]
        );

        res.status(201).json({
            message: 'Docks created successfully.',
            count: insertValues.length,
            created_records: createdRecords.map(record => record.dock_ID)
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: error.message || 'Server error.' });
    }
});


router.get('/all-docks', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
        const query = `SELECT * FROM master_docks`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [docks] = await db.query(paginatedQuery);

        res.status(200).json({ message: 'Docks retrieved successfully', docks });
    } catch (error) {
        logger.error('Error fetching docks:', error);
        res.status(500).json({ message: 'An error occurred while fetching docks.', error: error.message });
    }
});


router.get('/search-docks', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { searchKey, page, limit } = req.query;

        if (!searchKey || searchKey.trim().length < 1) {
            return res.status(400).json({ message: 'Search key is required in the query.' });
        }

        const query = `
            SELECT * FROM master_docks 
            WHERE dock_ID LIKE ? OR dock_name LIKE ? OR dock_timings LIKE ?
        `;

        const searchPattern = `%${searchKey}%`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [docks] = await db.query(paginatedQuery, [searchPattern, searchPattern, searchPattern]);

        if (docks.length === 0) {
            return res.status(404).json({ message: 'No docks found matching the search criteria.' });
        }

        return res.status(200).json({ message: 'Docks retrieved successfully.', searchKey, results: docks });
    } catch (error) {
        logger.error('Error searching docks:', error);
        return res.status(500).json({ message: 'An error occurred while searching docks.', error: error.message });
    }
});


router.get('/dock', jwtAuth.verifyToken, async (req, res) => {
    const { dock_ID, loc_ID } = req.query;

    try {
        if (!dock_ID && !loc_ID) {
            return res.status(400).json({ message: 'Please provide dock_ID or loc_ID in query parameters.' });
        }

        let query = `
            SELECT d.*, l.* 
            FROM master_docks d
            LEFT JOIN master_locations l ON d.loc_ID = l.loc_ID
        `;
        let conditions = [];
        let values = [];

        if (dock_ID) {
            conditions.push(`d.dock_ID = ?`);
            values.push(dock_ID);
        }

        if (loc_ID) {
            conditions.push(`d.loc_ID = ?`);
            values.push(loc_ID);
        }

        if (conditions.length) {
            query += ` WHERE ` + conditions.join(' AND ');
        }

        const [docks] = await db.query(query, values);

        if (!docks.length) {
            return res.status(404).json({ message: 'No matching dock(s) found.' });
        }

        res.status(200).json({
            results: docks.length,
            dock_details: docks
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});


router.put('/edit-dock', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { dock_ID } = req.query;
        const {
            loc_ID,
            dock_name,
            dock_timings,
            dock_availability,
            default_carriers 
        } = req.body;

        if (!dock_ID) {
            return res.status(400).json({ message: 'Missing required query parameter: dock_ID' });
        }

        const [dockExists] = await db.query(`SELECT * FROM master_docks WHERE dock_ID = ?`, [dock_ID]);
        if (!dockExists.length) {
            return res.status(404).json({ message: 'Dock not found.' });
        }

        const updateFields = [];
        const values = [];

        if (loc_ID) {
            updateFields.push('loc_ID = ?');
            values.push(loc_ID);
        }
        if (dock_name) {
            updateFields.push('dock_name = ?');
            values.push(dock_name);
        }
        if (dock_timings) {
            updateFields.push('dock_timings = ?');
            values.push(dock_timings);
        }
        if (dock_availability !== undefined) {
            updateFields.push('dock_availability = ?');
            values.push(dock_availability);
        }
        if (default_carriers !== undefined) {
            updateFields.push('default_carriers = ?');
            values.push(JSON.stringify(default_carriers));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(dock_ID);
        const query = `UPDATE master_docks SET ${updateFields.join(', ')} WHERE dock_ID = ?`;

        await db.query(query, values);

        return res.status(200).json({ message: 'Dock updated successfully.', dock_ID });
    } catch (error) {
        logger.error('Error updating dock:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});



router.delete('/delete-dock', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { id } = req.query;
        const [dockData] = await db.query("SELECT * FROM master_docks WHERE dock_ID = ?", [id]);

        const [deleteResult] = await db.query("DELETE FROM master_docks WHERE dock_ID = ?", [id]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Dock not found.' });
        }

        res.status(200).json({
            message: 'Dock deleted successfully.',
            deleted_record: dockData[0]?.dock_ID
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});


router.put('/allocate-dock-to-carrier', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { cas_ID, dock_ID } = req.body;

        if (!cas_ID || !dock_ID) {
            return res.status(400).json({ message: 'cas_ID and dock_ID are required.' });
        }

        // 1. Check assignment is valid and in requested state
        const [assignmentRows] = await db.query(`
            SELECT * FROM carrier_assignments 
            WHERE cas_ID = ? AND dock_allocation_status = 'requested'
        `, [cas_ID]);

        if (!assignmentRows.length) {
            return res.status(400).json({ message: 'Assignment not found or not in requested state.' });
        }

        const assignment = assignmentRows[0];

        // 2. Get allocated packages from orders table
        const [orderRows] = await db.query(`SELECT allocated_packages FROM orders WHERE order_ID = ?`, [assignment.order_ID]);
        if (!orderRows.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        let allocatedPackages = [];
        try {
            const raw = orderRows[0].allocated_packages || '[]';
            allocatedPackages = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            return res.status(400).json({ message: 'Invalid JSON format in allocated_packages.' });
        }

        if (!allocatedPackages.length) {
            return res.status(400).json({ message: 'No allocated packages in this order.' });
        }

        // 3. Get the pickup location (loc_ID) from first package
        const [packageRow] = await db.query(
            `SELECT ship_from FROM packages WHERE pack_ID = ? LIMIT 1`,
            [allocatedPackages[0]]
        );
        if (!packageRow.length) {
            return res.status(404).json({ message: 'Package not found.' });
        }
        const pickupLocID = packageRow[0].ship_from;

        // 4. Get dock details and verify location match
        const [dockRows] = await db.query(`SELECT * FROM master_docks WHERE dock_ID = ?`, [dock_ID]);
        if (!dockRows.length) {
            return res.status(404).json({ message: 'Dock not found.' });
        }

        const dock = dockRows[0];

        if (dock.loc_ID !== pickupLocID) {
            return res.status(400).json({
                message: `Dock's location (${dock.loc_ID}) does not match pickup location (${pickupLocID}).`
            });
        }

        // 5. Update assignment
        await db.query(`
            UPDATE carrier_assignments 
            SET dock_allocated = ?, dock_allocation_status = 'allocated' 
            WHERE cas_ID = ?
        `, [dock_ID, cas_ID]);

        // 6. Fetch carrier email
        const carrierID = assignment.confirmed_to;
        const [carrierRows] = await db.query(`SELECT carrier_name, carrier_correspondence FROM carriers WHERE carrier_ID = ?`, [carrierID]);

        if (carrierRows.length) {
            const carrier = carrierRows[0];
            const carrierName = carrier.carrier_name || 'Carrier';
            let carrierEmail = '';

            try {
                const correspondence = typeof carrier.carrier_correspondence === 'string'
                    ? JSON.parse(carrier.carrier_correspondence)
                    : carrier.carrier_correspondence;

                carrierEmail = correspondence.email || '';
            } catch (e) {
                console.error("Failed to parse carrier_correspondence:", e);
            }

            if (carrierEmail) {
                await transporter.sendMail({
                    from: process.env.MAIL_USER,
                    to: carrierEmail,
                    subject: 'Dock Allocated for Your Assignment',
                    html: `
                        <h3>Dear ${carrierName},</h3>
                        <p>Your dock has been successfully allocated for order ID <b>${assignment.order_ID}</b>.</p>
                        <p>Please log in to your carrier portal to view full details.</p>
                        <br/>
                        <p>Thank you,<br/><b>Trukapp Team</b></p>
                    `
                });
            }
        }

        return res.status(200).json({
            message: 'Dock allocated successfully and carrier notified.',
            cas_ID,
            dock_ID,
            status: 'allocated'
        });
    } catch (error) {
        logger.error('Error in dock allocation:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});




module.exports = router;