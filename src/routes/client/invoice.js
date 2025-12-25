const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/generate-package', jwtAuth.verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { lor_num, packages } = req.body;

    /* ------------------ Basic validation ------------------ */
    if (!lor_num) {
      return res.status(400).json({ message: 'lor_num is required' });
    }

    if (!Array.isArray(packages) || packages.length === 0) {
      return res.status(400).json({ message: 'Provide at least one package' });
    }

    await conn.beginTransaction();

    /* ------------------ 1. Lock & validate LOR ------------------ */
    const [[lorRow]] = await conn.query(
      `SELECT * FROM lor_data WHERE lor_num = ? FOR UPDATE`,
      [lor_num]
    );

    if (!lorRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Invalid LOR number' });
    }

    // LOR cannot be reused once order_ID is set
    if (lorRow.order_ID) {
      await conn.rollback();
      return res.status(400).json({
        message: 'This LOR is already linked to an order and cannot be reused',
        lor_num,
        order_ID: lorRow.order_ID
      });
    }

    const existingLorPackages = lorRow.packages
      ? JSON.parse(lorRow.packages)
      : [];

    /* ------------------ 2. Route consistency check ------------------ */
    const routeShipFrom = packages[0].ship_from;
    const routeShipTo = packages[0].ship_to;

    for (const pkg of packages) {
      if (
        pkg.ship_from !== routeShipFrom ||
        pkg.ship_to !== routeShipTo
      ) {
        await conn.rollback();
        return res.status(400).json({
          message: 'All packages under one LOR must have the same ship_from and ship_to'
        });
      }
    }

    /* ------------------ 3. Lock last PACK ID ------------------ */
    const [[lastPackRow]] = await conn.query(
      `SELECT pack_ID FROM packages ORDER BY pac_id DESC LIMIT 1 FOR UPDATE`
    );

    let lastPackID = lastPackRow?.pack_ID || 'PACK000000';

    const insertValues = [];
    const newPackIDs = [];

    /* ------------------ 4. Create packages ------------------ */
    for (const pkg of packages) {
      const {
        ship_from,
        ship_to,
        package_value,
        invoice_num,
        eway_num,
        destination_radius,
        product_ID,
        package_info,
        bill_to,
        return_label,
        additional_info,
        pickup_date_time,
        dropoff_date_time,
        tax_info,
        package_docs
      } = pkg;

      if (!ship_from || !ship_to || !package_info || !bill_to) {
        throw new Error('Missing required fields in one of the packages');
      }

      // Generate PACK ID
      lastPackID = `PACK${String(
        parseInt(lastPackID.slice(4)) + 1
      ).padStart(6, '0')}`;

      newPackIDs.push(lastPackID);

      insertValues.push([
        lastPackID,
        ship_from,
        ship_to,
        package_value || null,
        invoice_num || null,
        eway_num || null,
        destination_radius || null,
        JSON.stringify(product_ID || []),
        package_info,
        bill_to,
        return_label || 0,
        JSON.stringify(additional_info || {}),
        pickup_date_time || null,
        dropoff_date_time || null,
        JSON.stringify(tax_info || {}),
        'created',
        JSON.stringify(package_docs || {})
      ]);
    }

    await conn.query(
      `INSERT INTO packages (
        pack_ID,
        ship_from,
        ship_to,
        package_value,
        invoice_num,
        eway_num,
        destination_radius,
        product_ID,
        package_info,
        bill_to,
        return_label,
        additional_info,
        pickup_date_time,
        dropoff_date_time,
        tax_info,
        package_status,
        package_docs
      ) VALUES ?`,
      [insertValues]
    );

    /* ------------------ 5. Update LOR packages ------------------ */
    const updatedLorPackages = [...existingLorPackages, ...newPackIDs];

    await conn.query(
      `UPDATE lor_data
       SET packages = ?
       WHERE lor_num = ?`,
      [JSON.stringify(updatedLorPackages), lor_num]
    );

    await conn.commit();

    return res.status(201).json({
      message: 'Packages created and attached to LOR successfully',
      lor_num,
      packages_created: newPackIDs
    });

  } catch (err) {
    await conn.rollback();
    logger.error('Error in generate-package with LOR', err);

    return res.status(500).json({
      message: err.message || 'Server error'
    });
  } finally {
    conn.release();
  }
});



