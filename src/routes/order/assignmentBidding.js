// const express = require('express');
// const router = express.Router();
// const db = require('../../../dbConnection');
// const { logger } = require('../../logger/logger');
// const { applyPagination } = require('../../pagination/paginate');
// const jwtAuth = require('../../JWT/jwtAuth');


// router.post('/initiate-open-bidding', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const {
//             order_ID,
//             bid_value,
//             bid_timing,
//             bid_start_time
//         } = req.body;

//         if (!order_ID || !bid_value || !bid_timing || !bid_start_time) {
//             return res.status(400).json({ message: 'Missing required fields: order_ID, bid_value, bid_timing, bid_start_time' });
//         }

//         // Check if order exists
//         const [orderCheck] = await db.query(`SELECT order_ID FROM orders WHERE order_ID = ?`, [order_ID]);
//         if (!orderCheck.length) {
//             return res.status(404).json({ message: 'Order not found.' });
//         }

//         // Get all carrier_IDs from carriers table (irrespective of contract)
//         const [carriers] = await db.query(`SELECT carrier_ID FROM carriers`);
//         const carrierIDs = carriers.map(c => c.carrier_ID);

//         if (!carrierIDs.length) {
//             return res.status(400).json({ message: 'No carriers found to send bidding request.' });
//         }

//         // Insert into assignment_bidding table
//         await db.query(`
//             INSERT INTO assignment_bidding 
//             (order_ID, bid_value, bid_timing, bid_reqs, bid_start_time) 
//             VALUES (?, ?, ?, ?, ?)
//         `, [
//             order_ID,
//             bid_value,
//             bid_timing,
//             JSON.stringify(carrierIDs),
//             bid_start_time
//         ]);

//          await db.query(
//                     `UPDATE orders SET order_status = 'open bidding' WHERE order_ID = ?`,
//                     [order_ID]
//                   );

//         res.status(201).json({
//             message: 'Open bidding initiated successfully.',
//             order_ID,
//             sent_to_carriers: carrierIDs.length,
//             carriers: carrierIDs
//         });
//     } catch (error) {
//         logger.error('Error initiating open bidding:', error);
//         res.status(500).json({ message: 'Internal Server Error', error: error.message });
//     }
// });


// router.get('/active-bids', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { carrier_ID } = req.query;

//         if (!carrier_ID) {
//             return res.status(400).json({ message: 'carrier_ID is required in query.' });
//         }

//         const [results] = await db.query(`
//             SELECT ab.*, o.*
//             FROM assignment_bidding ab
//             JOIN orders o ON ab.order_ID = o.order_ID
//             WHERE ab.bid_end_time IS NULL
//               AND JSON_CONTAINS(ab.bid_reqs, JSON_QUOTE(?))
//         `, [carrier_ID]);

//         if (!results.length) {
//             return res.status(404).json({ message: 'No active bids found for this carrier.' });
//         }

//         // 🧼 Filter out sensitive/internal fields
//         const filteredResults = results.map(row => {
//             const {
//                 bid_reqs,
//                 total_cost,
//                 all_bids,
//                 finalised_bid,
//                 ...rest
//             } = row;
//             return rest;
//         });

//         res.status(200).json({
//             message: 'Active bids fetched successfully.',
//             data: filteredResults
//         });

//     } catch (error) {
//         logger.error('Error fetching active bids for carrier:', error);
//         res.status(500).json({ message: 'Internal Server Error', error: error.message });
//     }
// });


// router.post('/place-bid', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { bid_id, order_ID } = req.query;
//         const { bid_amount, bid_from, bid_placed_at } = req.body;

//         if (!bid_id || !order_ID) {
//             return res.status(400).json({ message: "bid_id and order_ID are required in query." });
//         }

//         if (!bid_amount || !bid_from || !bid_placed_at) {
//             return res.status(400).json({ message: "bid_amount, bid_from (carrier_ID), and bid_placed_at are required in body." });
//         }

//         const [bids] = await db.query(`
//             SELECT all_bids, bid_end_time FROM assignment_bidding 
//             WHERE bid_id = ? AND order_ID = ?
//         `, [bid_id, order_ID]);

//         if (!bids.length) {
//             return res.status(404).json({ message: "No active bid found for this order." });
//         }

//         const { all_bids, bid_end_time } = bids[0];

