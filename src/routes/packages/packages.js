const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');



// router.post('/generate-package', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const packages = req.body.packages;
//         if (!Array.isArray(packages) || packages.length === 0) {
//             return res.status(400).json({ message: 'Invalid input. Provide at least one package.' });
//         }

//         const [result] = await db.query("SELECT pack_ID FROM packages ORDER BY pac_id DESC LIMIT 1 FOR UPDATE");
//         let lastPackID = result[0]?.pack_ID || 'PACK000000';

//         const insertValues = [];
//         const insertedPackIDs = [];

//         packages.forEach(pkg => {
//             const {
//                 ship_from, ship_to, destination_radius, product_ID, package_info, bill_to,
//                 return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info
//             } = pkg;

//             if (!ship_from || !ship_to || !package_info || !bill_to) {
//                 throw new Error('Missing required fields in one of the packages.');
//             }

//             lastPackID = `PACK${String(parseInt(lastPackID.slice(4)) + 1).padStart(6, '0')}`;
//             insertedPackIDs.push(lastPackID);

//             insertValues.push([
//                 lastPackID, ship_from, ship_to, destination_radius, JSON.stringify(product_ID || []), package_info,
//                 bill_to, return_label || 0, JSON.stringify(additional_info || {}),
//                 pickup_date_time || null, dropoff_date_time || null, JSON.stringify(tax_info || {})
//             ]);
//         });

//         await db.query(
//             `INSERT INTO packages 
//             (pack_ID, ship_from, ship_to, destination_radius, product_ID, package_info, bill_to, return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info)
//             VALUES ?`,
//             [insertValues]
//         );

//         const [createdRecords] = await db.query(
//             `SELECT * FROM packages WHERE pack_ID IN (?)`,
//             [insertedPackIDs]
//         );

//         res.status(201).json({
//             message: 'Packages created successfully.',
//             count: insertedPackIDs.length,
//             created_records: createdRecords.map(record => record.pack_ID)
//         });
//     } catch (error) {
//         logger.error(error);
//         res.status(500).json({ message: error.message || 'Server error.' });
//     }
// });


router.post('/generate-package', jwtAuth.verifyToken, async (req, res) => {
    try {
        const packages = req.body.packages;
        if (!Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({ message: 'Invalid input. Provide at least one package.' });
        }

        const [result] = await db.query("SELECT pack_ID FROM packages ORDER BY pac_id DESC LIMIT 1 FOR UPDATE");
        let lastPackID = result[0]?.pack_ID || 'PACK000000';

        const insertValues = [];
        const insertedPackIDs = [];

        for (const pkg of packages) {
            const {
                ship_from, ship_to, destination_radius, product_ID, package_info, bill_to,
                return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info
            } = pkg;

            if (!ship_from || !ship_to || !package_info || !bill_to) {
                throw new Error('Missing required fields in one of the packages.');
            }

            // ✅ Validate stacking factor
            const productIDs = (product_ID || []).map(p => p.prod_ID);
            if (productIDs.length === 0) {
                throw new Error('No products provided in one of the packages.');
            }

            const [stackingRows] = await db.query(
                `SELECT product_ID, stacking_factor FROM master_products WHERE product_ID IN (?)`,
                [productIDs]
            );

            const stackingMap = {};
            stackingRows.forEach(row => {
                stackingMap[row.product_ID] = row.stacking_factor;
            });

            const stackingSet = new Set(product_ID.map(p => stackingMap[p.prod_ID]));
            if (stackingSet.size !== 1) {
                throw new Error(`All products in a package must have the same stacking factor. Found: ${Array.from(stackingSet).join(', ')}`);
            }

            // ✅ Proceed to create the package
            lastPackID = `PACK${String(parseInt(lastPackID.slice(4)) + 1).padStart(6, '0')}`;
            insertedPackIDs.push(lastPackID);

            insertValues.push([
                lastPackID, ship_from, ship_to, destination_radius, JSON.stringify(product_ID || []), package_info,
                bill_to, return_label || 0, JSON.stringify(additional_info || {}),
                pickup_date_time || null, dropoff_date_time || null, JSON.stringify(tax_info || {})
            ]);
        }

        await db.query(
            `INSERT INTO packages 
            (pack_ID, ship_from, ship_to, destination_radius, product_ID, package_info, bill_to, return_label, additional_info, pickup_date_time, dropoff_date_time, tax_info)
            VALUES ?`,
            [insertValues]
        );

        const [createdRecords] = await db.query(
            `SELECT * FROM packages WHERE pack_ID IN (?)`,
            [insertedPackIDs]
        );

        res.status(201).json({
            message: 'Packages created successfully.',
            count: insertedPackIDs.length,
            created_records: createdRecords.map(record => record.pack_ID)
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: error.message || 'Server error.' });
    }
});



router.get('/all-packages', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page, limit } = req.query;
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
                mpi.packaging_type_name, mpi.dimensions_uom, mpi.pack_length, mpi.pack_width, mpi.pack_height, mpi.pack_volume, mpi.pack_volume_uom, mpi.handling_unit_type
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
            return res.status(400).json({ message: 'Missing required query parameter: pac_id' });
        }

        const [packageExists] = await db.query(`SELECT * FROM packages WHERE pac_id = ?`, [pac_id]);
        if (!packageExists.length) {
            return res.status(404).json({ message: 'Package not found.' });
        }

        const {
            ship_from,
            ship_to,
            destination_radius,
            product_ID,
            package_info,
            bill_to,
            return_label,
            additional_info,
            pickup_date_time,
            dropoff_date_time,
            tax_info
        } = req.body;

        let updateFields = [];
        let values = [];

        if (ship_from) {
            updateFields.push('ship_from = ?');
            values.push(ship_from);
        }

        if (ship_to) {
            updateFields.push('ship_to = ?');
            values.push(ship_to);
        }

        if (destination_radius) {
            updateFields.push('destination_radius = ?');
            values.push(destination_radius);
        }

        if (product_ID) {
            updateFields.push('product_ID = ?');
            values.push(JSON.stringify(product_ID));
        }

        if (package_info) {
            updateFields.push('package_info = ?');
            values.push(package_info);
        }

        if (bill_to) {
            updateFields.push('bill_to = ?');
            values.push(bill_to);
        }

        if (return_label) {
            updateFields.push('return_label = ?');
            values.push(return_label);
        }

        if (additional_info) {
            updateFields.push('additional_info = ?');
            values.push(JSON.stringify(additional_info));
        }

        if (pickup_date_time) {
            updateFields.push('pickup_date_time = ?');
            values.push(pickup_date_time);
        }

        if (dropoff_date_time) {
            updateFields.push('dropoff_date_time = ?');
            values.push(dropoff_date_time);
        }

        if (tax_info) {
            updateFields.push('tax_info = ?');
            values.push(JSON.stringify(tax_info));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        values.push(pac_id);
        const query = `UPDATE packages SET ${updateFields.join(', ')} WHERE pac_id = ?`;

        await db.query(query, values);

        return res.status(200).json({ message: 'Package updated successfully.', pac_id });
    } catch (error) {
        logger.error('Error updating package:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});


router.delete('/delete-package', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { pac_id } = req.query;
        const query = "SELECT * FROM packages where pac_id = ?";
        const [recordData] = await db.query(query, pac_id);

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

        res.status(200).json({
            message: 'Package deleted successfully.',
            deleted_record: recordData[0].pack_ID
        });

    } catch (error) {
        logger.error('Error deleting package:', error);
        res.status(500).json({ message: 'An error occurred while deleting the package.', error: error.message });
    }
});



module.exports = router;