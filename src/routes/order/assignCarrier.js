const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');

const nodemailer = require('nodemailer');


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    // user: process.env.MAIL_USER, 
    // pass: process.env.MAIL_PASS
    user:'itsupport@trukapp.com',
    pass:'iytz zfrm cktq isyw'
  }
});


async function sendAssignmentMail(carrier_ID, order_ID) {
    try {
      const [carriers] = await db.query(`SELECT carrier_correspondence FROM carriers WHERE carrier_ID = ?`, [carrier_ID]);
      if (!carriers.length) return;
  
     
    let carrierCorrespondence = carriers[0].carrier_correspondence;

 
    if (typeof carrierCorrespondence === 'string') {
      carrierCorrespondence = JSON.parse(carrierCorrespondence);
    }
      const email = carrierCorrespondence.email;
      if (!email) return;
  
      const subject = 'New Assignment Waiting for Confirmation';
      const htmlContent = `
        <p>Dear Carrier,</p>
        <p>A new assignment (Order ID: <b>${order_ID}</b>) is waiting for your confirmation.</p>
        <p>Please login to your dashboard and provide Vehicle and Driver details to confirm it.</p>
        <br/>
        <p>Thank you,</p>
        <p><b>Trukapp Team</b></p>
      `;
  
      await transporter.sendMail({
        to: email,
        subject,
        html: htmlContent
      });
  
      logger.info(`Assignment mail sent to carrier: ${carrier_ID}`);
    } catch (err) {
      logger.error(`Failed to send assignment mail to carrier: ${carrier_ID}`, err);
    }
  }
  


const generateCasID = async () => {
    try {
        const [result] = await db.query(
            `SELECT cas_ID FROM carrier_assignments ORDER BY LENGTH(cas_ID) DESC, cas_ID DESC LIMIT 1`
        );

        let nextID = "CA000001";
        if (result.length > 0 && result[0].cas_ID) {
            let lastID = result[0].cas_ID;
            let numPart = parseInt(lastID.slice(2)) + 1;
            let numDigits = numPart.toString().length;
            let requiredZeros = Math.max(6 - numDigits, 0);
            nextID = `CA${"0".repeat(requiredZeros)}${numPart}`;
        }

        return nextID;
    } catch (error) {
        logger.error("Error generating cas_ID:", error);
        throw new Error("Failed to generate cas_ID");
    }
};