//         if (bid_end_time) {
//             return res.status(403).json({ message: "Bidding time is over for this order." });
//         }

//         let existingBids = [];
//         if (typeof all_bids === 'string' && all_bids.trim() !== '') {
//             try {
//                 existingBids = JSON.parse(all_bids);
//             } catch (e) {
//                 return res.status(500).json({ message: "Stored bid data is corrupted." });
//             }
//         } else if (Array.isArray(all_bids)) {
//             existingBids = all_bids;
//         }

//         const alreadyBid = existingBids.some(bid => bid.bid_from === bid_from);
//         if (alreadyBid) {
//             return res.status(400).json({ message: "Carrier has already placed a bid for this order." });
//         }

//         const newBid = {
//             bid_amount,
//             bid_from,
//             bid_placed_at
//         };
//         existingBids.push(newBid);

//         await db.query(`
//             UPDATE assignment_bidding SET all_bids = ? WHERE bid_id = ? AND order_ID = ?
//         `, [JSON.stringify(existingBids), bid_id, order_ID]);

//         res.status(200).json({
//             message: "Bid placed successfully.",
//             bid: newBid
//         });

//     } catch (error) {
//         logger.error("Error placing bid:", error);
//         res.status(500).json({ message: "Internal Server Error", error: error.message });
//     }
// });



// router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { carrier_ID } = req.query;

//         if (!carrier_ID) {
//             return res.status(400).json({ message: 'carrier_ID is required in query.' });
//         }

//         const [results] = await db.query(`
//             SELECT ab.*, o.*
//             FROM assignment_bidding ab
//             JOIN orders o ON ab.order_ID = o.order_ID
//             WHERE JSON_CONTAINS(ab.all_bids, JSON_OBJECT('bid_from', ?))
//         `, [carrier_ID]);

//         if (!results.length) {
//             return res.status(404).json({ message: 'No bids found placed by this carrier.' });
//         }

//         const filteredResults = results.map(row => {
//             const {
//                 bid_reqs,
//                 finalised_bid,
//                 ...rest
//             } = row;
//             return rest;
//         });

//         res.status(200).json({
//             message: 'Carrier participation bids fetched successfully.',
//             carrier_ID,
//             data: filteredResults
//         });

//     } catch (error) {
//         logger.error('Error fetching carrier bids:', error);
//         res.status(500).json({ message: 'Internal Server Error', error: error.message });
//     }
// });



// // router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
// //     try {
// //         const { carrier_ID } = req.query;

// //         if (!carrier_ID) {
// //             return res.status(400).json({ message: 'carrier_ID is required in query.' });
// //         }

// //         const [results] = await db.query(`
// //             SELECT ab.*, o.*
// //             FROM assignment_bidding ab
// //             JOIN orders o ON ab.order_ID = o.order_ID
// //             WHERE JSON_CONTAINS(ab.all_bids, JSON_OBJECT('bid_from', ?))
// //         `, [carrier_ID]);

// //         if (!results.length) {
// //             return res.status(404).json({ message: 'No bids found placed by this carrier.' });
// //         }

// //         const filteredResults = results.map(row => {
// //             const {
// //                 bid_reqs,
// //                 finalised_bid,
// //                 ...rest
// //             } = row;
// //             return rest;
// //         });

// //         res.status(200).json({
// //             message: 'Carrier participation bids fetched successfully.',
// //             carrier_ID,
// //             data: filteredResults
// //         });

// //     } catch (error) {
// //         logger.error('Error fetching carrier bids:', error);
// //         res.status(500).json({ message: 'Internal Server Error', error: error.message });
// //     }
// // });


// router.get('/bids-order-id', jwtAuth.verifyToken, async (req, res) => {
//     try {
//       const { order_ID } = req.query;
  
//       if (!order_ID) {
//         return res.status(400).json({ message: 'order_ID is required in query.' });
//       }
  
//       const [results] = await db.query(`
//         SELECT * FROM assignment_bidding WHERE order_ID = ?
//       `, [order_ID]);
  
//       if (!results.length) {
//         return res.status(404).json({ message: 'No data found for the given order_ID.' });
//       }
  
//       res.status(200).json({
//         message: 'Data fetched successfully.',
//         data: results
//       });
  
