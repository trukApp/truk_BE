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
   - exclude cancelled & finalised
   - must not be ended and must be within bid_closing_time
   ========================================================= */
router.get('/active-bids', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { carrier_ID } = req.query;
    if (!carrier_ID) return res.status(400).json({ message: 'carrier_ID is required in query.' });

    const [results] = await db.query(`
      SELECT ab.*, o.*
      FROM assignment_bidding ab
      JOIN orders o ON ab.order_ID = o.order_ID
      WHERE ab.bid_end_time IS NULL
        AND ab.bid_status = 'open'
        AND JSON_CONTAINS(ab.bid_reqs, JSON_QUOTE(?))
    `, [carrier_ID]);

    const filtered = results.filter(row => {
      const closing = row.bid_closing_time;
      return !closing || isAfterNow(closing);
    });

    if (!filtered.length) return res.status(404).json({ message: 'No active bids found for this carrier.' });

    const cleaned = filtered.map(row => {
      const { bid_reqs, total_cost, all_bids, finalised_bid, ...rest } = row;
      return rest;
    });

    res.status(200).json({ message: 'Active bids fetched successfully.', data: cleaned });
  } catch (error) {
    logger.error('Error fetching active bids for carrier:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
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
router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { carrier_ID } = req.query;
    if (!carrier_ID) return res.status(400).json({ message: 'carrier_ID is required in query.' });

    const [results] = await db.query(`
      SELECT ab.*, o.*
      FROM assignment_bidding ab
      JOIN orders o ON ab.order_ID = o.order_ID
      WHERE JSON_CONTAINS(ab.all_bids, JSON_OBJECT('bid_from', ?))
    `, [carrier_ID]);
    if (!results.length) return res.status(404).json({ message: 'No bids found placed by this carrier.' });

    const cleaned = results.map(row => {
      const { bid_reqs, finalised_bid, ...rest } = row;
      return rest;
    });

    res.status(200).json({
      message: 'Carrier participation bids fetched successfully.',
      carrier_ID,
      data: cleaned
    });
  } catch (error) {
    logger.error('Error fetching carrier bids:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
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
   - ensure bid_status='finalised'
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
        AND ab.bid_status = 'finalised'
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

/* =========================================================
   PUT /edit-bid  (no bid_value here)
   - Query: order_ID
   - Allowed: bid_start_time, bid_closing_time, bid_reqs
   - Only when bid_status='open'
   ========================================================= */
router.put('/edit-bid', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    if (!order_ID) return res.status(400).json({ message: 'Missing required query parameter: order_ID' });

    const row = await getLatestNonCancelledBid(order_ID);
    if (!row) return res.status(404).json({ message: 'Bidding row not found for order_ID.' });
    if (row.bid_status !== 'open') return res.status(403).json({ message: 'Only open bids can be edited.' });
    if (row.bid_end_time) return res.status(403).json({ message: 'Bidding already ended.' });

    const { bid_start_time, bid_closing_time, bid_reqs } = req.body;

    const updateFields = [];
    const values = [];

    if (bid_start_time) {
      updateFields.push('bid_start_time = ?');
      values.push(bid_start_time);
    }
    if (bid_closing_time) {
      if (isBeforeNow(bid_closing_time)) {
        return res.status(400).json({ message: 'bid_closing_time cannot be in the past.' });
      }
      updateFields.push('bid_closing_time = ?');
      values.push(bid_closing_time);
    }
    if (bid_reqs) {
      updateFields.push('bid_reqs = ?');
      values.push(JSON.stringify(bid_reqs));
    }

    if (!updateFields.length) return res.status(400).json({ message: 'No fields provided for update.' });

    values.push(row.bid_id, order_ID);
    const q = `UPDATE assignment_bidding SET ${updateFields.join(', ')} WHERE bid_id = ? AND order_ID = ?`;
    await db.query(q, values);

    return res.status(200).json({ message: 'Bid updated successfully.', order_ID, bid_id: row.bid_id });
  } catch (error) {
    logger.error('Error updating bid:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

/* =========================================================
   PUT /update-bid-value
   - Only when bid_status='open', not ended, window not closed
   - Only if no bids yet
   ========================================================= */
router.put('/update-bid-value', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID } = req.query;
    const { bid_value } = req.body;

    if (!order_ID) return res.status(400).json({ message: 'Missing required query parameter: order_ID' });
    if (!bid_value) return res.status(400).json({ message: 'bid_value is required in body.' });

    const row = await getLatestNonCancelledBid(order_ID);
    if (!row) return res.status(404).json({ message: 'Bidding row not found for order_ID.' });

    const { bid_id, all_bids, bid_end_time, bid_closing_time, bid_status } = row;

    if (bid_status !== 'open') return res.status(403).json({ message: 'Cannot update bid_value on non-open bids.' });
    if (bid_end_time) return res.status(403).json({ message: 'Cannot update bid_value after bidding has ended.' });
    if (bid_closing_time && isBeforeNow(bid_closing_time)) {
      return res.status(403).json({ message: 'Cannot update bid_value: bidding window is closed.' });
    }

    const bids = parseJSONSafe(all_bids, []);
    if (Array.isArray(bids) && bids.length > 0) {
      return res.status(400).json({ message: 'Cannot update bid_value: one or more bids already placed.' });
    }

    await db.query(`UPDATE assignment_bidding SET bid_value = ? WHERE bid_id = ? AND order_ID = ?`,
      [bid_value, bid_id, order_ID]);

    return res.status(200).json({ message: 'bid_value updated successfully.', order_ID, bid_id, bid_value });
  } catch (error) {
    logger.error('Error updating bid_value:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

/* =========================================================
   POST /close-bid   (Cancel OR Finalise)
   Body:
     - order_ID (required)
     - bid_status: 'cancelled' OR 'finalised' (required)
     - If finalising: finalised_for (carrier_ID), finalised_bid (string/number)
     - If cancelling only: finalised_bid should be null (ignored)
   Effects:
     - Sets bid_end_time = now
     - Updates bid_status accordingly
     - Updates orders.order_status accordingly
   ========================================================= */
router.post('/close-bid', jwtAuth.verifyToken, async (req, res) => {
  try {
    const { order_ID, bid_status, finalised_for, finalised_bid } = req.body;

    if (!order_ID || !bid_status) {
      return res.status(400).json({ message: 'order_ID and bid_status are required in body.' });
    }
    if (!['cancelled', 'finalised'].includes(bid_status)) {
      return res.status(400).json({ message: "bid_status must be either 'cancelled' or 'finalised'." });
    }

    const row = await getLatestNonCancelledBid(order_ID);
    if (!row) return res.status(404).json({ message: 'Bidding row not found for order_ID.' });

    if (row.bid_end_time) {
      return res.status(409).json({ message: 'Bidding already ended.' });
    }
    if (row.bid_status !== 'open') {
      // if it’s already cancelled/finalised, getLatestNonCancelledBid would have skipped cancelled,
      // finalised will still be returned, so block here:
      return res.status(409).json({ message: `Bidding already ${row.bid_status}.` });
    }

    let finalisedObj = null;
    let orderStatus = 'bidding cancelled';

    if (bid_status === 'finalised') {
      if (!finalised_for) {
        return res.status(400).json({ message: 'finalised_for is required when bid_status is finalised.' });
      }
      let amount = finalised_bid;

      if (amount == null) {
        // fallback to lowest amount for that carrier (or lowest overall if not found)
        const bids = parseJSONSafe(row.all_bids, []);
        const byCarrier = bids.filter(b => b.bid_from === finalised_for);
        if (byCarrier.length) {
          amount = Math.min(...byCarrier.map(b => Number(b.bid_amount)));
        } else if (bids.length) {
          amount = Math.min(...bids.map(b => Number(b.bid_amount)));
        } else {
          return res.status(400).json({ message: 'No bids available to finalise.' });
        }
      }

      finalisedObj = { finalised_bid: String(amount), finalised_for };
      orderStatus = 'bidding finalised';
    }

    await db.query(`
      UPDATE assignment_bidding
      SET bid_status = ?, bid_end_time = ?, finalised_bid = ?
      WHERE bid_id = ? AND order_ID = ?
    `, [
      bid_status,
      nowISO(),
      finalisedObj ? JSON.stringify(finalisedObj) : null,
      row.bid_id,
      order_ID
    ]);

    await db.query(`UPDATE orders SET order_status = ? WHERE order_ID = ?`, [orderStatus, order_ID]);

    return res.status(200).json({
      message: (bid_status === 'cancelled') ? 'Bid cancelled successfully.' : 'Bid finalised successfully.',
      order_ID,
      bid_id: row.bid_id,
      bid_status,
      finalised: finalisedObj
    });
  } catch (error) {
    logger.error('Error closing bid:', error);
    return res.status(500).json({ message: 'Server error.', error: error.message });
  }
});

module.exports = router;
