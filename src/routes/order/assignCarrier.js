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
    pass:'jgtv jjvr qzhq yzbj'
  }
});


// async function sendAssignmentMail(carrier_ID, order_ID) {
//     try {
//       const [carriers] = await db.query(`SELECT carrier_correspondence FROM carriers WHERE carrier_ID = ?`, [carrier_ID]);
//       if (!carriers.length) return;
  
     
//     let carrierCorrespondence = carriers[0].carrier_correspondence;

 
//     if (typeof carrierCorrespondence === 'string') {
//       carrierCorrespondence = JSON.parse(carrierCorrespondence);
//     }
//       const email = carrierCorrespondence.email;
//       if (!email) return;
  
//       const subject = 'New Assignment Waiting for Confirmation';
//       const htmlContent = `
//         <p>Dear Carrier,</p>
//         <p>A new assignment (Order ID: <b>${order_ID}</b>) is waiting for your confirmation.</p>
//         <p>Please login to your dashboard and provide Vehicle and Driver details to confirm it.</p>
//         <br/>
//         <p>Thank you,</p>
//         <p><b>Trukapp Team</b></p>
//       `;
  
//       await transporter.sendMail({
//         to: email,
//         subject,
//         html: htmlContent
//       });
  
//       logger.info(`Assignment mail sent to carrier: ${carrier_ID}`);
//     } catch (err) {
//       logger.error(`Failed to send assignment mail to carrier: ${carrier_ID}`, err);
//     }
//   }
  