//     } catch (error) {
//       logger.error('Error fetching assigning_orders:', error);
//       res.status(500).json({ message: 'Internal Server Error', error: error.message });
//     }
//   });
  


// router.get('/finalised-bids', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { carrier_ID } = req.query;

//         if (!carrier_ID) {
//             return res.status(400).json({ message: 'carrier_ID is required in query.' });
//         }

//         const [results] = await db.query(`
//             SELECT ab.*, o.*
//             FROM assignment_bidding ab
//             JOIN orders o ON ab.order_ID = o.order_ID
//             WHERE JSON_EXTRACT(ab.finalised_bid, '$.finalised_for') = ?
//         `, [carrier_ID]);

//         if (!results.length) {
//             return res.status(404).json({ message: 'No finalized bids found for this carrier.' });
//         }

//         const cleanedResults = results.map(row => {
//             const {
//                 bid_reqs,
//                 all_bids,
//                 ...rest
//             } = row;
//             return rest;
//         });

//         res.status(200).json({
//             message: 'Finalised bids fetched successfully.',
//             carrier_ID,
//             data: cleanedResults
//         });

//     } catch (error) {
//         logger.error('Error fetching finalised bids for carrier:', error);
//         res.status(500).json({ message: 'Internal Server Error', error: error.message });
//     }
// });




// module.exports = router;


const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

