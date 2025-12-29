const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const { applyPagination } = require('../../pagination/paginate');
const jwtAuth = require('../../JWT/jwtAuth');


function safeParseJSON(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    try {
        return JSON.parse(val);
    } catch {
        return [];
    }
}



const generateAssignID = async () => {
    try {
        const [result] = await db.query(
            `SELECT assign_ID FROM assigning_orders ORDER BY LENGTH(assign_ID) DESC, assign_ID DESC LIMIT 1`
        );

        let nextID = "AO000001";
        if (result.length > 0 && result[0].assign_ID) {
            let lastID = result[0].assign_ID;
            let numPart = parseInt(lastID.slice(2)) + 1;
            let numDigits = numPart.toString().length;
            let requiredZeros = Math.max(6 - numDigits, 0);
            nextID = `AO${"0".repeat(requiredZeros)}${numPart}`;
        }

        return nextID;
    } catch (error) {
        logger.error("Error generating assign_ID:", error);
        throw new Error("Failed to generate assign_ID");
    }
};

router.post('/assign-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID, assigned_vehicle_data, self_transport, pod, pod_doc } = req.body;

        if (!order_ID) {
            return res.status(400).json({ message: "order_ID is required." });
        }

        const assign_ID = await generateAssignID();

        await db.query(
            `INSERT INTO assigning_orders (assign_ID, order_ID, assigned_vehicle_data, self_transport, pod, pod_doc)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [assign_ID, order_ID, JSON.stringify(assigned_vehicle_data), self_transport, JSON.stringify(pod), pod_doc]
        );

        await db.query(
            `UPDATE orders SET order_status = ? WHERE order_ID = ?`,
            ['self assigned', order_ID]
        );

        res.status(201).json({ message: "Assigned order created successfully", assign_ID });
    } catch (error) {
        logger.error("Error assigning order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.get('/assigned-orders', jwtAuth.verifyToken, async (req, res) => {
    try {
        let { page, limit } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;

        let query = `SELECT * FROM assigning_orders ORDER BY assigning_id DESC`;
        let paginatedQuery = applyPagination(query, page, limit);

        const [result] = await db.query(paginatedQuery);
        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching assigned orders:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});


router.get('/all-assigned-orders', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;

        /* -----------------------------------------
           1️⃣ FETCH SELF-ASSIGNED ORDERS
        ----------------------------------------- */
        const [orders] = await db.query(
            `SELECT *
       FROM orders
       WHERE order_status = 'self assigned'
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
            [Number(limit), Number(offset)]
        );

        if (!orders.length) {
            return res.status(404).json({
                message: 'No self assigned orders found.'
            });
        }

        const orderIDs = orders.map(o => o.order_ID);

        /* -----------------------------------------
           2️⃣ FETCH ASSIGNMENTS
        ----------------------------------------- */
        const [assignments] = await db.query(
            `SELECT *
       FROM assigning_orders
       WHERE order_ID IN (?) AND self_transport = 1`,
            [orderIDs]
        );

        /* -----------------------------------------
           3️⃣ MAP ASSIGNMENTS BY ORDER_ID
        ----------------------------------------- */
        const assignmentMap = {};
        const driverIDs = new Set();

        assignments.forEach(a => {
            const vehicles = safeParseJSON(a.assigned_vehicle_data);

            vehicles.forEach(v => {
                if (v.dri_ID) driverIDs.add(v.dri_ID);
            });

            if (!assignmentMap[a.order_ID]) {
                assignmentMap[a.order_ID] = [];
            }

            assignmentMap[a.order_ID].push({
                assign_ID: a.assign_ID,
                vehicles,
                pod: a.pod,
                pod_doc: a.pod_doc,
                a_order_status: a.assigned_order_status
            });
        });

        /* -----------------------------------------
           4️⃣ FETCH DRIVERS
        ----------------------------------------- */
        let driverMap = {};
        if (driverIDs.size) {
            const [drivers] = await db.query(
                `SELECT dri_ID, driver_name, locations, vehicle_types,
                driver_correspondence, logged_in, driver_availability
         FROM master_drivers
         WHERE dri_ID IN (?)`,
                [[...driverIDs]]
            );

            drivers.forEach(d => {
                driverMap[d.dri_ID] = d;
            });
        }

        /* -----------------------------------------
           5️⃣ BUILD FINAL RESPONSE
        ----------------------------------------- */
        const response = orders.map(order => {
            const assigns = assignmentMap[order.order_ID] || [];

            const enrichedAssignments = assigns.map(a => ({
                ...a,
                vehicles: a.vehicles.map(v => ({
                    ...v,
                    driver: driverMap[v.dri_ID] || null
                }))
            }));

            return {
                ...order,
                assignments: enrichedAssignments
            };
        });

        return res.status(200).json({
            message: 'Self assigned orders fetched successfully',
            page: Number(page),
            limit: Number(limit),
            count: response.length,
            orders: response
        });

    } catch (error) {
        logger.error('Error fetching self assigned orders', error);
        return res.status(500).json({
            message: 'Server error',
            error: error.message
        });
    }
});


