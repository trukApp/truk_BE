const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');

router.post('/add-uom', jwtAuth.verifyToken, async (req, res) => {
    const { unit_name, unit_desc, alt_unit_name, alt_unit_desc } = req.body;

    if (!unit_name) {
        return res.status(400).json({ message: 'Unit name is required.' });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO master_uom (unit_name, unit_desc, alt_unit_name, alt_unit_desc) VALUES (?, ?, ?, ?)`,
            [unit_name, unit_desc || null, alt_unit_name || null, alt_unit_desc || null]
        );

        res.status(201).json({
            message: 'Unit of measurement added successfully.',
            unit_id: result.insertId,
        });
    } catch (error) {
        logger.error('Error adding unit of measurement:', error);
        res.status(500).json({ message: 'An error occurred while adding the unit of measurement.', error: error.message });
    }
});


router.get('/all-uom', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [uomList] = await db.query(`SELECT * FROM master_uom`);

        res.status(200).json({
            message: 'Units of measurement retrieved successfully.',
            uomList,
        });
    } catch (error) {
        logger.error('Error fetching units of measurement:', error);
        res.status(500).json({ message: 'An error occurred while fetching units of measurement.', error: error.message });
    }
});


router.get('/all-uom-names', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [uomNames] = await db.query(`SELECT unit_name FROM master_uom`);

        res.status(200).json({
            message: 'Units of measurement retrieved successfully.',
            uomNames,
        });
    } catch (error) {
        logger.error('Error fetching units of measurement:', error);
        res.status(500).json({ message: 'An error occurred while fetching units of measurement.', error: error.message });
    }
});


router.get('/uom', jwtAuth.verifyToken, async (req, res) => {
    const { unit_id } = req.query;

    if (!unit_id) {
        return res.status(400).json({ message: 'unit_id is required in the query.' });
    }

    try {
        const [uom] = await db.query(`SELECT * FROM master_uom WHERE unit_id = ?`, [unit_id]);

        if (uom.length === 0) {
            return res.status(404).json({ message: 'Unit of measurement not found.' });
        }

        res.status(200).json({
            message: 'Unit of measurement retrieved successfully.',
            uom: uom[0],
        });
    } catch (error) {
        logger.error('Error fetching unit of measurement:', error);
        res.status(500).json({ message: 'An error occurred while fetching the unit of measurement.', error: error.message });
    }
});


router.put('/edit-uom', jwtAuth.verifyToken, async (req, res) => {
    const { unit_id } = req.query;
    const { unit_name, unit_desc, alt_unit_name, alt_unit_desc } = req.body;

    if (!unit_id) {
        return res.status(400).json({ message: 'unit_id is required in the query.' });
    }

    try {
        const [updateResult] = await db.query(
            `UPDATE master_uom 
             SET 
                unit_name = COALESCE(?, unit_name), 
                unit_desc = COALESCE(?, unit_desc), 
                alt_unit_name = COALESCE(?, alt_unit_name), 
                alt_unit_desc = COALESCE(?, alt_unit_desc)
             WHERE unit_id = ?`,
            [unit_name || null, unit_desc || null, alt_unit_name || null, alt_unit_desc || null, unit_id]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Unit of measurement not found or no changes made.' });
        }

        res.status(200).json({ message: 'Unit of measurement updated successfully.' });
    } catch (error) {
        logger.error('Error updating unit of measurement:', error);
        res.status(500).json({ message: 'An error occurred while updating the unit of measurement.', error: error.message });
    }
});


router.delete('/delete-uom', jwtAuth.verifyToken, async (req, res) => {
    const { unit_id } = req.query;

    if (!unit_id) {
        return res.status(400).json({ message: 'unit_id is required in the query.' });
    }

    try {
        const [deleteResult] = await db.query(`DELETE FROM master_uom WHERE unit_id = ?`, [unit_id]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Unit of measurement not found.' });
        }

        res.status(200).json({ message: 'Unit of measurement deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting unit of measurement:', error);
        res.status(500).json({ message: 'An error occurred while deleting the unit of measurement.', error: error.message });
    }
});




module.exports = router;