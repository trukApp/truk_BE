require('dotenv').config();
const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');

function toRadians(deg) {
    return deg * Math.PI / 180;
}
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat/2)**2 +
        Math.cos(toRadians(lat1))*Math.cos(toRadians(lat2))*
        Math.sin(dLon/2)**2;
    const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R*c;
}

router.post('/validate-route', jwtAuth.verifyToken, async (req, res) => {
    try {
        const {
            order_ID,
            vehicle_ID,
            start_lat,
            start_lng,
            end_lat,
            end_lng,
            actual_distance_traveled,
            driverRoute 
        } = req.body;

        if (!order_ID || !vehicle_ID || start_lat==null || start_lng==null ||
            end_lat==null || end_lng==null || actual_distance_traveled==null ||
            !Array.isArray(driverRoute)) {
            return res.status(400).json({
                message: 'Missing fields or driverRoute is not an array.'
            });
        }

        const [orderRows] = await db.query(`
            SELECT allocations 
            FROM orders 
            WHERE order_ID = ?
        `, [order_ID]);
        if (!orderRows.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        let storedAllocations= orderRows[0].allocations;
        if (typeof storedAllocations==='string') {
            try {
                storedAllocations = JSON.parse(storedAllocations);
            } catch(err) {
                return res.status(500).json({
                    message: 'Error parsing route data.',
                    error: err.message
                });
            }
        }

        if (!Array.isArray(storedAllocations) || storedAllocations.length===0) {
            return res.status(400).json({
                message: 'No route found in this order.'
            });
        }

        const vehicleAlloc= storedAllocations.find(
            alloc=> alloc.vehicle_ID=== vehicle_ID
        );
        if (!vehicleAlloc) {
            return res.status(404).json({
                message: `Vehicle ${vehicle_ID} not found in order ${order_ID}.`
            });
        }

        const route = vehicleAlloc.route;
        if (!Array.isArray(route) || route.length===0) {
            return res.status(400).json({
                message: `No route legs for vehicle ${vehicle_ID}.`
            });
        }
        let expectedDistance=0;
        for (const leg of route) {
            if (leg.distance) {
                const distKM= parseFloat(leg.distance.replace(' km',''));
                if (!isNaN(distKM)) {
                    expectedDistance+= distKM;
                }
            }
        }

        const plannedStart= route[0].start;
        const plannedEnd  = route[route.length-1].end;
        const startDev= haversineDistance(start_lat, start_lng, plannedStart.latitude, plannedStart.longitude);
        const endDev  = haversineDistance(end_lat, end_lng, plannedEnd.latitude, plannedEnd.longitude);

        const allowedDeviation= 5; 
        const maxDistancePct= 0.10;

        let deviationDetected= false;
        let deviationReasons= [];

        if (startDev> allowedDeviation) {
            deviationDetected= true;
            deviationReasons.push(
                `Start location deviated by ${startDev.toFixed(2)} km.`
            );
        }
        if (endDev> allowedDeviation) {
            deviationDetected= true;
            deviationReasons.push(
                `End location deviated by ${endDev.toFixed(2)} km.`
            );
        }

        const distanceDiff= Math.abs(actual_distance_traveled - expectedDistance);
        if (distanceDiff> expectedDistance* maxDistancePct) {
            deviationDetected= true;
            deviationReasons.push(
                `Expected distance: ${expectedDistance.toFixed(2)} km, but driver traveled ${actual_distance_traveled.toFixed(2)} km.`
            );
        }


        let routePoints= Array.isArray(vehicleAlloc.sampledRoutePoints)
            ? vehicleAlloc.sampledRoutePoints
            : [];
        let driverPointDeviations= [];

        for (const dpt of driverRoute) {
            const { lat, lng, timestamp } = dpt;
            if (lat==null || lng==null) {
                continue;
            }

            const timeLabel = timestamp || 'unknown-time';

            let minDist= Infinity;
            for (const rpt of routePoints) {
                const distKM= haversineDistance(lat, lng, rpt.lat, rpt.lng);
                if (distKM< minDist) {
                    minDist= distKM;
                }
                if (minDist< allowedDeviation) {
                    break;
                }
            }

            if (minDist> allowedDeviation) {
                deviationDetected= true;
                driverPointDeviations.push({
                    lat,
                    lng,
                    time: timeLabel,
                    deviationDistanceKM: minDist.toFixed(2),
                    reason: `Driver >${allowedDeviation}km from route`
                });
            }
        }

        if (driverPointDeviations.length>0) {
            deviationReasons.push(
                `Driver had ${driverPointDeviations.length} off-route points`
            );
        }

        return res.status(200).json({
            message: deviationDetected
                ? 'Route deviation detected'
                : 'Driver followed the assigned route',
            order_ID,
            vehicle_ID,
            expected_distance: `${expectedDistance.toFixed(2)} km`,
            actual_distance: `${actual_distance_traveled.toFixed(2)} km`,
            start_deviation_km: startDev.toFixed(2),
            end_deviation_km:   endDev.toFixed(2),
            deviation_detected: deviationDetected,
            deviation_reasons: deviationReasons,
            driverPointDeviations
        });
    } catch (err) {
        logger.error('Error validating route:', err);
        return res.status(500).json({
            message: 'Server error.',
            error: err.message
        });
    }
});

module.exports= router;
