const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/create-package', jwtAuth.verifyToken, async (req, res) => {
    const packages = req.body.packages;

    if (!packages || packages.length === 0) {
        return res.status(400).json({ message: 'Please provide package data.' });
    }

    try {
        const packageData = Array.isArray(packages) ? packages : [packages];

        const [lastPackage] = await db.query(`
            SELECT pac_ID FROM master_package_info ORDER BY package_id DESC LIMIT 1 FOR UPDATE
        `);

        let lastPackageNumber = 0;
        if (lastPackage.length > 0 && lastPackage[0].pac_ID) {
            lastPackageNumber = parseInt(lastPackage[0].pac_ID.replace('PKG', '')) || 0;
        }

        const newPackages = packageData.map((pkg, index) => {
            const pac_ID = `PKG${String(lastPackageNumber + index + 1).padStart(6, '0')}`;
            return {
                ...pkg,
                pac_ID,
            };
        });

        const insertPromises = newPackages.map(async (pkg) => {
            const { pac_ID, packaging_type_name, dimensions_uom, dimensions, handling_unit_type } = pkg;

            return db.query(
                `
                INSERT INTO master_package_info (
                    pac_ID, 
                    packaging_type_name, 
                    dimensions_uom, 
                    dimensions, 
                    handling_unit_type
                ) VALUES (?, ?, ?, ?, ?)
                `,
                [
                    pac_ID,
                    packaging_type_name,
                    dimensions_uom,
                    dimensions,
                    handling_unit_type,
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Packages added successfully',
            packages: newPackages,
        });
    } catch (error) {
        logger.error('Error adding packages:', error);
        res.status(500).json({ message: 'An error occurred while adding packages.', error: error.message });
    }
});


router.get('/get-all-packages', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [packages] = await db.query(`
            SELECT * FROM master_package_info ORDER BY package_id DESC
        `);
        res.status(200).json({ message: 'Packages retrieved successfully', packages });
    } catch (error) {
        logger.error('Error fetching packages:', error);
        res.status(500).json({ message: 'An error occurred while fetching packages.', error: error.message });
    }
});


router.get('/get-package', jwtAuth.verifyToken, async (req, res) => {
    const { pac_ID } = req.query;

    if (!pac_ID) {
        return res.status(400).json({ message: 'Please provide a valid pac_ID.' });
    }

    try {
        const [package] = await db.query(
            `SELECT * FROM master_package_info WHERE pac_ID = ?`,
            [pac_ID]
        );

        if (!package.length) {
            return res.status(404).json({ message: 'Package not found.' });
        }

        res.status(200).json({ message: 'Package retrieved successfully', package: package[0] });
    } catch (error) {
        logger.error('Error fetching package:', error);
        res.status(500).json({ message: 'An error occurred while fetching the package.', error: error.message });
    }
});


router.put('/edit-package', jwtAuth.verifyToken, async (req, res) => {
    const { package_id } = req.query;
    const { packaging_type_name, dimensions_uom, dimensions, handling_unit_type } = req.body;

    if (!package_id) {
        return res.status(400).json({ message: 'Please provide a valid package_id.' });
    }

    try {
        const [result] = await db.query(
            `
            UPDATE master_package_info 
            SET packaging_type_name = ?, 
                dimensions_uom = ?, 
                dimensions = ?, 
                handling_unit_type = ?
            WHERE package_id = ?
            `,
            [packaging_type_name, dimensions_uom, dimensions, handling_unit_type, package_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Package not found or no changes made.' });
        }

        res.status(200).json({ message: 'Package updated successfully' });
    } catch (error) {
        logger.error('Error updating package:', error);
        res.status(500).json({ message: 'An error occurred while updating the package.', error: error.message });
    }
});


router.delete('/delete-package', jwtAuth.verifyToken, async (req, res) => {
    const { package_id } = req.query;

    if (!package_id) {
        return res.status(400).json({ message: 'Please provide a valid package_id.' });
    }

    try {
        const [result] = await db.query(
            `DELETE FROM master_package_info WHERE package_id = ?`,
            [package_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Package not found.' });
        }

        res.status(200).json({ message: 'Package deleted successfully' });
    } catch (error) {
        logger.error('Error deleting package:', error);
        res.status(500).json({ message: 'An error occurred while deleting the package.', error: error.message });
    }
});



module.exports = router;