async function sendAssignmentMail(carrier_ID, order_ID) {
    try {
        const [carriers] = await db.query(`
            SELECT carrier_correspondence FROM carriers WHERE carrier_ID = ?
        `, [carrier_ID]);

        if (!carriers.length) return;

        let carrierCorrespondence = carriers[0].carrier_correspondence;
        if (typeof carrierCorrespondence === 'string') {
            try {
                carrierCorrespondence = JSON.parse(carrierCorrespondence);
            } catch (err) {
                logger.warn(`Failed to parse carrier_correspondence JSON for carrier_ID: ${carrier_ID}`);
                return;
            }
        }

        const email = carrierCorrespondence.email;
        if (!email) return;

        // Fetch latest assignment for the carrier and order
        const [assignmentRows] = await db.query(`
            SELECT dock_allocated, dock_allocation_status FROM carrier_assignments 
            WHERE order_ID = ? AND confirmed_to = ? ORDER BY assigned_time DESC LIMIT 1
        `, [order_ID, carrier_ID]);

        let dockInfoHTML = `<p><b>No dock has been allocated yet.</b></p>`;

        if (assignmentRows.length) {
            const assignment = assignmentRows[0];
            const dockID = assignment.dock_allocated;

            const isValidDock = (
                dockID &&
                typeof dockID === 'string' &&
                dockID.trim() !== '' &&
                dockID !== 'null' &&
                dockID !== 'undefined' &&
                assignment.dock_allocation_status === 'allocated'
            );

            if (isValidDock) {
                const [dockRows] = await db.query(`
                    SELECT dock_name, dock_timings, loc_ID FROM master_docks WHERE dock_ID = ?
                `, [dockID]);

                if (dockRows.length) {
                    const dock = dockRows[0];
                    dockInfoHTML = `
                        <p><b>Dock Allocation Details:</b></p>
                        <ul>
                            <li><b>Dock ID:</b> ${dockID}</li>
                            <li><b>Dock Name:</b> ${dock.dock_name}</li>
                            <li><b>Location ID:</b> ${dock.loc_ID}</li>
                            <li><b>Timings:</b> ${dock.dock_timings}</li>
                        </ul>
                    `;
                } else {
                    logger.warn(`Dock ID ${dockID} listed in assignment, but not found in master_docks.`);
                }
            } else {
                logger.warn(`No valid dock allocated for order_ID: ${order_ID}, carrier_ID: ${carrier_ID}`);
            }
        }

        const subject = 'New Assignment Waiting for Confirmation';
        const htmlContent = `
            <p>Dear Carrier,</p>
            <p>A new assignment (Order ID: <b>${order_ID}</b>) is waiting for your confirmation.</p>
            ${dockInfoHTML}
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

async function findAvailableDockForCarrier(carrier_ID, pickupLocID) {
    const [docks] = await db.query(`
        SELECT * FROM master_docks 
        WHERE dock_availability = 1 AND loc_ID = ?
    `, [pickupLocID]);

    for (const dock of docks) {
        try {
            const defaultCarriers = typeof dock.default_carriers === 'string'
                ? JSON.parse(dock.default_carriers)
                : dock.default_carriers;

            if (Array.isArray(defaultCarriers) && defaultCarriers.includes(carrier_ID)) {
                return dock.dock_ID;
            }
        } catch {
            continue;
        }
    }

    return null;
}


// router.post('/assign-carrier', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { order_ID, assigned_time } = req.body;

//         if (!order_ID) {
//             return res.status(400).json({ message: 'order_ID is required.' });
//         }

//         const [validCarriers] = await db.query(`
//             SELECT carrier_ID, pricing FROM carriers
//             WHERE contract = 1 AND DATE(contract_valid_upto) >= CURDATE()
//         `);

//         if (!validCarriers.length) {
//             return res.status(400).json({ message: 'No valid contracted carriers found.' });
//         }

//         const [orders] = await db.query(`
//             SELECT total_weight, total_distance, allocated_packages FROM orders WHERE order_ID = ?
//         `, [order_ID]);

//         if (!orders.length) {
//             return res.status(404).json({ message: 'Order not found.' });
//         }

//         const { total_weight, total_distance, allocated_packages } = orders[0];

//         let pickupLocID = null;
//         try {
//             const packages = typeof allocated_packages === 'string' ? JSON.parse(allocated_packages) : allocated_packages;
//             if (!Array.isArray(packages) || !packages.length) throw new Error();

//             const [pkgRow] = await db.query(`SELECT ship_from FROM packages WHERE pack_ID = ?`, [packages[0]]);
//             if (pkgRow.length) pickupLocID = pkgRow[0].ship_from;
//         } catch {
//             return res.status(400).json({ message: 'Could not determine pickup location from allocated packages.' });
//         }

//         if (validCarriers.length === 1) {
//             const selectedCarrier = validCarriers[0];

//             let pricing = {};
//             try {
//                 pricing = typeof selectedCarrier.pricing === 'string'
//                     ? JSON.parse(selectedCarrier.pricing)
//                     : selectedCarrier.pricing;
//             } catch {
//                 return res.status(400).json({ message: 'Invalid pricing JSON format in selected carrier.' });
//             }

//             let calculatedCost = 0;
//             const assignment_cost = {
//                 cost_criteria_considered: pricing.cost_criteria_per || '',
//                 total_weight: null,
//                 total_distance: null,
//                 cost: 0
//             };

//             if (pricing.cost_criteria_per === 'ton') {
//                 assignment_cost.total_weight = total_weight;
//                 calculatedCost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
//             } else if (pricing.cost_criteria_per === 'km') {
//                 assignment_cost.total_distance = total_distance;
//                 calculatedCost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
//             }

//             assignment_cost.cost = calculatedCost.toFixed(2);
//             const cas_ID = await generateCasID();

//             const dockID = await findAvailableDockForCarrier(selectedCarrier.carrier_ID, pickupLocID);

//             await db.query(`
//                 INSERT INTO carrier_assignments 
//                 (cas_ID, order_ID, req_sent_to, assigned_time, assignment_status, assignment_cost, confirmed_to, dock_allocated, dock_allocation_status)
//                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
//             `, [
//                 cas_ID,
//                 order_ID,
//                 JSON.stringify([selectedCarrier.carrier_ID]),
//                 assigned_time,
//                 'Pending',
//                 JSON.stringify(assignment_cost),
//                 selectedCarrier.carrier_ID,
//                 dockID,
//                 dockID ? 'allocated' : 'Pending'
//             ]);

//             await db.query(`UPDATE orders SET order_status = ? WHERE order_ID = ?`, ['carrier assignment', order_ID]);

//             sendAssignmentMail(selectedCarrier.carrier_ID, order_ID);

//             return res.status(201).json({
//                 message: 'Carrier assignment initialized successfully.',
//                 cas_ID,
//                 req_sent_to: [selectedCarrier.carrier_ID],
//                 assignment_cost,
//                 dock_allocated: dockID || null,
//                 dock_allocation_status: dockID ? 'allocated' : 'Pending'
//             });
//         }

//         const options = [];

//         for (const carrier of validCarriers) {
//             try {
//                 const pricing = typeof carrier.pricing === 'string'
//                     ? JSON.parse(carrier.pricing)
//                     : carrier.pricing;

//                 let cost = 0;
//                 if (pricing.cost_criteria_per === 'ton') {
//                     cost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
//                 } else if (pricing.cost_criteria_per === 'km') {
//                     cost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
//                 }

//                 options.push({
//                     carrier_ID: carrier.carrier_ID,
//                     cost: cost.toFixed(2),
//                     cost_criteria_considered: pricing.cost_criteria_per,
//                     rate: `${parseFloat(pricing.cost).toFixed(2)} per ${pricing.cost_criteria_per}`
//                 });
//             } catch {
//                 continue;
//             }
//         }

//         return res.status(200).json({
//             message: 'Multiple valid contracted carriers found. Choose one for assignment.',
//             carrier_options: options
//         });

//     } catch (error) {
//         logger.error("Error assigning carrier:", error);
//         res.status(500).json({ message: "Internal Server Error", error: error.message });
//     }
// });

router.post('/assign-carrier',jwtAuth.verifyToken,async (req, res) => {
      try {
        const { order_ID, assigned_time } = req.body;
        if (!order_ID || !assigned_time) {
          return res.status(400).json({ message: 'order_ID and assigned_time are required.' });
        }
  
        // 1) pick only carriers with a valid contract *and* at least one PRO available
        const [validCarriers] = await db.query(`
          SELECT carrier_ID, pricing, carrier_pro_numbers
          FROM carriers
          WHERE contract = 1
            AND DATE(contract_valid_upto) >= CURDATE()
        `);
  
        if (!validCarriers.length) {
          return res.status(400).json({ message: 'No valid contracted carriers found.' });
        }
  
        // 2) fetch order totals
        const [orders] = await db.query(`
          SELECT total_weight, total_distance, allocated_packages
          FROM orders
          WHERE order_ID = ?
        `, [order_ID]);
        if (!orders.length) {
          return res.status(404).json({ message: 'Order not found.' });
        }
        const { total_weight, total_distance, allocated_packages } = orders[0];
  
        // 3) determine pickup location
        let pickupLocID = null;
        try {
          const pkgs = typeof allocated_packages === 'string'
            ? JSON.parse(allocated_packages)
            : allocated_packages;
          if (!pkgs.length) throw new Error();
          const [[{ ship_from }]] = await db.query(
            `SELECT ship_from FROM packages WHERE pack_ID = ?`,
            [pkgs[0]]
          );
          pickupLocID = ship_from;
        } catch {
          return res.status(400).json({ message: 'Could not derive pickup location.' });
        }
  
        // 4) if only one carrier is valid, auto‐assign
        if (validCarriers.length === 1) {
          const carrier = validCarriers[0];
          // parse pricing
          let pricing;
          try {
            pricing = typeof carrier.pricing === 'string'
              ? JSON.parse(carrier.pricing)
              : carrier.pricing;
          } catch {
            return res.status(400).json({ message: 'Carrier has invalid pricing JSON.' });
          }
  
          // parse & pop one PRO number
          let proList;
          try {
            proList = typeof carrier.carrier_pro_numbers === 'string'
              ? JSON.parse(carrier.carrier_pro_numbers)
              : carrier.carrier_pro_numbers;
          } catch {
            return res.status(500).json({ message: 'Malformed carrier_pro_numbers.' });
          }
          if (!Array.isArray(proList) || !proList.length) {
            return res.status(400).json({
              message: `Carrier ${carrier.carrier_ID} has no PRO numbers left.`
            });
          }
          const assignedPro = proList.shift();
  
          // recalc cost
          let cost = 0;
          if (pricing.cost_criteria_per === 'ton') {
            cost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
          } else {
            cost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
          }
          const assignment_cost = {
            cost_criteria_considered: pricing.cost_criteria_per,
            total_weight: pricing.cost_criteria_per === 'ton' ? total_weight : null,
            total_distance: pricing.cost_criteria_per === 'km' ? total_distance : null,
            cost: cost.toFixed(2),
          };
  
          // generate IDs & find dock
          const cas_ID = await generateCasID();
          const dockID = await findAvailableDockForCarrier(carrier.carrier_ID, pickupLocID);
  
          // 5) UPDATE carrier_pro_numbers in carriers table
          await db.query(
            `UPDATE carriers
             SET carrier_pro_numbers = ?
             WHERE carrier_ID = ?`,
            [ JSON.stringify(proList), carrier.carrier_ID ]
          );
  
          // 6) INSERT assignment
          await db.query(`
            INSERT INTO carrier_assignments
              (cas_ID, order_ID, req_sent_to, assigned_time,
               assignment_status, assignment_cost, confirmed_to,
               dock_allocated, dock_allocation_status, assigned_pro_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            cas_ID,
            order_ID,
            JSON.stringify([carrier.carrier_ID]),
            assigned_time,
            'Pending',
            JSON.stringify(assignment_cost),
            carrier.carrier_ID,
            dockID,
            dockID ? 'allocated' : 'Pending',
            assignedPro
          ]);
  
          // 7) update order status
          await db.query(
            `UPDATE orders SET order_status = ? WHERE order_ID = ?`,
            ['carrier assignment', order_ID]
          );
  
          // 8) notify
          sendAssignmentMail(carrier.carrier_ID, order_ID);
  
          return res.status(201).json({
            message: 'Carrier assigned successfully.',
            cas_ID,
            carrier_ID: carrier.carrier_ID,
            assigned_pro_number: assignedPro,
            assignment_cost,
            dock_allocated: dockID || null,
            dock_allocation_status: dockID ? 'allocated' : 'Pending'
          });
        }
  
        // 9) if multiple carriers, return options (no PRO yet)
        const options = validCarriers.map(carrier => {
          let pricing;
          try {
            pricing = typeof carrier.pricing === 'string'
              ? JSON.parse(carrier.pricing)
              : carrier.pricing;
          } catch {
            return null;
          }
          let cost = 0;
          if (pricing.cost_criteria_per === 'ton') {
            cost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
          } else {
            cost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
          }
          return {
            carrier_ID: carrier.carrier_ID,
            cost: cost.toFixed(2),
            cost_criteria_considered: pricing.cost_criteria_per,
            rate: `${parseFloat(pricing.cost).toFixed(2)} per ${pricing.cost_criteria_per}`
          };
        }).filter(o => o !== null);
  
        return res.status(200).json({
          message: 'Multiple valid carriers found; select one to finalize.',
          carrier_options: options
        });
      }
      catch (err) {
        logger.error('Error in /assign-carrier:', err);
        return res.status(500).json({ message: 'Internal Server Error', error: err.message });
      }
    }
  );

// router.post('/finalize-carrier-assignment', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { order_ID, carrier_ID, assigned_time } = req.body;

//         if (!order_ID || !carrier_ID || !assigned_time) {
//             return res.status(400).json({ message: 'order_ID, carrier_ID, and assigned_time are required.' });
//         }

//         const [carrierRows] = await db.query(`
//             SELECT carrier_ID, pricing FROM carriers 
//             WHERE carrier_ID = ? AND contract = 1 AND DATE(contract_valid_upto) >= CURDATE()
//         `, [carrier_ID]);

//         if (!carrierRows.length) {
//             return res.status(400).json({ message: 'Invalid or expired contracted carrier.' });
//         }

//         const selectedCarrier = carrierRows[0];

//         const [orderRows] = await db.query(`
//             SELECT total_weight, total_distance, allocated_packages FROM orders WHERE order_ID = ?
//         `, [order_ID]);

//         if (!orderRows.length) {
//             return res.status(404).json({ message: 'Order not found.' });
//         }

//         const { total_weight, total_distance, allocated_packages } = orderRows[0];

//         let pricing = {};
//         try {
//             pricing = typeof selectedCarrier.pricing === 'string'
//                 ? JSON.parse(selectedCarrier.pricing)
//                 : selectedCarrier.pricing;
//         } catch {
//             return res.status(400).json({ message: 'Invalid pricing JSON format for carrier.' });
//         }

//         let calculatedCost = 0;
//         const assignment_cost = {
//             cost_criteria_considered: pricing.cost_criteria_per || '',
//             total_weight: null,
//             total_distance: null,
//             cost: 0
//         };

//         if (pricing.cost_criteria_per === 'ton') {
//             assignment_cost.total_weight = total_weight;
//             calculatedCost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
//         } else if (pricing.cost_criteria_per === 'km') {
//             assignment_cost.total_distance = total_distance;
//             calculatedCost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
//         }

//         assignment_cost.cost = calculatedCost.toFixed(2);
//         const cas_ID = await generateCasID();

//         let pickupLocID = null;
//         try {
//             const pkgs = typeof allocated_packages === 'string' ? JSON.parse(allocated_packages) : allocated_packages;
//             if (!Array.isArray(pkgs) || !pkgs.length) throw new Error();

//             const [packRow] = await db.query(`SELECT ship_from FROM packages WHERE pack_ID = ?`, [pkgs[0]]);
//             if (packRow.length) pickupLocID = packRow[0].ship_from;
//         } catch {
//             return res.status(400).json({ message: 'Invalid allocated_packages format or missing data.' });
//         }

//         const dockID = await findAvailableDockForCarrier(carrier_ID, pickupLocID);

//         await db.query(`
//             INSERT INTO carrier_assignments 
//             (cas_ID, order_ID, req_sent_to, assigned_time, assignment_status, assignment_cost, confirmed_to, dock_allocated, dock_allocation_status)
//             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
//         `, [
//             cas_ID,
//             order_ID,
//             JSON.stringify([carrier_ID]),
//             assigned_time,
//             'Pending',
//             JSON.stringify(assignment_cost),
//             carrier_ID,
//             dockID,
//             dockID ? 'allocated' : 'Pending'
//         ]);

//         await db.query(`UPDATE orders SET order_status = ? WHERE order_ID = ?`, ['carrier assignment', order_ID]);

//         sendAssignmentMail(carrier_ID, order_ID);

//         return res.status(201).json({
//             message: 'Carrier assignment sent to selected carrier successfully.',
//             cas_ID,
//             carrier_ID,
//             assignment_cost,
//             dock_allocated: dockID || null,
//             dock_allocation_status: dockID ? 'allocated' : 'Pending'
//         });

//     } catch (error) {
//         logger.error("Error finalizing carrier assignment:", error);
//         return res.status(500).json({ message: 'Internal Server Error', error: error.message });
//     }
// });


router.post('/finalize-carrier-assignment',jwtAuth.verifyToken,async (req, res) => {
      try {
        const { order_ID, carrier_ID, assigned_time, carrier_bill } = req.body;
        if (!order_ID || !carrier_ID || !assigned_time) {
          return res.status(400).json({
            message: 'order_ID, carrier_ID and assigned_time are required.'
          });
        }
  
        // a) fetch carrier (incl. PRO list)
        const [carrierRows] = await db.query(`
          SELECT pricing, carrier_pro_numbers
          FROM carriers
          WHERE carrier_ID = ?
            AND contract = 1
            AND DATE(contract_valid_upto) >= CURDATE()
        `, [carrier_ID]);
        if (!carrierRows.length) {
          return res.status(400).json({ message: 'Invalid or expired carrier.' });
        }
        let proList = carrierRows[0].carrier_pro_numbers;
        // ensure JS array
        if (typeof proList === 'string') {
          try { proList = JSON.parse(proList); }
          catch { return res.status(500).json({ message: 'Malformed PRO numbers.' }); }
        }
        if (!Array.isArray(proList) || proList.length === 0) {
          return res.status(400).json({
            message: `Carrier ${carrier_ID} has no PRO numbers left.`
          });
        }
        // b) pop off one PRO
        const assignedPro = proList.shift();
  
        // c) recalc cost
        let pricing = carrierRows[0].pricing;
        if (typeof pricing === 'string') {
          try { pricing = JSON.parse(pricing); }
          catch { return res.status(400).json({ message: 'Invalid pricing JSON.' }); }
        }
  
        const [orderRows] = await db.query(`
          SELECT total_weight, total_distance, allocated_packages
          FROM orders
          WHERE order_ID = ?
        `, [order_ID]);
        if (!orderRows.length) {
          return res.status(404).json({ message: 'Order not found.' });
        }
        const { total_weight, total_distance, allocated_packages } = orderRows[0];
  
        let cost = 0;
        const assignment_cost = {
          cost_criteria_considered: pricing.cost_criteria_per,
          total_weight: null,
          total_distance: null,
          cost: 0
        };
        if (pricing.cost_criteria_per === 'ton') {
          assignment_cost.total_weight = total_weight;
          cost = (parseFloat(pricing.cost) || 0) * (parseFloat(total_weight) / 1000);
        } else { // assume km
          assignment_cost.total_distance = total_distance;
          cost = (parseFloat(pricing.cost) || 0) * parseFloat(total_distance);
        }
        assignment_cost.cost = cost.toFixed(2);
  
        // d) write back remaining PRO list
        await db.query(`
          UPDATE carriers
          SET carrier_pro_numbers = ?
          WHERE carrier_ID = ?
        `, [ JSON.stringify(proList), carrier_ID ]);
  
        // e) derive pickupLocID from the first allocated package
        let pickupLocID = null;
        let allocatedPackages;
        try {
          allocatedPackages = typeof allocated_packages === 'string'
            ? JSON.parse(allocated_packages)
            : allocated_packages;
          if (!Array.isArray(allocatedPackages) || !allocatedPackages.length) {
            throw new Error();
          }
          const [pkgRows] = await db.query(
            `SELECT ship_from FROM packages WHERE pack_ID = ?`,
            [allocatedPackages[0]]
          );
          if (!pkgRows.length) throw new Error();
          pickupLocID = pkgRows[0].ship_from;
        } catch {
          return res.status(400).json({ message: 'Could not determine pickup location.' });
        }
  
        // f) insert into carrier_assignments
        const cas_ID = await generateCasID();
        const dockID = await findAvailableDockForCarrier(carrier_ID, pickupLocID);
  
        await db.query(`
          INSERT INTO carrier_assignments
            (cas_ID, order_ID, req_sent_to, assigned_time,
             assignment_status, assignment_cost, confirmed_to,
             dock_allocated, dock_allocation_status, carrier_bill,
             assigned_pro_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          cas_ID,
          order_ID,
          JSON.stringify([carrier_ID]),
          assigned_time,
          'Pending',
          JSON.stringify(assignment_cost),
          carrier_ID,
          dockID,
          dockID ? 'allocated' : 'Pending',
          JSON.stringify(carrier_bill || []),
          assignedPro
        ]);
  
        await db.query(
          `UPDATE orders SET order_status = ? WHERE order_ID = ?`,
          ['carrier assignment', order_ID]
        );
  
        sendAssignmentMail(carrier_ID, order_ID);
  
        return res.status(201).json({
          message: 'Carrier assignment finalized.',
          cas_ID,
          carrier_ID,
          assigned_pro_number: assignedPro,
          assignment_cost,
          dock_allocated: dockID || null,
          dock_allocation_status: dockID ? 'allocated' : 'Pending'
        });
      }
      catch (err) {
        logger.error('Error in /finalize-carrier-assignment:', err);
        return res.status(500).json({ message: 'Internal Server Error', error: err.message });
      }
    }
  );
  

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
                assignment_status = 'carrier confirmed',
                dock_allocation_status = 'Pending'
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



//carrier side pending to book a dock
router.get('/get-pending-dock', jwtAuth.verifyToken,async(req,res)=>{
    try{
    const { carrier_ID } = req.query;
        if (!carrier_ID) {
            return res.status(400).json({ message: 'Please provide carrier_ID in query.' });
        }
        const [result] = await db.query(`
            SELECT * FROM carrier_assignments 
            WHERE dock_allocation_status = 'Pending'
               AND confirmed_to = ?
        `, [carrier_ID]);
    
        res.status(200).json({ data: result });
    }catch(error){
        logger.error("Error fetching assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});



//reqs from carrier to user to allocate dock
router.get('/get-dock-reqs', jwtAuth.verifyToken,async(req,res)=>{
    try{
        const [result] = await db.query(`
            SELECT * FROM carrier_assignments 
            WHERE dock_allocation_status = 'requested'
        `,);
    
        res.status(200).json({ data: result });
    }catch(error){
        logger.error("Error fetching assignment:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Carrier schedules dock time
router.put('/schedule-dock-time', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { cas_ID, order_ID, dock_time_requested } = req.body;

        if (!cas_ID || !order_ID || !dock_time_requested) {
            return res.status(400).json({ message: 'cas_ID, order_ID and dock_time_requested are required in the body.' });
        }

        const [orderRows] = await db.query(`SELECT allocated_packages FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderRows.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        let allocatedPackages = [];
        try {
            const raw = orderRows[0].allocated_packages || '[]';
            allocatedPackages = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (err) {
            return res.status(400).json({ message: 'Invalid JSON format in allocated_packages.' });
        }

        if (!Array.isArray(allocatedPackages) || allocatedPackages.length === 0) {
            return res.status(400).json({ message: 'No allocated packages for this order.' });
        }

        const [packageRow] = await db.query(
            `SELECT pickup_date_time FROM packages WHERE pack_ID = ? LIMIT 1`,
            [allocatedPackages[0]]
        );

        if (!packageRow.length) {
            return res.status(404).json({ message: 'Package data not found.' });
        }

        const pickupDateTime = new Date(packageRow[0].pickup_date_time);
        const requestedTime = new Date(dock_time_requested);

        if (isNaN(pickupDateTime.getTime()) || isNaN(requestedTime.getTime())) {
            return res.status(400).json({ message: 'Invalid date format in pickup_date_time or dock_time_requested.' });
        }

        const oneHourBeforePickup = new Date(pickupDateTime);
        oneHourBeforePickup.setHours(oneHourBeforePickup.getHours() - 1);

        if (requestedTime.getTime() > oneHourBeforePickup.getTime()) {
            return res.status(400).json({
                message: `Dock time must be at least one hour before pickup time: ${pickupDateTime.toISOString()}`
            });
        }

        await db.query(
            `UPDATE carrier_assignments 
             SET dock_time_requested = ?, dock_allocation_status = 'requested' 
             WHERE cas_ID = ?`,
            [dock_time_requested, cas_ID]
        );

        return res.status(200).json({
            message: 'Dock time scheduled successfully.',
            cas_ID,
            dock_time_requested,
            status: 'requested'
        });
    } catch (error) {
        logger.error('Error scheduling dock time:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
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
            assignment_cost,
            assigned_time,
            confirmed_time,
            assignment_status
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
        if (assignment_cost) {
            updateFields.push("assignment_cost = ?");
            values.push(assignment_cost);
        }
        if (assigned_time) {
            updateFields.push("assigned_time = ?");
            values.push(assigned_time);
        }
        if (confirmed_time) {
            updateFields.push("confirmed_time = ?");
            values.push(confirmed_time);
        }
        if (assignment_status) {
            updateFields.push("assignment_status = ?");
            values.push(assignment_status);
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