/**
 * GET ALL PACKAGES
 */
router.get('/all-packages', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { page, limit } = req.query;
    const query = `SELECT * FROM packages`;
    const paginatedQuery = applyPagination(query, page, limit);
    const [packages] = await db.query(paginatedQuery);

    res.status(200).json({
      message: 'Packages retrieved successfully',
      packages
    });
  } catch (error) {
    logger.error('Error fetching packages:', error);
    res.status(500).json({ message: 'An error occurred while fetching packages.' });
  }
});

/**
 * GET PACKAGE BY ID
 */
router.get('/get-package', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { pack_ID } = req.query;
    if (!pack_ID) {
      return res.status(400).json({ message: 'pack_ID is required.' });
    }

    const [rows] = await db.query(
      `
      SELECT
        p.*,
        sf.loc_desc AS ship_from_desc,
        st.loc_desc AS ship_to_desc,
        b.loc_desc  AS bill_to_desc,
        mpi.packaging_type_name,
        mpi.pack_length,
        mpi.pack_width,
        mpi.pack_height,
        mpi.pack_volume,
        mpi.handling_unit_type
      FROM packages p
      LEFT JOIN master_locations sf ON p.ship_from = sf.loc_ID
      LEFT JOIN master_locations st ON p.ship_to   = st.loc_ID
      LEFT JOIN master_locations b  ON p.bill_to   = b.loc_ID
      LEFT JOIN master_package_info mpi ON p.package_info = mpi.pac_ID
      WHERE p.pack_ID = ?
      `,
      [pack_ID]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Package not found.' });
    }

    const pkg = rows[0];

    // Parse JSON fields safely
    ['product_ID', 'additional_info', 'tax_info', 'package_docs'].forEach(k => {
      try {
        pkg[k] = JSON.parse(pkg[k] || '{}');
      } catch {
        pkg[k] = {};
      }
    });

    res.status(200).json({
      message: 'Package retrieved successfully',
      package: pkg
    });

  } catch (err) {
    logger.error('Error retrieving package:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/**
 * UPDATE PACKAGE
 */
router.put('/edit-package', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { pac_id } = req.query;
    if (!pac_id) {
      return res.status(400).json({ message: 'pac_id is required.' });
    }

    const [exists] = await db.query(`SELECT pac_id FROM packages WHERE pac_id = ?`, [pac_id]);
    if (!exists.length) {
      return res.status(404).json({ message: 'Package not found.' });
    }

    const allowedFields = [
      'ship_from',
      'ship_to',
      'package_value',
      'invoice_num',
      'eway_num',
      'destination_radius',
      'product_ID',
      'package_info',
      'bill_to',
      'return_label',
      'additional_info',
      'pickup_date_time',
      'dropoff_date_time',
      'tax_info',
      'package_docs'
    ];

    const updateFields = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateFields.push(`${field} = ?`);
        values.push(
          ['product_ID', 'additional_info', 'tax_info', 'package_docs'].includes(field)
            ? JSON.stringify(req.body[field])
            : req.body[field]
        );
      }
    }

    if (!updateFields.length) {
      return res.status(400).json({ message: 'No fields provided for update.' });
    }

    values.push(pac_id);

    await db.query(
      `UPDATE packages SET ${updateFields.join(', ')} WHERE pac_id = ?`,
      values
    );

    res.status(200).json({
      message: 'Package updated successfully.',
      pac_id
    });

  } catch (error) {
    logger.error('Error updating package:', error);
    res.status(500).json({ message: 'Server error.' });
  }
});

/**
 * DELETE PACKAGE
 */
router.delete('/delete-package', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { pac_id } = req.query;
    if (!pac_id) {
      return res.status(400).json({ message: 'pac_id is required.' });
    }

    const [record] = await db.query(
      `SELECT pack_ID FROM packages WHERE pac_id = ?`,
      [pac_id]
    );

    if (!record.length) {
      return res.status(404).json({ message: 'Package not found.' });
    }

    await db.query(`DELETE FROM packages WHERE pac_id = ?`, [pac_id]);

    res.status(200).json({
      message: 'Package deleted successfully.',
      deleted_record: record[0].pack_ID
    });

  } catch (error) {
    logger.error('Error deleting package:', error);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
