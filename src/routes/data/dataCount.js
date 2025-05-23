const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');

router.get('/count-data', jwtAuth.verifyToken, async (req, res) => {
    try {

        const queries = {
            vehicles: `SELECT COUNT(*) AS count FROM master_resources`,
            products: `SELECT COUNT(*) AS count FROM master_products`,
            locations: `SELECT COUNT(*) AS count FROM master_locations`,
            lanes: `SELECT COUNT(*) AS count FROM master_lanes`,
            devices: `SELECT COUNT(*) AS count FROM master_devices`,
            drivers: `SELECT COUNT(*) AS count FROM master_drivers`,
            carriers: `SELECT COUNT(*) AS count FROM carriers`,
            customers: `SELECT COUNT(*) AS count FROM business_partners WHERE partner_type = 'customer'`,
            vendors: `SELECT COUNT(*) AS count FROM business_partners WHERE partner_type = 'vendor'`,
            packages: `SELECT COUNT(*) AS count FROM master_package_info`,
            uoms: `SELECT COUNT(*) AS count FROM master_uom`
        };

        const results = await Promise.all(Object.values(queries).map(query => db.query(query)));

        const counts = {
            vehicles: results[0][0][0].count || 0,
            products: results[1][0][0].count || 0,
            locations: results[2][0][0].count || 0,
            lanes: results[3][0][0].count || 0,
            devices: results[4][0][0].count || 0,
            drivers: results[5][0][0].count || 0,
            carriers: results[6][0][0].count || 0,
            customers: results[7][0][0].count || 0,
            vendors: results[8][0][0].count || 0,
            packages: results[9][0][0].count || 0,
            uoms: results[10][0][0].count || 0
        };

        res.status(200).json({
            message: 'Counts retrieved successfully',
            counts
        });

    } catch (error) {
        logger.error('Error retrieving counts:', error);
        res.status(500).json({
            message: 'An error occurred while retrieving counts.',
            error: error.message,
        });
    }
});




module.exports = router;