router.get('/assigned-order-by-id', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID } = req.query;

        if (!order_ID) {
            return res.status(400).json({
                message: 'order_ID is required'
            });
        }

        /* -----------------------------------------
           1️⃣ FETCH ORDER (SELF ASSIGNED ONLY)
        ----------------------------------------- */
        const [orders] = await db.query(
            `SELECT *
       FROM orders
       WHERE order_ID = ?
         AND order_status = 'self assigned'
       LIMIT 1`,
            [order_ID]
        );

        if (!orders.length) {
            return res.status(404).json({
                message: 'Order not found or not self assigned'
            });
        }

        const order = orders[0];

        /* -----------------------------------------
           2️⃣ FETCH ASSIGNMENTS
        ----------------------------------------- */
        const [assignments] = await db.query(
            `SELECT *
       FROM assigning_orders
       WHERE order_ID = ?
         AND self_transport = 1`,
            [order_ID]
        );

        /* -----------------------------------------
           3️⃣ COLLECT DRIVER IDs
        ----------------------------------------- */
        const driverIDs = new Set();
        const assignmentMap = [];

        assignments.forEach(a => {
            const vehicles = safeParseJSON(a.assigned_vehicle_data);

            vehicles.forEach(v => {
                if (v.dri_ID) driverIDs.add(v.dri_ID);
            });

            assignmentMap.push({
                assign_ID: a.assign_ID,
                vehicles,
                pod: a.pod,
                pod_doc: a.pod_doc,
                a_order_status: a.assigned_order_status
            });
        });

        /* -----------------------------------------
           4️⃣ FETCH DRIVERS
        ----------------------------------------- */
        let driverMap = {};
        if (driverIDs.size) {
            const [drivers] = await db.query(
                `SELECT dri_ID, driver_name, locations, vehicle_types,
                driver_correspondence, logged_in, driver_availability
         FROM master_drivers
         WHERE dri_ID IN (?)`,
                [[...driverIDs]]
            );

            drivers.forEach(d => {
                driverMap[d.dri_ID] = d;
            });
        }

        /* -----------------------------------------
           5️⃣ ENRICH ASSIGNMENTS
        ----------------------------------------- */
        const enrichedAssignments = assignmentMap.map(a => ({
            ...a,
            vehicles: a.vehicles.map(v => ({
                ...v,
                driver: driverMap[v.dri_ID] || null
            }))
        }));

        /* -----------------------------------------
           6️⃣ FINAL RESPONSE
        ----------------------------------------- */
        return res.status(200).json({
            message: 'Order retrieved successfully',
            order: {
                ...order,
                assignments: enrichedAssignments
            }
        });

    } catch (error) {
        logger.error('Error fetching order by ID', error);
        return res.status(500).json({
            message: 'Server error',
            error: error.message
        });
    }
});


// router.get('/assigned-order', jwtAuth.verifyToken, async (req, res) => {
//     try {
//         const { assign_ID, order_ID, dri_ID } = req.query;

//         if (!assign_ID && !order_ID && !dri_ID) {
//             return res.status(400).json({ message: "Provide assign_ID, order_ID, or dri_ID in query." });
//         }

//         let condition = '';
//         let value = '';

//         if (assign_ID) {
//             condition = "ao.assign_ID = ?";
//             value = assign_ID;
//         } else if (order_ID) {
//             condition = "ao.order_ID = ?";
//             value = order_ID;
//         } else if (dri_ID) {
//             condition = "JSON_CONTAINS(ao.assigned_vehicle_data, JSON_QUOTE(?), '$')";
//             value = dri_ID;
//         }

