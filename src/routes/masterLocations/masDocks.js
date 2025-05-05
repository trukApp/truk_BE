const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


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
            const { loc_ID, dock_name, dock_timings, dock_availability } = dock;

            if (!loc_ID || !dock_name || !dock_timings || dock_availability === undefined) {
                throw new Error('Missing required fields in one of the docks.');
            }

            lastDockID = `DCK${String(parseInt(lastDockID.slice(3)) + 1).padStart(6, '0')}`;
            insertedDockIDs.push(lastDockID);

            insertValues.push([lastDockID, loc_ID, dock_name, dock_timings, dock_availability]);
        });

        await db.query(
            "INSERT INTO master_docks (dock_ID, loc_ID, dock_name, dock_timings, dock_availability) VALUES ?",
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
    const { dock_ID } = req.query;
    try {
        const query = `
            SELECT d.*, l.*
            FROM master_docks d
            LEFT JOIN master_locations l ON d.loc_ID = l.loc_ID
            WHERE d.dock_ID = ?
        `;
        const [docks] = await db.query(query, [dock_ID]);

        if (!docks.length) {
            return res.status(404).json({ message: 'Dock not found.' });
        }

        res.status(200).json({ dock_details: docks[0] });
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
            dock_availability
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



module.exports = router;