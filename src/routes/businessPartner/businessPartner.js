const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const {logger} = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/create-partners', jwtAuth.verifyToken, async (req, res) => {
    const { partners } = req.body;

    if (!Array.isArray(partners) || partners.length === 0) {
        return res.status(400).json({ message: 'Partners array is required and cannot be empty' });
    }

    try {
        const results = [];
        for (const partner of partners) {
            const {
                name,
                partner_type,
                location_id,
                correspondence,
                loc_of_source,
                pod_relevant,
                partner_functions
            } = partner;

            if (!name || !partner_type) {
                throw new Error('Name and Partner Type are required for each partner');
            }

            let supplier_id = null;
            let customer_id = null;

            if (partner_type.toLowerCase() === 'vendor') {
                const [result] = await db.query(
                    `SELECT MAX(CAST(SUBSTRING(supplier_id, 4) AS UNSIGNED)) AS maxSupplierId 
                     FROM dummy_business_partners WHERE supplier_id IS NOT NULL`
                );
                const maxSupplierId = result[0]?.maxSupplierId || 0;
                supplier_id = `SUP${(maxSupplierId + 1).toString().padStart(4, '0')}`;
            } else if (partner_type.toLowerCase() === 'customer') {
                const [result] = await db.query(
                    `SELECT MAX(CAST(SUBSTRING(customer_id, 5) AS UNSIGNED)) AS maxCustomerId 
                     FROM dummy_business_partners WHERE customer_id IS NOT NULL`
                );
                const maxCustomerId = result[0]?.maxCustomerId || 0;
                customer_id = `CUST${(maxCustomerId + 1).toString().padStart(4, '0')}`;
            } else {
                throw new Error('Invalid Partner Type');
            }

            const [insertResult] = await db.query(
                `INSERT INTO dummy_business_partners 
                (supplier_id, customer_id, name, partner_type, location_id, correspondence, loc_of_source, pod_relevant, partner_functions) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    supplier_id,
                    customer_id,
                    name,
                    partner_type,
                    location_id || null,
                    JSON.stringify(correspondence || {}),
                    loc_of_source || null,
                    pod_relevant || 0,
                    JSON.stringify(partner_functions || {})
                ]
            );

            results.push({
                partnerId: insertResult.insertId,
                supplier_id,
                customer_id,
                name
            });
        }

        logger.info('Business partners created successfully:', results);
        res.status(201).json({
            message: 'Business partners created successfully',
            partners: results
        });
    } catch (error) {
        logger.error('Error creating business partners:', error);
        res.status(500).json({ message: 'An error occurred while creating business partners', error: error.message });
    }
});


// router.get('/get-partners', jwtAuth.verifyToken, async (req, res) => {
//     const { partner_type } = req.query;

//     if (!partner_type) {
//         return res.status(400).json({ message: 'partner_type is required in query parameters' });
//     }

//     try {
//         const [partners] = await db.query(
//             `
//             SELECT 
//                 bp.partner_id,
//                 bp.supplier_id,
//                 bp.customer_id,
//                 bp.name,
//                 bp.partner_type,
//                 bp.location_id,
//                 bp.correspondence,
//                 bp.loc_of_source,
//                 bp.pod_relevant,
//                 bp.partner_functions,
//                 loc1.loc_ID AS location_loc_ID,
//                 loc1.loc_desc AS location_loc_desc,
//                 loc1.longitude AS location_longitude,
//                 loc1.latitude AS location_latitude,
//                 loc1.time_zone AS location_time_zone,
//                 loc1.city AS location_city,
//                 loc1.state AS location_state,
//                 loc1.country AS location_country,
//                 loc1.pincode AS location_pincode,
//                 loc1.loc_type AS location_loc_type,
//                 loc1.gln_code AS location_gln_code,
//                 loc1.iata_code AS location_iata_code,
//                 loc2.loc_ID AS loc_of_source_loc_ID,
//                 loc2.loc_desc AS loc_of_source_loc_desc,
//                 loc2.longitude AS loc_of_source_longitude,
//                 loc2.latitude AS loc_of_source_latitude,
//                 loc2.time_zone AS loc_of_source_time_zone,
//                 loc2.city AS loc_of_source_city,
//                 loc2.state AS loc_of_source_state,
//                 loc2.country AS loc_of_source_country,
//                 loc2.pincode AS loc_of_source_pincode,
//                 loc2.loc_type AS loc_of_source_loc_type,
//                 loc2.gln_code AS loc_of_source_gln_code,
//                 loc2.iata_code AS loc_of_source_iata_code
//             FROM 
//                 dummy_business_partners bp
//             LEFT JOIN 
//                 dummy_master_locations loc1 ON bp.location_id = loc1.location_id
//             LEFT JOIN 
//                 dummy_master_locations loc2 ON bp.loc_of_source = loc2.location_id
//             WHERE 
//                 bp.partner_type = ?
//             ORDER BY 
//                 bp.partner_id DESC
//             `,
//             [partner_type]
//         );

//         res.status(200).json({
//             message: 'Business partners retrieved successfully',
//             partners,
//         });
//     } catch (error) {
//         logger.error('Error retrieving business partners:', error);
//         res.status(500).json({ message: 'An error occurred while retrieving business partners', error: error.message });
//     }
// });


router.get('/get-partners', jwtAuth.verifyToken, async (req, res) => {
    const { partner_type, supplier_id, customer_id } = req.query;

    if (!partner_type && !supplier_id && !customer_id) {
        return res.status(400).json({
            message: 'At least one of partner_type, supplier_id, or customer_id is required in query parameters',
        });
    }

    // Build dynamic query conditions
    const conditions = [];
    const queryParams = [];

    if (partner_type) {
        conditions.push('bp.partner_type = ?');
        queryParams.push(partner_type);
    }

    if (supplier_id) {
        conditions.push('bp.supplier_id = ?');
        queryParams.push(supplier_id);
    }

    if (customer_id) {
        conditions.push('bp.customer_id = ?');
        queryParams.push(customer_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [partners] = await db.query(
            `
            SELECT 
                bp.partner_id,
                bp.supplier_id,
                bp.customer_id,
                bp.name,
                bp.partner_type,
                bp.location_id,
                bp.correspondence,
                bp.loc_of_source,
                bp.pod_relevant,
                bp.partner_functions,
                loc1.loc_ID AS location_loc_ID,
                loc1.loc_desc AS location_loc_desc,
                loc1.longitude AS location_longitude,
                loc1.latitude AS location_latitude,
                loc1.time_zone AS location_time_zone,
                loc1.city AS location_city,
                loc1.state AS location_state,
                loc1.country AS location_country,
                loc1.pincode AS location_pincode,
                loc1.loc_type AS location_loc_type,
                loc1.gln_code AS location_gln_code,
                loc1.iata_code AS location_iata_code,
                loc2.loc_ID AS loc_of_source_loc_ID,
                loc2.loc_desc AS loc_of_source_loc_desc,
                loc2.longitude AS loc_of_source_longitude,
                loc2.latitude AS loc_of_source_latitude,
                loc2.time_zone AS loc_of_source_time_zone,
                loc2.city AS loc_of_source_city,
                loc2.state AS loc_of_source_state,
                loc2.country AS loc_of_source_country,
                loc2.pincode AS loc_of_source_pincode,
                loc2.loc_type AS loc_of_source_loc_type,
                loc2.gln_code AS loc_of_source_gln_code,
                loc2.iata_code AS loc_of_source_iata_code
            FROM 
                dummy_business_partners bp
            LEFT JOIN 
                dummy_master_locations loc1 ON bp.location_id = loc1.location_id
            LEFT JOIN 
                dummy_master_locations loc2 ON bp.loc_of_source = loc2.location_id
            ${whereClause}
            ORDER BY 
                bp.partner_id DESC
            `,
            queryParams
        );

        res.status(200).json({
            message: 'Business partners retrieved successfully',
            partners,
        });
    } catch (error) {
        logger.error('Error retrieving business partners:', error);
        res.status(500).json({ message: 'An error occurred while retrieving business partners', error: error.message });
    }
});



module.exports = router;
