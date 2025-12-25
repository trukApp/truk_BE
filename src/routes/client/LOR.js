const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');

function safeParsePackages(value) {
  if (!value) return [];

  // Already an array (just in case)
  if (Array.isArray(value)) return value;

  if (typeof value !== 'string') return [];

  const trimmed = value.trim();

  // JSON array
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Comma-separated or single pack_ID
  return trimmed
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}



router.post('/generate-lor',jwtAuth.verifyToken,async (req, res) => {
    try {
      const { source_code, client_code, LOR_count } = req.body;

      if (!source_code || !client_code || !LOR_count) {
        return res.status(400).json({
          message: 'source_code, client_code and LOR_count are required'
        });
      }

      if (!Number.isInteger(LOR_count) || LOR_count <= 0) {
        return res.status(400).json({
          message: 'LOR_count must be a positive integer'
        });
      }

      const prefix = `TALOR${source_code}`;
      const suffix = client_code;

      const [rows] = await db.query(
        `
        SELECT lor_num
        FROM lor_data
        WHERE lor_num LIKE ?
        ORDER BY lor_id DESC
        LIMIT 1
        `,
        [`${prefix}%${suffix}`]
      );

      let lastSeq = 0;

      if (rows.length) {
        const lastLor = rows[0].lor_num;
        // Extract numeric part between source_code and client_code
        const match = lastLor.match(
          new RegExp(`${prefix}(\\d+)${suffix}`)
        );
        if (match) {
          lastSeq = parseInt(match[1], 10);
        }
      }

      // 🔹 Generate new LOR numbers
      const lorValues = [];
      const generatedLORs = [];

      for (let i = 1; i <= LOR_count; i++) {
        const seq = String(lastSeq + i).padStart(8, '0');
        const lorNum = `${prefix}${seq}${suffix}`;

        generatedLORs.push(lorNum);
        lorValues.push([lorNum, null, null]);
      }

      // 🔹 Insert into DB
      await db.query(
        `
        INSERT INTO lor_data (lor_num, packages, order_ID)
        VALUES ?
        `,
        [lorValues]
      );

      logger.info('LORs generated successfully', {
        source_code,
        client_code,
        count: LOR_count
      });

      return res.status(201).json({
        message: 'LOR numbers generated successfully',
        LORs: generatedLORs
      });

    } catch (err) {
      logger.error('Error generating LOR numbers', {
        error: err.message,
        stack: err.stack
      });

      return res.status(500).json({
        message: 'Internal server error'
      });
    }
  }
);


router.get('/all-lors', jwtAuth.verifyToken, async (req, res) => {
  try {
    const [lors] = await db.query(
      `SELECT * FROM lor_data ORDER BY lor_id DESC`
    );

    if (!lors.length) {
      return res.status(200).json({
        message: 'No LORs found',
        lors: []
      });
    }

    // ✅ SAFE parsing
    const allPackIDs = lors.flatMap(l =>
      safeParsePackages(l.packages)
    );

    let packageMap = {};
    if (allPackIDs.length) {
      const [pkgs] = await db.query(
        `SELECT * FROM packages WHERE pack_ID IN (?)`,
        [allPackIDs]
      );

      pkgs.forEach(p => {
        packageMap[p.pack_ID] = p;
      });
    }

    const enriched = lors.map(lor => ({
      ...lor,
      packages: safeParsePackages(lor.packages)
        .map(id => packageMap[id])
        .filter(Boolean)
    }));

    return res.status(200).json({
      message: 'LORs fetched successfully',
      count: enriched.length,
      lors: enriched
    });

  } catch (err) {
    logger.error('Error fetching all LORs', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});


router.get('/open-lors', jwtAuth.verifyToken, async (req, res) => {
  try {
    const [lors] = await db.query(
      `SELECT * FROM lor_data WHERE order_ID IS NULL ORDER BY lor_id DESC`
    );

    if (!lors.length) {
      return res.status(200).json({
        message: 'No open LORs found',
        lors: []
      });
    }

    // ✅ SAFE parsing
    const allPackIDs = lors.flatMap(l =>
      safeParsePackages(l.packages)
    );

    let packageMap = {};
    if (allPackIDs.length) {
      const [pkgs] = await db.query(
        `SELECT * FROM packages WHERE pack_ID IN (?)`,
        [allPackIDs]
      );

      pkgs.forEach(p => {
        packageMap[p.pack_ID] = p;
      });
    }

    const enriched = lors.map(lor => ({
      ...lor,
      packages: safeParsePackages(lor.packages)
        .map(id => packageMap[id])
        .filter(Boolean)
    }));

    return res.status(200).json({
      message: 'Open LORs fetched successfully',
      count: enriched.length,
      lors: enriched
    });

  } catch (err) {
    logger.error('Error fetching open LORs', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});


router.get('/ready-lors', jwtAuth.verifyToken, async (req, res) => {
  try {
    // 1️⃣ Fetch only LORs with no order yet
    const [lors] = await db.query(
      `SELECT * FROM lor_data 
       WHERE order_ID IS NULL 
       ORDER BY lor_id DESC`
    );

    if (!lors.length) {
      return res.status(200).json({
        message: 'No ready LORs found',
        lors: []
      });
    }

    // 2️⃣ Filter LORs that actually have packages
    const readyLors = lors.filter(lor =>
      safeParsePackages(lor.packages).length > 0
    );

    if (!readyLors.length) {
      return res.status(200).json({
        message: 'No LORs with packages available',
        lors: []
      });
    }

    // 3️⃣ Collect all package IDs
    const allPackIDs = readyLors.flatMap(l =>
      safeParsePackages(l.packages)
    );

    // 4️⃣ Fetch package data
    let packageMap = {};
    if (allPackIDs.length) {
      const [pkgs] = await db.query(
        `SELECT * FROM packages WHERE pack_ID IN (?)`,
        [allPackIDs]
      );

      pkgs.forEach(pkg => {
        packageMap[pkg.pack_ID] = pkg;
      });
    }

    // 5️⃣ Attach packages to each LOR
    const enriched = readyLors.map(lor => ({
      ...lor,
      packages: safeParsePackages(lor.packages)
        .map(id => packageMap[id])
        .filter(Boolean)
    }));

    return res.status(200).json({
      message: 'Ready LORs fetched successfully',
      count: enriched.length,
      lors: enriched
    });

  } catch (err) {
    logger.error('Error fetching ready LORs', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});




router.get('/lor-packages', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { lor_num } = req.query;

    if (!lor_num) {
      return res.status(400).json({
        message: 'lor_num is required in query'
      });
    }

    const [[lor]] = await db.query(
      `SELECT * FROM lor_data WHERE lor_num = ?`,
      [lor_num]
    );

    if (!lor) {
      return res.status(404).json({
        message: 'LOR not found'
      });
    }

    // ✅ SAFE parsing
    const packIDs = safeParsePackages(lor.packages);

    if (!packIDs.length) {
      return res.status(200).json({
        message: 'No packages attached to this LOR',
        lor_num,
        order_ID: lor.order_ID,
        packages: []
      });
    }

    const [packages] = await db.query(
      `SELECT * FROM packages WHERE pack_ID IN (?)`,
      [packIDs]
    );

    return res.status(200).json({
      message: 'Packages fetched successfully',
      lor_num,
      order_ID: lor.order_ID,
      count: packages.length,
      packages
    });

  } catch (err) {
    logger.error('Error fetching LOR packages', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});




module.exports = router;