//         const query = `
//             SELECT 
//                 ANY_VALUE(ao.assign_ID) AS assign_ID,
//                 ANY_VALUE(ao.order_ID) AS order_ID,
//                 ANY_VALUE(ao.self_transport) AS self_transport,
//                 ANY_VALUE(ao.pod) AS pod,
//                 ANY_VALUE(ao.pod_doc) AS pod_doc,
//                 ANY_VALUE(o.scenario_label) AS scenario_label,
//                 ANY_VALUE(o.total_cost) AS total_cost,
//                 ANY_VALUE(o.allocations) AS allocations,
//                 ANY_VALUE(o.allocated_packages) AS allocated_packages,
//                 ANY_VALUE(o.unallocated_packages) AS unallocated_packages,
//                 ANY_VALUE(o.allocated_vehicles) AS allocated_vehicles,
//                 ANY_VALUE(o.created_at) AS created_at,
//                 ANY_VALUE(o.updated_at) AS updated_at,
//                 ANY_VALUE(o.order_status) AS order_status,
//                 JSON_ARRAYAGG(
//                     JSON_OBJECT(
//                         'act_truk_ID', av.act_truk_ID,
//                         'act_vehicle_num', av.act_vehicle_num,
//                         'costing', av.costing,
//                         'driver_details', JSON_OBJECT(
//                             'dri_ID', md.dri_ID,
//                             'driver_name', md.driver_name,
//                             'address', md.address,
//                             'logged_in', md.logged_in
//                         ),
//                         'device_details', JSON_OBJECT(
//                             'dev_ID', mdv.dev_ID,
//                             'device_type', mdv.device_type,
//                             'device_UID', mdv.device_UID
//                         )
//                     )
//                 ) AS vehicle_details
//             FROM assigning_orders ao
//             LEFT JOIN orders o ON ao.order_ID = o.order_ID
//             LEFT JOIN act_vehicles av ON JSON_CONTAINS(ao.assigned_vehicle_data, JSON_QUOTE(av.act_truk_ID), '$')
//             LEFT JOIN master_drivers md ON JSON_CONTAINS(ao.assigned_vehicle_data, JSON_QUOTE(md.dri_ID), '$')
//             LEFT JOIN master_devices mdv ON JSON_CONTAINS(ao.assigned_vehicle_data, JSON_QUOTE(mdv.dev_ID), '$')
//             WHERE ${condition}
//             GROUP BY ao.assigning_id
//         `;

//         const [result] = await db.query(query, [value]);

//         res.status(200).json({ data: result });
//     } catch (error) {
//         logger.error("Error fetching assigned order:", error);
//         res.status(500).json({ message: "Internal Server Error", error: error.message });
//     }
// });


router.get('/assigned-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { assign_ID, order_ID, dri_ID } = req.query;

        if (!assign_ID && !order_ID && !dri_ID) {
            return res.status(400).json({ message: "Please provide assign_ID, order_ID, or dri_ID in query." });
        }

        let condition = '';
        let value = '';


        if (assign_ID) {
            condition = "ao.assign_ID = ?";
            value = assign_ID;
        } else if (order_ID) {
            condition = "ao.order_ID = ?";
            value = order_ID;
        } else if (dri_ID) {
            condition = "JSON_CONTAINS(ao.assigned_vehicle_data, JSON_OBJECT('dri_ID', ?), '$')";
            value = dri_ID;
        }

        const query = `
            SELECT 
                ao.assigning_id, ao.assign_ID, ao.order_ID, ao.assigned_vehicle_data, ao.self_transport, ao.pod, ao.pod_doc,ao.assigned_order_status
                o.scenario_label, o.total_cost, o.allocations, o.allocated_packages,
                o.unallocated_packages, o.allocated_vehicles, o.created_at, o.updated_at, o.order_status, o.order_docs,
            FROM assigning_orders ao
            LEFT JOIN orders o ON ao.order_ID = o.order_ID
            WHERE ${condition}
        `;

        const [result] = await db.query(query, [value]);

        res.status(200).json({ data: result });
    } catch (error) {
        logger.error("Error fetching assigned order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});



router.put('/update-assigned-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { assign_ID } = req.query;
        const { order_ID, assigned_vehicle_data, self_transport, pod, pod_doc, assigned_order_status } = req.body;

        if (!assign_ID) {
            return res.status(400).json({ message: "assign_ID is required in query." });
        }

        let updateFields = [];
        let values = [];

        if (order_ID) {
            updateFields.push("order_ID = ?");
            values.push(order_ID);
        }
        if (assigned_vehicle_data) {
            updateFields.push("assigned_vehicle_data = ?");
            values.push(JSON.stringify(assigned_vehicle_data));
        }
        if (self_transport !== undefined) {
            updateFields.push("self_transport = ?");
            values.push(self_transport);
        }
        if (pod) {
            updateFields.push("pod = ?");
            values.push(JSON.stringify(pod));
        }
        if (pod_doc) {
            updateFields.push("pod_doc = ?");
            values.push(pod_doc);
        }
        if (assigned_order_status) {
            updateFields.push("assigned_order_status = ?");
            values.push(assigned_order_status);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: "No fields provided for update." });
        }

        values.push(assign_ID);
        const query = `UPDATE assigning_orders SET ${updateFields.join(", ")} WHERE assign_ID = ?`;

        await db.query(query, values);
        res.status(200).json({ message: "Assigned order updated successfully." });
    } catch (error) {
        logger.error("Error updating assigned order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

router.delete('/delete-assigned-order', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { assigning_id } = req.query;

        if (!assigning_id) {
            return res.status(400).json({ message: "assigning_id is required in query." });
        }

        await db.query(`DELETE FROM assigning_orders WHERE assigning_id = ?`, [assigning_id]);
        res.status(200).json({ message: "Assigned order deleted successfully." });
    } catch (error) {
        logger.error("Error deleting assigned order:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

module.exports = router;