/* ------------ helpers ------------ */
function parseJSONSafe(val, fallback) {
  if (val == null) return fallback;
  if (Array.isArray(val) || typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
function nowISO() { return new Date().toISOString(); }
function isBeforeNow(ts) {
  if (!ts) return false;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n < Date.now() : false;
}
function isAfterNow(ts) {
  if (!ts) return false;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n > Date.now() : false;
}
async function getLatestNonCancelledBid(order_ID) {
  const [rows] = await db.query(`
    SELECT * FROM assignment_bidding
    WHERE order_ID = ?
      AND (bid_status IS NULL OR bid_status <> 'cancelled')
    ORDER BY bid_id DESC
    LIMIT 1
  `, [order_ID]);
  return rows[0];
}

/* =========================================================
   Create (initiate) open bidding
   - sets bid_status='open'
   - uses bid_closing_time (renamed from bid_timing)
   ========================================================= */
router.post('/initiate-open-bidding', jwtAuth.verifyToken, async (req, res) => {
  try {
    const {
      order_ID,
      bid_value,
      bid_start_time,
      bid_closing_time
    } = req.body;

    if (!order_ID || !bid_value || !bid_start_time || !bid_closing_time) {
      return res.status(400).json({ message: 'Missing required fields: order_ID, bid_value, bid_start_time, bid_closing_time' });
    }

    const [orderCheck] = await db.query(`SELECT order_ID FROM orders WHERE order_ID = ?`, [order_ID]);
    if (!orderCheck.length) return res.status(404).json({ message: 'Order not found.' });

    const [carriers] = await db.query(`SELECT carrier_ID FROM carriers`);
    const carrierIDs = carriers.map(c => c.carrier_ID);
    if (!carrierIDs.length) return res.status(400).json({ message: 'No carriers found to send bidding request.' });

    await db.query(`
      INSERT INTO assignment_bidding
        (order_ID, bid_value, bid_closing_time, bid_reqs, bid_start_time, bid_status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `, [
      order_ID,
      bid_value,
      bid_closing_time,
      JSON.stringify(carrierIDs),
      bid_start_time
    ]);

    await db.query(`UPDATE orders SET order_status = 'open bidding' WHERE order_ID = ?`, [order_ID]);

    res.status(201).json({
      message: 'Open bidding initiated successfully.',
      order_ID,
      sent_to_carriers: carrierIDs.length,
      carriers: carrierIDs
    });
  } catch (error) {
    logger.error('Error initiating open bidding:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

/* =========================================================
   Active bids for a carrier
   - exclude cancelled & closed/finalised
   - must not be ended and must be within bid_closing_time
   ========================================================= */



// router.get('/active-bids', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { carrier_ID } = req.query;
//     if (!carrier_ID) return res.status(400).json({ message: 'carrier_ID is required in query.' });

//     const [results] = await db.query(`
//       SELECT ab.*, o.*
//       FROM assignment_bidding ab
//       JOIN orders o ON ab.order_ID = o.order_ID
//       WHERE ab.bid_end_time IS NULL
//         AND ab.bid_status = 'open'
//         AND JSON_CONTAINS(ab.bid_reqs, JSON_QUOTE(?))
//     `, [carrier_ID]);

//     const filtered = results.filter(row => {
//       const closing = row.bid_closing_time;
//       return !closing || isAfterNow(closing);
//     });

//     if (!filtered.length) return res.status(404).json({ message: 'No active bids found for this carrier.' });

//     const cleaned = filtered.map(row => {
//       const { bid_reqs, total_cost, all_bids, finalised_bid, ...rest } = row;
//       return rest;
//     });

//     res.status(200).json({ message: 'Active bids fetched successfully.', data: cleaned });
//   } catch (error) {
//     logger.error('Error fetching active bids for carrier:', error);
//     res.status(500).json({ message: 'Internal Server Error', error: error.message });
//   }
// });


router.get('/active-bids', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { carrier_ID } = req.query;
    if (!carrier_ID) {
      return res.status(400).json({ message: 'carrier_ID is required in query.' });
    }

    // --- helpers ---
    const parseJSON = (v, def = null) => {
      if (v == null) return def;
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return def; }
    };

    // bid_closing_time can be ISO or like "15 mins"
    const closingAsDate = (row) => {
      const raw = row.bid_closing_time;
      if (!raw) return null;

      // "N mins" pattern -> start + N minutes
      const m = String(raw).match(/^\s*(\d+)\s*min/i);
      if (m) {
        const mins = parseInt(m[1], 10);
        const start = row.bid_start_time ? new Date(row.bid_start_time) : null;
        if (!start || Number.isNaN(start.getTime())) return null;
        return new Date(start.getTime() + mins * 60 * 1000);
      }

      // ISO-ish
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const isActiveNow = (row) => {
      if (String(row.bid_status || '').toLowerCase() !== 'open') return false;
      const closeAt = closingAsDate(row);
      // If we can't parse closing, treat as active; otherwise require now < closeAt
      const stillOpenByTime = !closeAt || Date.now() < closeAt.getTime();
      // Ignore rows that have a terminal end timestamp
      const ended = row.bid_end_time && !Number.isNaN(new Date(row.bid_end_time).getTime());
      return stillOpenByTime && !ended;
    };

    const redactAllBids = (all_bids, carrierId) => {
      const arr = parseJSON(all_bids, []);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const mine = arr.filter(b => String(b.bid_from) === String(carrierId));
      return mine.length ? mine : null; // only my bids; null if I haven't bid yet
    };

    // --- query ---
    // Keep the join; let code decide "active" so we handle both ISO and "N mins"
    const [rows] = await db.query(
      `
      SELECT ab.*, o.*
        FROM assignment_bidding ab
        JOIN orders o ON ab.order_ID = o.order_ID
       WHERE JSON_CONTAINS(ab.bid_reqs, JSON_QUOTE(?), '$')
      `,
      [carrier_ID]
    );

    // Filter to active right now
    const active = rows.filter(isActiveNow);
    if (!active.length) {
      return res.status(404).json({ message: 'No active bids found for this carrier.' });
    }

    // Shape + redact
    const data = active.map(row => {
      // Return everything, but transform JSON fields and redact all_bids
      const bid_reqs = parseJSON(row.bid_reqs, []);
      const finalised_bid = parseJSON(row.finalised_bid, null);
      const all_bids = redactAllBids(row.all_bids, carrier_ID);

      return {
        ...row,
        bid_reqs,
        finalised_bid,
        all_bids
      };
    });

    return res.status(200).json({
      message: 'Active bids fetched successfully.',
      data
    });
  } catch (error) {
    logger.error('Error fetching active bids for carrier:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});


/* =========================================================
   Place bid
   - only when bid_status='open', not ended, window not closed
   ========================================================= */
router.post('/place-bid', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { bid_id, order_ID } = req.query;
    const { bid_amount, bid_from, bid_placed_at } = req.body;

    if (!bid_id || !order_ID) {
      return res.status(400).json({ message: "bid_id and order_ID are required in query." });
    }
    if (!bid_amount || !bid_from || !bid_placed_at) {
      return res.status(400).json({ message: "bid_amount, bid_from (carrier_ID), and bid_placed_at are required in body." });
    }

    const [rows] = await db.query(`
      SELECT all_bids, bid_end_time, bid_closing_time, bid_status
      FROM assignment_bidding
      WHERE bid_id = ? AND order_ID = ?
    `, [bid_id, order_ID]);
    if (!rows.length) return res.status(404).json({ message: "No active bid found for this order." });

    const { all_bids, bid_end_time, bid_closing_time, bid_status } = rows[0];

    if (bid_status !== 'open') {
      return res.status(403).json({ message: "Bidding is not open for this order." });
    }
    if (bid_end_time) return res.status(403).json({ message: "Bidding time is over for this order." });
    if (bid_closing_time && isBeforeNow(bid_closing_time)) {
      return res.status(403).json({ message: "Bidding window has closed." });
    }

    const existingBids = parseJSONSafe(all_bids, []);
    if (existingBids.some(b => b.bid_from === bid_from)) {
      return res.status(400).json({ message: "Carrier has already placed a bid for this order." });
    }

    const newBid = { bid_amount, bid_from, bid_placed_at };
    existingBids.push(newBid);

    await db.query(`
      UPDATE assignment_bidding SET all_bids = ? WHERE bid_id = ? AND order_ID = ?
    `, [JSON.stringify(existingBids), bid_id, order_ID]);

    res.status(200).json({ message: "Bid placed successfully.", bid: newBid });
  } catch (error) {
    logger.error("Error placing bid:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

/* =========================================================
   Carrier participation bids (history)
   ========================================================= */


// router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
//   try {
//     const { carrier_ID } = req.query;
//     if (!carrier_ID) return res.status(400).json({ message: 'carrier_ID is required in query.' });

//     const [results] = await db.query(`
//       SELECT ab.*, o.*
//       FROM assignment_bidding ab
//       JOIN orders o ON ab.order_ID = o.order_ID
//       WHERE JSON_CONTAINS(ab.all_bids, JSON_OBJECT('bid_from', ?))
//     `, [carrier_ID]);
//     if (!results.length) return res.status(404).json({ message: 'No bids found placed by this carrier.' });

//     const cleaned = results.map(row => {
//       const { bid_reqs, finalised_bid, ...rest } = row;
//       return rest;
//     });

//     res.status(200).json({
//       message: 'Carrier participation bids fetched successfully.',
//       carrier_ID,
//       data: cleaned
//     });
//   } catch (error) {
//     logger.error('Error fetching carrier bids:', error);
//     res.status(500).json({ message: 'Internal Server Error', error: error.message });
//   }
// });


// Get ALL bids that involve this carrier (invited or bidding), regardless of status
router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { carrier_ID } = req.query;
    if (!carrier_ID) {
      return res.status(400).json({ message: 'carrier_ID is required in query.' });
    }

    // helpers
    const parseJSON = (v, def = null) => {
      if (v == null) return def;
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return def; }
    };

    const redactAllBids = (all_bids, carrierId) => {
      const arr = parseJSON(all_bids, []);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const mine = arr.filter(b => String(b.bid_from) === String(carrierId));
      return mine.length ? mine : null; // don't leak others; null if they haven't bid yet
    };

    // NOTE: we are NOT filtering by status/time here (open/closed/finalised/cancelled all included)
    const [rows] = await db.query(
      `
      SELECT ab.*, o.*
        FROM assignment_bidding ab
        JOIN orders o ON ab.order_ID = o.order_ID
       WHERE JSON_CONTAINS(ab.bid_reqs, JSON_QUOTE(?), '$')
      `,
      [carrier_ID]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'No bids found for this carrier.' });
    }

    const data = rows.map(row => {
      const bid_reqs     = parseJSON(row.bid_reqs, []);
      const finalised_bid= parseJSON(row.finalised_bid, null);
      const all_bids     = redactAllBids(row.all_bids, carrier_ID);

      return {
        ...row,
        bid_reqs,
        finalised_bid,
        all_bids
      };
    });

    // (Optional) sort newest first; comment out if you want DB-order
    data.sort((a, b) => {
      const at = new Date(a.bid_start_time).getTime() || 0;
      const bt = new Date(b.bid_start_time).getTime() || 0;
      return bt - at;
    });

    return res.status(200).json({
      message: 'Carrier bids fetched successfully.',
      data
    });
  } catch (error) {
    logger.error('Error fetching bids for carrier:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

/* =========================================================
   Bids by order_ID
   - ignore cancelled when multiple rows exist
   ========================================================= */
router.get('/bids-order-id', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    if (!order_ID) return res.status(400).json({ message: 'order_ID is required in query.' });

    const [results] = await db.query(`
      SELECT * FROM assignment_bidding
      WHERE order_ID = ?
        AND (bid_status IS NULL OR bid_status <> 'cancelled')
      ORDER BY bid_id DESC
    `, [order_ID]);
    if (!results.length) return res.status(404).json({ message: 'No data found for the given order_ID.' });

    res.status(200).json({ message: 'Data fetched successfully.', data: results });
  } catch (error) {
    logger.error('Error fetching assigning_orders:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

/* =========================================================
   Finalised bids for a carrier
   - treat 'closed' as finalised (keep 'finalised' for back-compat)
   ========================================================= */
router.get('/finalised-bids', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { carrier_ID } = req.query;
    if (!carrier_ID) return res.status(400).json({ message: 'carrier_ID is required in query.' });

    const [results] = await db.query(`
      SELECT ab.*, o.*
      FROM assignment_bidding ab
      JOIN orders o ON ab.order_ID = o.order_ID
      WHERE JSON_EXTRACT(ab.finalised_bid, '$.finalised_for') = ?
        AND ab.bid_status IN ('closed','finalised')
    `, [carrier_ID]);
    if (!results.length) return res.status(404).json({ message: 'No finalised bids found for this carrier.' });

    const cleaned = results.map(row => {
      const { bid_reqs, all_bids, ...rest } = row;
      return rest;
    });

    res.status(200).json({
      message: 'Finalised bids fetched successfully.',
      carrier_ID,
      data: cleaned
    });
  } catch (error) {
    logger.error('Error fetching finalised bids for carrier:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

router.put('/edit-bid', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    if (!order_ID) {
      return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
    }

    // Always work on the latest non-cancelled bid row for this order
    const row = await getLatestNonCancelledBid(order_ID);
    if (!row) {
      return res.status(404).json({ message: 'Bidding row not found for order_ID.' });
    }
    if (row.bid_status !== 'open') {
      return res.status(403).json({ message: 'Only open bids can be edited.' });
    }
    if (row.bid_end_time) {
      return res.status(403).json({ message: 'Bidding already ended.' });
    }

    const {
      bid_start_time,
      bid_closing_time,
      bid_reqs,
      // NEW: allow bid_value update here (with strict checks)
      bid_value
    } = req.body;

    const updateFields = [];
    const values = [];
    const changed = {};

    // Update bid_start_time (no special constraint beyond "open + not ended")
    if (typeof bid_start_time !== 'undefined') {
      updateFields.push('bid_start_time = ?');
      values.push(bid_start_time);
      changed.bid_start_time = bid_start_time;
    }

    // Update bid_closing_time — cannot be set in the past
    if (typeof bid_closing_time !== 'undefined') {
      if (isBeforeNow(bid_closing_time)) {
        return res.status(400).json({ message: 'bid_closing_time cannot be in the past.' });
      }
      updateFields.push('bid_closing_time = ?');
      values.push(bid_closing_time);
      changed.bid_closing_time = bid_closing_time;
    }

    // Update bid_reqs (array of carrier_IDs)
    if (typeof bid_reqs !== 'undefined') {
      updateFields.push('bid_reqs = ?');
      values.push(JSON.stringify(bid_reqs));
      changed.bid_reqs = bid_reqs;
    }

    // Update bid_value — allowed only if:
    //  - bid_status is 'open' (already checked)
    //  - bidding not ended (already checked)
    //  - bid_closing_time not passed
    //  - NO bids placed yet (all_bids empty or null)
    if (typeof bid_value !== 'undefined') {
      if (bid_value === null || bid_value === '') {
        return res.status(400).json({ message: 'bid_value cannot be empty.' });
      }
      if (row.bid_closing_time && isBeforeNow(row.bid_closing_time)) {
        return res.status(403).json({ message: 'Cannot update bid_value: bidding window is closed.' });
      }
      const existing = parseJSONSafe(row.all_bids, []);
      if (Array.isArray(existing) && existing.length > 0) {
        return res.status(400).json({ message: 'Cannot update bid_value: one or more bids already placed.' });
      }

      updateFields.push('bid_value = ?');
      values.push(bid_value);
      changed.bid_value = bid_value;
    }

    if (!updateFields.length) {
      return res.status(400).json({ message: 'No fields provided for update.' });
    }

    values.push(row.bid_id, order_ID);
    const q = `UPDATE assignment_bidding SET ${updateFields.join(', ')} WHERE bid_id = ? AND order_ID = ?`;
    await db.query(q, values);

    return res.status(200).json({
      message: 'Bid updated successfully.',
      order_ID,
      bid_id: row.bid_id,
      updated: changed
    });
  } catch (error) {
    logger.error('Error updating bid:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});


/* =========================================================
   POST /cancel-bid
   - Body: { order_ID }
   - Only when bid_status='open'
   - Sets bid_status='cancelled', bid_end_time=now
   - Updates orders.order_status='assignment pending'
   ========================================================= */
router.post('/cancel-bid', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    if (!order_ID) return res.status(400).json({ message: 'order_ID is required in query.' });

    const row = await getLatestNonCancelledBid(order_ID);
    if (!row) return res.status(404).json({ message: 'Bidding row not found for order_ID.' });

    if (row.bid_end_time) return res.status(409).json({ message: 'Bidding already ended.' });
    if (row.bid_status !== 'open') return res.status(409).json({ message: `Bidding already ${row.bid_status}.` });

    await db.query(`
      UPDATE assignment_bidding
      SET bid_status = 'cancelled', bid_end_time = ?, finalised_bid = NULL
      WHERE bid_id = ? AND order_ID = ?
    `, [nowISO(), row.bid_id, order_ID]);

    await db.query(`UPDATE orders SET order_status = 'assignment pending' WHERE order_ID = ?`, [order_ID]);

    return res.status(200).json({
      message: 'Bid cancelled successfully.',
      order_ID,
      bid_id: row.bid_id,
      bid_status: 'cancelled'
    });
  } catch (error) {
    logger.error('Error cancelling bid:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

/* =========================================================
   POST /close-bid  (auto-finalise lowest bid)
   - Body: { order_ID }
   - Only when bid_status='open'
   - Picks lowest bid from all_bids; tie-break: earliest bid_placed_at
   - Sets bid_status='closed', finalised_bid JSON, bid_end_time=now
   - Updates orders.order_status='bidding finalised'
   ========================================================= */
router.post('/close-bid', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.body;
    if (!order_ID) return res.status(400).json({ message: 'order_ID is required in body.' });

    const row = await getLatestNonCancelledBid(order_ID);
    if (!row) return res.status(404).json({ message: 'Bidding row not found for order_ID.' });

    if (row.bid_end_time) return res.status(409).json({ message: 'Bidding already ended.' });
    if (row.bid_status !== 'open') return res.status(409).json({ message: `Bidding already ${row.bid_status}.` });

    const bids = parseJSONSafe(row.all_bids, []);
    if (!Array.isArray(bids) || bids.length === 0) {
      return res.status(400).json({ message: 'No bids available to close.' });
    }

    // choose lowest; tie-break: earliest bid_placed_at
    let lowest = null;
    for (const b of bids) {
      const amt = Number(b.bid_amount);
      if (!Number.isFinite(amt)) continue;
      if (!lowest || amt < lowest._amt ||
         (amt === lowest._amt && Date.parse(b.bid_placed_at || '') < Date.parse(lowest.bid_placed_at || ''))) {
        lowest = { ...b, _amt: amt };
      }
    }
    if (!lowest) return res.status(400).json({ message: 'No valid numeric bids to close.' });

    const finalisedObj = { finalised_bid: String(lowest._amt), finalised_for: lowest.bid_from };

    await db.query(`
      UPDATE assignment_bidding
      SET bid_status = 'closed', bid_end_time = ?, finalised_bid = ?
      WHERE bid_id = ? AND order_ID = ?
    `, [nowISO(), JSON.stringify(finalisedObj), row.bid_id, order_ID]);

    await db.query(`UPDATE orders SET order_status = 'bidding finalised' WHERE order_ID = ?`, [order_ID]);

    return res.status(200).json({
      message: 'Bid closed successfully.',
      order_ID,
      bid_id: row.bid_id,
      bid_status: 'closed',
      finalised: finalisedObj
    });
  } catch (error) {
    logger.error('Error closing bid:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

module.exports = router;
