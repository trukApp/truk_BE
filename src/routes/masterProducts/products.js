const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/add-products', jwtAuth.verifyToken, async (req, res) => {
    const { products } = req.body;
    console.log("products: ", products)

    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ message: 'Invalid input. Please provide an array of products.' });
    }

    try {
        // Fetch the latest product_ID from the database
        const [lastProduct] = await db.query(`
            SELECT product_ID FROM master_products ORDER BY prod_id DESC LIMIT 1
        `);

        let lastProductNumber = 0;
        if (lastProduct.length > 0 && lastProduct[0].product_ID) {
            lastProductNumber = parseInt(lastProduct[0].product_ID.replace('PROD', '')) || 0;
        }

        // Prepare products with unique product_IDs
        const newProducts = products.map((product, index) => {
            const product_ID = `PROD${String(lastProductNumber + index + 1).padStart(6, '0')}`;
            return {
                ...product,
                product_ID,
            };
        });

        // Insert all products into the database
        const insertPromises = newProducts.map(async (product) => {
            const {
                product_ID,
                product_name,
                product_desc,
                basic_uom,
                sales_uom,
                weight,
                weight_uom,
                volume,
                volume_uom,
                expiration,
                best_before,
                stacking_factor,
                sku_num,
                hsn_code,
                documents,
                loc_ID,
                packaging_type,
                special_instructions,
                packing_label,
                fragile_goods,
                dangerous_goods,
                hazardous,
                temp_controlled,
            } = product;

            return db.query(
                `
                INSERT INTO master_products (
                    product_ID, 
                    product_name,
                    product_desc, 
                    basic_uom, 
                    sales_uom, 
                    weight, 
                    weight_uom, 
                    volume, 
                    volume_uom, 
                    expiration, 
                    best_before, 
                    stacking_factor, 
                    sku_num, 
                    hsn_code, 
                    documents, 
                    loc_ID, 
                    packaging_type, 
                    special_instructions, 
                    packing_label, 
                    fragile_goods, 
                    dangerous_goods, 
                    hazardous, 
                    temp_controlled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    product_ID,
                    product_name || null,
                    product_desc || null,
                    basic_uom || null,
                    sales_uom || null,
                    weight || null,
                    weight_uom || null,
                    volume || null,
                    volume_uom || null,
                    expiration || null,
                    best_before || null,
                    stacking_factor || null,
                    sku_num || null,
                    hsn_code || null,
                    documents || null,
                    loc_ID || null,
                    JSON.stringify(packaging_type || {}),
                    special_instructions || null,
                    packing_label || 0,
                    fragile_goods || 0,
                    dangerous_goods || 0,
                    hazardous || 0,
                    temp_controlled || 0,
                ]
            );
        });

        await Promise.all(insertPromises);

        res.status(201).json({
            message: 'Products added successfully',
            products: newProducts,
        });
    } catch (error) {
        logger.error('Error adding products:', error);
        res.status(500).json({ message: 'An error occurred while adding products.', error: error.message });
    }
});


router.get('/all-products', jwtAuth.verifyToken, async (req, res) => {
    try {
        const [products] = await db.query(`
            SELECT * FROM master_products
        `);

        res.status(200).json({
            message: 'Products retrieved successfully',
            products,
        });
    } catch (error) {
        logger.error('Error fetching products:', error);
        res.status(500).json({ message: 'An error occurred while fetching products.', error: error.message });
    }
});


router.get('/product', jwtAuth.verifyToken, async (req, res) => {
    const { product_ID } = req.query;

    if (!product_ID) {
        return res.status(400).json({ message: 'product_ID is required in the query.' });
    }

    try {
        const [product] = await db.query(`
            SELECT 
                p.*, 
                l.loc_desc, 
                l.longitude, 
                l.latitude, 
                l.time_zone, 
                l.city, 
                l.state, 
                l.country, 
                l.pincode, 
                l.loc_type, 
                l.gln_code, 
                l.iata_code, 
                l.address_1, 
                l.address_2
            FROM master_products p
            LEFT JOIN master_locations l ON p.loc_ID = l.loc_ID
            WHERE p.product_ID = ?
        `, [product_ID]);

        if (product.length === 0) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        res.status(200).json({
            message: 'Product retrieved successfully',
            product: product[0],
        });
    } catch (error) {
        logger.error('Error fetching product:', error);
        res.status(500).json({ message: 'An error occurred while fetching the product.', error: error.message });
    }
});


router.put('/edit-product', jwtAuth.verifyToken, async (req, res) => {
    const { prod_id } = req.query; // Product ID to update
    const {
        product_name,
        product_desc,
        basic_uom,
        sales_uom,
        weight,
        weight_uom,
        volume,
        volume_uom,
        expiration,
        best_before,
        stacking_factor,
        sku_num,
        hsn_code,
        documents,
        loc_ID,
        packaging_type,
        special_instructions,
        packing_label,
        fragile_goods,
        dangerous_goods,
        hazardous,
        temp_controlled,
    } = req.body;

    if (!prod_id) {
        return res.status(400).json({ message: 'prod_id is required in query parameters' });
    }

    try {
        const [result] = await db.query(
            `
            UPDATE master_products
            SET 
                product_name = ?,
                product_desc = ?,
                basic_uom = ?,
                sales_uom = ?,
                weight = ?,
                weight_uom = ?,
                volume = ?,
                volume_uom = ?,
                expiration = ?,
                best_before = ?,
                stacking_factor = ?,
                sku_num = ?,
                hsn_code = ?,
                documents = ?,
                loc_ID = ?,
                packaging_type = ?,
                special_instructions = ?,
                packing_label = ?,
                fragile_goods = ?,
                dangerous_goods = ?,
                hazardous = ?,
                temp_controlled = ?
            WHERE prod_id = ?
            `,
            [
                product_name || null,
                product_desc || null,
                basic_uom || null,
                sales_uom || null,
                weight || null,
                weight_uom || null,
                volume || null,
                volume_uom || null,
                expiration || null,
                best_before || null,
                stacking_factor || null,
                sku_num || null,
                hsn_code || null,
                documents || null,
                loc_ID || null,
                JSON.stringify(packaging_type || {}),
                special_instructions || null,
                packing_label || 0,
                fragile_goods || 0,
                dangerous_goods || 0,
                hazardous || 0,
                temp_controlled || 0,
                prod_id,
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'No product found with the given prod_id' });
        }

        res.status(200).json({ message: 'Product updated successfully' });
    } catch (error) {
        logger.error('Error updating product:', error);
        res.status(500).json({ message: 'An error occurred while updating the product', error: error.message });
    }
});


router.delete('/delete-product', jwtAuth.verifyToken, async (req, res) => {
    const { prod_id } = req.query;

    if (!prod_id) {
        return res.status(400).json({ message: 'prod_id is required in the query.' });
    }

    try {
        const [deleteResult] = await db.query(`
            DELETE FROM master_products WHERE prod_id = ?
        `, [prod_id]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        res.status(200).json({ message: 'Product deleted successfully.' });
    } catch (error) {
        logger.error('Error deleting product:', error);
        res.status(500).json({ message: 'An error occurred while deleting the product.', error: error.message });
    }
});



module.exports = router;