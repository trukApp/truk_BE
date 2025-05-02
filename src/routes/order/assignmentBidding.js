const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


router.post('/initiate-open-bidding', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            order_ID,
            bid_value,
            bid_timing,
            bid_start_time
        } = req.body;

        if (!order_ID || !bid_value || !bid_timing || !bid_start_time) {
            return res.status(400).json({ message: 'Missing required fields: order_ID, bid_value, bid_timing, bid_start_time' });
        }

        // Check if order exists
        const [orderCheck] = await db.query(`SELECT order_ID FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderCheck.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        // Get all carrier_IDs from carriers table (irrespective of contract)
        const [carriers] = await db.query(`SELECT carrier_ID FROM carriers`);
        const carrierIDs = carriers.map(c => c.carrier_ID);

        if (!carrierIDs.length) {
            return res.status(400).json({ message: 'No carriers found to send bidding request.' });
        }

        // Insert into assignment_bidding table
        await db.query(`
            INSERT INTO assignment_bidding 
            (order_ID, bid_value, bid_timing, bid_reqs, bid_start_time) 
            VALUES (?, ?, ?, ?, ?)
        `, [
            order_ID,
            bid_value,
            bid_timing,
            JSON.stringify(carrierIDs),
            bid_start_time
        ]);

         await db.query(
                    `UPDATE orders SET order_status = 'open bidding' WHERE order_ID = ?`,
                    [order_ID]
                  );

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


router.get('/active-bids', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'carrier_ID is required in query.' });
        }

        const [results] = await db.query(`
            SELECT ab.*, o.*
            FROM assignment_bidding ab
            JOIN orders o ON ab.order_ID = o.order_ID
            WHERE ab.bid_end_time IS NULL
              AND JSON_CONTAINS(ab.bid_reqs, JSON_QUOTE(?))
        `, [carrier_ID]);

        if (!results.length) {
            return res.status(404).json({ message: 'No active bids found for this carrier.' });
        }

        // 🧼 Filter out sensitive/internal fields
        const filteredResults = results.map(row => {
            const {
                bid_reqs,
                total_cost,
                all_bids,
                finalised_bid,
                ...rest
            } = row;
            return rest;
        });

        res.status(200).json({
            message: 'Active bids fetched successfully.',
            data: filteredResults
        });

    } catch (error) {
        logger.error('Error fetching active bids for carrier:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


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

        const [bids] = await db.query(`
            SELECT all_bids, bid_end_time FROM assignment_bidding 
            WHERE bid_id = ? AND order_ID = ?
        `, [bid_id, order_ID]);

        if (!bids.length) {
            return res.status(404).json({ message: "No active bid found for this order." });
        }

        const { all_bids, bid_end_time } = bids[0];

        if (bid_end_time) {
            return res.status(403).json({ message: "Bidding time is over for this order." });
        }

        let existingBids = [];
        if (typeof all_bids === 'string' && all_bids.trim() !== '') {
            try {
                existingBids = JSON.parse(all_bids);
            } catch (e) {
                return res.status(500).json({ message: "Stored bid data is corrupted." });
            }
        } else if (Array.isArray(all_bids)) {
            existingBids = all_bids;
        }

        const alreadyBid = existingBids.some(bid => bid.bid_from === bid_from);
        if (alreadyBid) {
            return res.status(400).json({ message: "Carrier has already placed a bid for this order." });
        }

        const newBid = {
            bid_amount,
            bid_from,
            bid_placed_at
        };
        existingBids.push(newBid);

        await db.query(`
            UPDATE assignment_bidding SET all_bids = ? WHERE bid_id = ? AND order_ID = ?
        `, [JSON.stringify(existingBids), bid_id, order_ID]);

        res.status(200).json({
            message: "Bid placed successfully.",
            bid: newBid
        });

    } catch (error) {
        logger.error("Error placing bid:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});



router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'carrier_ID is required in query.' });
        }

        const [results] = await db.query(`
            SELECT ab.*, o.*
            FROM assignment_bidding ab
            JOIN orders o ON ab.order_ID = o.order_ID
            WHERE JSON_CONTAINS(ab.all_bids, JSON_OBJECT('bid_from', ?))
        `, [carrier_ID]);

        if (!results.length) {
            return res.status(404).json({ message: 'No bids found placed by this carrier.' });
        }

        const filteredResults = results.map(row => {
            const {
                bid_reqs,
                finalised_bid,
                ...rest
            } = row;
            return rest;
        });

        res.status(200).json({
            message: 'Carrier participation bids fetched successfully.',
            carrier_ID,
            data: filteredResults
        });

    } catch (error) {
        logger.error('Error fetching carrier bids:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});



router.get('/carrier-bids', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'carrier_ID is required in query.' });
        }

        const [results] = await db.query(`
            SELECT ab.*, o.*
            FROM assignment_bidding ab
            JOIN orders o ON ab.order_ID = o.order_ID
            WHERE JSON_CONTAINS(ab.all_bids, JSON_OBJECT('bid_from', ?))
        `, [carrier_ID]);

        if (!results.length) {
            return res.status(404).json({ message: 'No bids found placed by this carrier.' });
        }

        const filteredResults = results.map(row => {
            const {
                bid_reqs,
                finalised_bid,
                ...rest
            } = row;
            return rest;
        });

        res.status(200).json({
            message: 'Carrier participation bids fetched successfully.',
            carrier_ID,
            data: filteredResults
        });

    } catch (error) {
        logger.error('Error fetching carrier bids:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


router.get('/bids-order-id', jwtAuth.verifyToken, async (req, res) => {
    try {
      const { order_ID } = req.query;
  
      if (!order_ID) {
        return res.status(400).json({ message: 'order_ID is required in query.' });
      }
  
      const [results] = await db.query(`
        SELECT * FROM assignment_bidding WHERE order_ID = ?
      `, [order_ID]);
  
      if (!results.length) {
        return res.status(404).json({ message: 'No data found for the given order_ID.' });
      }
  
      res.status(200).json({
        message: 'Data fetched successfully.',
        data: results
      });
  
    } catch (error) {
      logger.error('Error fetching assigning_orders:', error);
      res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
  });
  


router.get('/finalised-bids', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'carrier_ID is required in query.' });
        }

        const [results] = await db.query(`
            SELECT ab.*, o.*
            FROM assignment_bidding ab
            JOIN orders o ON ab.order_ID = o.order_ID
            WHERE JSON_EXTRACT(ab.finalised_bid, '$.finalised_for') = ?
        `, [carrier_ID]);

        if (!results.length) {
            return res.status(404).json({ message: 'No finalized bids found for this carrier.' });
        }

        const cleanedResults = results.map(row => {
            const {
                bid_reqs,
                all_bids,
                ...rest
            } = row;
            return rest;
        });

        res.status(200).json({
            message: 'Finalised bids fetched successfully.',
            carrier_ID,
            data: cleanedResults
        });

    } catch (error) {
        logger.error('Error fetching finalised bids for carrier:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});




module.exports = router;