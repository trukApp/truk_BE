const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const {applyPagination} = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/generate-package', jwtAuth.verifyToken, async (req, res) => {
    try {
        const packages = req.body.packages;
        if (!Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({ message: 'Invalid input. Provide at least one package.' });
        }

        const [result] = await db.query("SELECT pack_ID FROM packages ORDER BY pac_id DESC LIMIT 1 FOR UPDATE");
        let lastPackID = result[0]?.pack_ID || 'PACK000000';

        const insertValues = [];
        packages.forEach(pkg => {
            const {
                ship_from, ship_to, product_ID, package_info, bill_to,
                return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info
            } = pkg;

            if (!ship_from || !ship_to || !package_info || !bill_to) {
                throw new Error('Missing required fields in one of the packages.');
            }

            lastPackID = `PACK${String(parseInt(lastPackID.slice(4)) + 1).padStart(6, '0')}`;

            insertValues.push([
                lastPackID, ship_from, ship_to, JSON.stringify(product_ID || []), package_info,
                bill_to, return_label || 0, JSON.stringify(additional_info || {}),
                pickup_date_time || null, dropoff_date_time || null, JSON.stringify(tax_info || {})
            ]);
        });

        await db.query(
            `INSERT INTO packages 
            (pack_ID, ship_from, ship_to, product_ID, package_info, bill_to, return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info)
            VALUES ?`,
            [insertValues]
        );

        res.status(201).json({ message: 'Packages created successfully.', count: insertValues.length });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: error.message || 'Server error.' });
    }
});



router.get('/all-packages', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page , limit } = req.query;
        const query = `SELECT * FROM packages`;
        const paginatedQuery = applyPagination(query, page, limit);
        const [packages] = await db.query(paginatedQuery);

        res.status(200).json({
            message: 'Packages retrieved successfully',
            packages,
        });
    } catch (error) {
        logger.error('Error fetching packages:', error);
        res.status(500).json({ message: 'An error occurred while fetching packages.', error: error.message });
    }
});


router.get('/get-package', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { pack_ID } = req.query;

        if (!pack_ID) {
            return res.status(400).json({ message: 'pack_ID is required in the query.' });
        }

        const [packages] = await db.query(
            `SELECT 
                p.*,
                sf.loc_desc AS ship_from_desc, sf.longitude AS ship_from_long, sf.latitude AS ship_from_lat,
                st.loc_desc AS ship_to_desc, st.longitude AS ship_to_long, st.latitude AS ship_to_lat,
                b.loc_desc AS bill_to_desc, b.longitude AS bill_to_long, b.latitude AS bill_to_lat,
                mpi.packaging_type_name, mpi.dimensions_uom, mpi.dimensions, mpi.handling_unit_type
            FROM packages p
            LEFT JOIN master_locations sf ON p.ship_from = sf.loc_ID
            LEFT JOIN master_locations st ON p.ship_to = st.loc_ID
            LEFT JOIN master_locations b ON p.bill_to = b.loc_ID
            LEFT JOIN master_package_info mpi ON p.package_info = mpi.pac_ID
            WHERE p.pack_ID = ?`,
            [pack_ID]
        );

        if (packages.length === 0) {
            return res.status(404).json({ message: 'Package not found.' });
        }

        let packageData = packages[0];

        try { packageData.additional_info = JSON.parse(packageData.additional_info || '{}'); } catch (error) { packageData.additional_info = {}; }
        try { packageData.tax_info = JSON.parse(packageData.tax_info || '{}'); } catch (error) { packageData.tax_info = {}; }

        let productList = [];
        try {
            if (typeof packageData.product_ID === "string") {
                productList = JSON.parse(packageData.product_ID);
            } else if (Array.isArray(packageData.product_ID)) {
                productList = packageData.product_ID;
            }
        } catch (error) {
            productList = [];
        }

        const productIDs = productList.map(p => p.prod_ID).filter(id => id);

        if (productIDs.length > 0) {
            const [products] = await db.query(
                `SELECT 
                    product_ID, product_name, product_desc, basic_uom, weight, weight_uom, volume, volume_uom
                 FROM master_products WHERE product_ID IN (?)`,
                [productIDs]
            );


            const productMap = {};
            products.forEach(p => productMap[String(p.product_ID)] = p);

            packageData.products = productList.map(prod => ({
                prod_ID: prod.prod_ID,
                quantity: prod.quantity,
                details: productMap[String(prod.prod_ID)] || null
            })).filter(p => p.details !== null);
        } else {
            packageData.products = [];
        }

        res.status(200).json({
            message: 'Package retrieved successfully',
            package: packageData
        });

    } catch (error) {
        logger.error('Error retrieving package:', error);
        res.status(500).json({ message: 'An error occurred while retrieving the package.', error: error.message });
    }
});


router.put('/edit-package', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { pac_id } = req.query;

        if (!pac_id) {
            return res.status(400).json({ message: 'pac_id is required in the query.' });
        }

        const {
            ship_from, ship_to, product_ID, package_info, bill_to,
            return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info
        } = req.body;

        // Convert objects to JSON strings if they exist
        const productIDJson = product_ID ? JSON.stringify(product_ID) : null;
        const additionalInfoJson = additional_info ? JSON.stringify(additional_info) : null;
        const taxInfoJson = tax_info ? JSON.stringify(tax_info) : null;

        const [updateResult] = await db.query(
            `UPDATE packages 
            SET 
                ship_from = COALESCE(?, ship_from),
                ship_to = COALESCE(?, ship_to),
                product_ID = COALESCE(?, product_ID),
                package_info = COALESCE(?, package_info),
                bill_to = COALESCE(?, bill_to),
                return_label = COALESCE(?, return_label),
                additional_info = COALESCE(?, additional_info),
                pickup_date_time = COALESCE(?, pickup_date_time),
                dropoff_date_time = COALESCE(?, dropoff_date_time),
                tax_info = COALESCE(?, tax_info)
            WHERE pac_id = ?`,
            [
                ship_from || null, ship_to || null, productIDJson,
                package_info || null, bill_to || null, return_label || null,
                additionalInfoJson, pickup_date_time || null, dropoff_date_time || null,
                taxInfoJson, pac_id
            ]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Package not found or no changes made.' });
        }

        res.status(200).json({ message: 'Package updated successfully.' });

    } catch (error) {
        logger.error('Error updating package:', error);
        res.status(500).json({ message: 'An error occurred while updating the package.', error: error.message });
    }
});


router.delete('/delete-package', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { pac_id } = req.query;

        if (!pac_id) {
            return res.status(400).json({ message: 'pac_id is required in the query.' });
        }

        const [deleteResult] = await db.query(
            `DELETE FROM packages WHERE pac_id = ?`,
            [pac_id]
        );

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Package not found.' });
        }

        res.status(200).json({ message: 'Package deleted successfully.' });

    } catch (error) {
        logger.error('Error deleting package:', error);
        res.status(500).json({ message: 'An error occurred while deleting the package.', error: error.message });
    }
});



module.exports=router;