router.post('/assign-carrier', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID, assigned_time } = req.body;

        if (!order_ID) {
            return res.status(400).json({ message: 'order_ID is required.' });
        }

        const [validCarriers] = await db.query(`
            SELECT carrier_ID, pricing FROM carriers
            WHERE contract = 1 AND DATE(contract_valid_upto) >= CURDATE()
        `);

        if (!validCarriers.length) {
            return res.status(400).json({ message: 'No valid contracted carriers found.' });
        }

        const [orders] = await db.query(`
            SELECT total_weight, total_distance FROM orders WHERE order_ID = ?
        `, [order_ID]);

        if (!orders.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const { total_weight, total_distance } = orders[0];

        if (validCarriers.length === 1) {
            const selectedCarrier = validCarriers[0];

            let pricing = {};
            try {
                pricing = typeof selectedCarrier.pricing === 'string'
                    ? JSON.parse(selectedCarrier.pricing)
                    : selectedCarrier.pricing;
            } catch (err) {
                return res.status(400).json({ message: 'Invalid pricing JSON format in selected carrier.' });
            }

            let calculatedCost = 0;
            const assignment_cost = {
                cost_criteria_considered: pricing.cost_criteria_per || '',
                total_weight: null,
                total_distance: null,
                cost: 0
            };

            if (pricing.cost_criteria_per === 'ton') {
                assignment_cost.total_weight = total_weight;
                calculatedCost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
            } else if (pricing.cost_criteria_per === 'km') {
                assignment_cost.total_distance = total_distance;
                calculatedCost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
            }

            assignment_cost.cost = calculatedCost.toFixed(2);

            const cas_ID = await generateCasID();

            await db.query(`
                INSERT INTO carrier_assignments 
                (cas_ID, order_ID, req_sent_to, assigned_time, assignment_status, assignment_cost)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                cas_ID,
                order_ID,
                JSON.stringify([selectedCarrier.carrier_ID]),
                assigned_time,
                'Pending',
                JSON.stringify(assignment_cost)
            ]);

            await db.query(
                `UPDATE orders SET order_status = ? WHERE order_ID = ?`,
                ['carrier assignment', order_ID]
            );

            sendAssignmentMail(selectedCarrier.carrier_ID, order_ID);

            return res.status(201).json({
                message: 'Carrier assignment initialized successfully.',
                cas_ID,
                req_sent_to: [selectedCarrier.carrier_ID],
                assignment_cost
            });
        }

        const options = [];

        for (const carrier of validCarriers) {
            try {
                const pricing = typeof carrier.pricing === 'string'
                    ? JSON.parse(carrier.pricing)
                    : carrier.pricing;

                let cost = 0;
                if (pricing.cost_criteria_per === 'ton') {
                    cost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
                } else if (pricing.cost_criteria_per === 'km') {
                    cost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
                }

                options.push({
                    carrier_ID: carrier.carrier_ID,
                    cost: cost.toFixed(2),
                    cost_criteria_considered: pricing.cost_criteria_per,
                    rate: `${parseFloat(pricing.cost).toFixed(2)} per ${pricing.cost_criteria_per}`
                });
            } catch (err) {
                continue;
            }
        }

        return res.status(200).json({
            message: 'Multiple valid contracted carriers found. Choose one for assignment.',
            carrier_options: options
        });

    } catch (error) {
        logger.error("Error assigning carrier:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.post('/finalize-carrier-assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID, carrier_ID, assigned_time } = req.body;

        if (!order_ID || !carrier_ID || !assigned_time) {
            return res.status(400).json({ message: 'order_ID, carrier_ID, and assigned_time are required.' });
        }

        const [carrierRows] = await db.query(`
            SELECT carrier_ID, pricing FROM carriers 
            WHERE carrier_ID = ? AND contract = 1 AND DATE(contract_valid_upto) >= CURDATE()
        `, [carrier_ID]);

        if (!carrierRows.length) {
            return res.status(400).json({ message: 'Invalid or expired contracted carrier.' });
        }

        const selectedCarrier = carrierRows[0];

        const [orderRows] = await db.query(`
            SELECT total_weight, total_distance FROM orders WHERE order_ID = ?
        `, [order_ID]);

        if (!orderRows.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const { total_weight, total_distance } = orderRows[0];

        let pricing = {};
        try {
            pricing = typeof selectedCarrier.pricing === 'string'
                ? JSON.parse(selectedCarrier.pricing)
                : selectedCarrier.pricing;
        } catch (err) {
            return res.status(400).json({ message: 'Invalid pricing JSON format for carrier.' });
        }

        let calculatedCost = 0;
        const assignment_cost = {
            cost_criteria_considered: pricing.cost_criteria_per || '',
            total_weight: null,
            total_distance: null,
            cost: 0
        };

        if (pricing.cost_criteria_per === 'ton') {
            assignment_cost.total_weight = total_weight;
            calculatedCost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
        } else if (pricing.cost_criteria_per === 'km') {
            assignment_cost.total_distance = total_distance;
            calculatedCost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
        }

        assignment_cost.cost = calculatedCost.toFixed(2);

        const cas_ID = await generateCasID();

        await db.query(`
            INSERT INTO carrier_assignments 
            (cas_ID, order_ID, req_sent_to, assigned_time, assignment_status, assignment_cost)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            cas_ID,
            order_ID,
            JSON.stringify([carrier_ID]),
            assigned_time,
            'Pending',
            JSON.stringify(assignment_cost)
        ]);

        await db.query(`UPDATE orders SET order_status = ? WHERE order_ID = ?`, ['carrier assignment', order_ID]);

        sendAssignmentMail(carrier_ID, order_ID);

        return res.status(201).json({
            message: 'Carrier assignment sent to selected carrier successfully.',
            cas_ID,
            carrier_ID,
            assignment_cost
        });

    } catch (error) {
        logger.error("Error finalizing carrier assignment:", error);
        return res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});




router.get('/carrier-assignments', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'carrier_ID is required in query.' });
        }

        // Step 1: Get assignments with matching carrier_ID and assignment_status = 'Pending'
        const [assignments] = await db.query(`
            SELECT ca.*, o.*
            FROM carrier_assignments ca
            LEFT JOIN orders o ON ca.order_ID = o.order_ID
            WHERE JSON_CONTAINS(ca.req_sent_to, JSON_QUOTE(?), '$')
              AND ca.assignment_status = 'Pending'
            ORDER BY ca.ca_id DESC
        `, [carrier_ID]);

        if (assignments.length === 0) {
            return res.status(404).json({ message: 'No assignments found for this carrier with status Pending.' });
        }

        // Step 2: Collect all unique allocated package IDs
        const allPackageIDs = new Set();

        for (const a of assignments) {
            let allocated = [];

            if (Array.isArray(a.allocated_packages)) {
                allocated = a.allocated_packages;
            } else if (typeof a.allocated_packages === 'string') {
                try {
                    const parsed = JSON.parse(a.allocated_packages);
                    if (Array.isArray(parsed)) {
                        allocated = parsed;
                    } else {
                        allocated = a.allocated_packages
                            .replace(/[\[\]"]/g, '')
                            .split(',')
                            .map(s => s.trim())
                            .filter(Boolean);
                    }
                } catch {
                    allocated = a.allocated_packages
                        .replace(/[\[\]"]/g, '')
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean);
                }
            }

            allocated.forEach(pkg => allPackageIDs.add(pkg));
        }

        // Step 3: Fetch all package details
        const packageList = [...allPackageIDs];
        let packagesData = [];

        if (packageList.length > 0) {
            const placeholders = packageList.map(() => '?').join(',');
            const [packages] = await db.query(
                `SELECT * FROM packages WHERE pack_ID IN (${placeholders})`,
                packageList
            );
            packagesData = packages;
        }

        res.status(200).json({
            assignments,
            packages: packagesData
        });
    } catch (error) {
        logger.error('Error fetching carrier assignments:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


router.get('/assigned-order-by-id', jwtAuth.verifyToken, async (req, res) => {
    try {
      const { order_ID } = req.query;
  
      if (!order_ID) {
        return res.status(400).json({ message: 'order_ID is required in query.' });
      }
  
      const [results] = await db.query(`
        SELECT * FROM carrier_assignments WHERE order_ID = ?
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
  


router.post('/carrier-assignment/confirm', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            carrier_ID,
            order_ID,
            vehicle_num,
            driver_data,
            device_ID,
            confirmed_time
        } = req.body;

        if (!carrier_ID || !order_ID) {
            return res.status(400).json({ message: "carrier_ID and order_ID are required." });
        }

        const [result] = await db.query(
            `SELECT * FROM carrier_assignments 
             WHERE order_ID = ? AND JSON_CONTAINS(req_sent_to, JSON_QUOTE(?), '$')`,
            [order_ID, carrier_ID]
        );

        if (result.length === 0) {
            return res.status(404).json({ message: 'No carrier assignment found for this carrier and order.' });
        }

        await db.query(
            `UPDATE carrier_assignments SET 
                confirmed_to = ?,
                vehicle_num = ?,
                driver_data = ?,
                device_ID = ?,
                confirmed_time = ?,
                assignment_status = 'carrier confirmed'
             WHERE order_ID = ? AND JSON_CONTAINS(req_sent_to, JSON_QUOTE(?), '$')`,
            [
                carrier_ID,
                vehicle_num,
                JSON.stringify(driver_data || {}),
                device_ID,
                confirmed_time,
                order_ID,
                carrier_ID
            ]
        );

        await db.query(
            `UPDATE orders SET order_status = 'carrier confirmed' WHERE order_ID = ?`,
            [order_ID]
          );
          

        return res.status(200).json({ message: 'Carrier assignment confirmed successfully.' });
    } catch (error) {
        logger.error("Error confirming carrier assignment:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});


router.post('/carrier-assignment/reject', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID, order_ID } = req.body;

        if (!carrier_ID || !order_ID) {
            return res.status(400).json({ message: "carrier_ID and order_ID are required." });
        }

        const [result] = await db.query(
            `SELECT * FROM carrier_assignments 
             WHERE order_ID = ? AND JSON_CONTAINS(req_sent_to, JSON_QUOTE(?), '$')`,
            [order_ID, carrier_ID]
        );

        if (result.length === 0) {
            return res.status(404).json({ message: 'No carrier assignment found for this carrier and order.' });
        }

        await db.query(
            `UPDATE carrier_assignments 
             SET assignment_status = 'carrier rejected' 
             WHERE order_ID = ? AND JSON_CONTAINS(req_sent_to, JSON_QUOTE(?), '$')`,
            [order_ID, carrier_ID]
        );

        await db.query(
            `UPDATE orders SET order_status = 'carrier rejected' WHERE order_ID = ?`,
            [order_ID]
          );
          

        return res.status(200).json({ message: 'Carrier assignment rejected successfully.' });
    } catch (error) {
        logger.error("Error rejecting carrier assignment:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});




// Get all assignments with pagination
router.get('/all-assignments', jwtAuth.verifyToken, async (req, res) => {
    try {
        let { page, limit } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;

        const query = `SELECT * FROM carrier_assignments ORDER BY ca_id DESC`;
        const paginatedQuery = applyPagination(query, page, limit);

        const [result] = await db.query(paginatedQuery);
        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching carrier assignments:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Get single assignment by cas_ID or order_ID
router.get('/assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { carrier_ID } = req.query;

        if (!carrier_ID) {
            return res.status(400).json({ message: 'Please provide carrier_ID in query.' });
        }

        const [result] = await db.query(`
            SELECT * FROM carrier_assignments 
            WHERE confirmed_to = ? 
               OR JSON_CONTAINS(req_sent_to, JSON_QUOTE(?), '$')
        `, [carrier_ID, carrier_ID]);

        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});


// Update assignment
router.put('/edit-assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { ca_id } = req.query;
        const {
            order_ID,
            req_sent_to,
            confirmed_to,
            vehicle_num,
            driver_data,
            device_ID,
            total_cost,
            assigned_time,
            confirmed_time,
            order_status
        } = req.body;

        if (!ca_id) {
            return res.status(400).json({ message: "ca_id is required in query." });
        }

        let updateFields = [];
        let values = [];

        if (order_ID) {
            updateFields.push("order_ID = ?");
            values.push(order_ID);
        }
        if (req_sent_to) {
            updateFields.push("req_sent_to = ?");
            values.push(JSON.stringify(req_sent_to));
        }
        if (confirmed_to) {
            updateFields.push("confirmed_to = ?");
            values.push(confirmed_to);
        }
        if (vehicle_num) {
            updateFields.push("vehicle_num = ?");
            values.push(vehicle_num);
        }
        if (driver_data) {
            updateFields.push("driver_data = ?");
            values.push(JSON.stringify(driver_data));
        }
        if (device_ID) {
            updateFields.push("device_ID = ?");
            values.push(device_ID);
        }
        if (total_cost) {
            updateFields.push("total_cost = ?");
            values.push(total_cost);
        }
        if (assigned_time) {
            updateFields.push("assigned_time = ?");
            values.push(assigned_time);
        }
        if (confirmed_time) {
            updateFields.push("confirmed_time = ?");
            values.push(confirmed_time);
        }
        if (order_status) {
            updateFields.push("order_status = ?");
            values.push(order_status);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: "No fields provided for update." });
        }

        values.push(ca_id);
        const query = `UPDATE carrier_assignments SET ${updateFields.join(", ")} WHERE ca_id = ?`;

        await db.query(query, values);
        res.status(200).json({ message: "Carrier assignment updated successfully." });
    } catch (error) {
        logger.error("Error updating assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Delete assignment
router.delete('/delete-assignment', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { ca_id } = req.query;

        if (!ca_id) {
            return res.status(400).json({ message: "ca_id is required in query." });
        }

        await db.query(`DELETE FROM carrier_assignments WHERE ca_id = ?`, [ca_id]);
        res.status(200).json({ message: "Carrier assignment deleted successfully." });
    } catch (error) {
        logger.error("Error deleting assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

module.exports = router;
