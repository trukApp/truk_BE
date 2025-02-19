require('dotenv').config();
const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');


function toRadians(degrees) {
    return degrees * Math.PI / 180;
}


function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = 
        Math.sin(dLat/2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon/2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; 
}


router.post('/validate-route', jwtAuth.verifyToken, async (req, res) => {
    try {
        const { order_ID, vehicle_ID, start_lat, start_lng, end_lat, end_lng, actual_distance_traveled } = req.body;

        if (!order_ID || !vehicle_ID || !start_lat || !start_lng || !end_lat || !end_lng || !actual_distance_traveled) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        const [orderData] = await db.query(`SELECT allocations FROM orders WHERE order_ID = ?`, [order_ID]);
        if (!orderData.length) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        let storedAllocations = orderData[0].allocations;

        if (typeof storedAllocations === "string") {
            try {
                storedAllocations = JSON.parse(storedAllocations);
            } catch (error) {
                return res.status(500).json({ message: 'Error parsing stored route data.', error: error.message });
            }
        }

        if (!storedAllocations || storedAllocations.length === 0) {
            return res.status(400).json({ message: 'No route found for this order.' });
        }

        const vehicleData = storedAllocations.find(alloc => alloc.vehicle_ID === vehicle_ID);
        if (!vehicleData) {
            return res.status(404).json({ message: `Vehicle ${vehicle_ID} not found in this order.` });
        }

        const storedRoute = vehicleData.route;
        if (!storedRoute || storedRoute.length === 0) {
            return res.status(400).json({ message: `No route data found for vehicle ${vehicle_ID}.` });
        }

        let expectedDistance = storedRoute.reduce((sum, leg) => {
            return sum + parseFloat(leg.distance.replace(' km', ''));
        }, 0);

        const plannedStart = storedRoute[0].start;
        const plannedEnd = storedRoute[storedRoute.length - 1].end;

        const startDeviation = haversineDistance(start_lat, start_lng, plannedStart.latitude, plannedStart.longitude);
        const endDeviation = haversineDistance(end_lat, end_lng, plannedEnd.latitude, plannedEnd.longitude);

        const allowedDeviationKM = 5;
        const allowedDistancePercentage = 0.10;

        let deviationDetected = false;
        let deviationReasons = [];

        if (startDeviation > allowedDeviationKM) {
            deviationDetected = true;
            deviationReasons.push(`Start location deviated by ${startDeviation.toFixed(2)} km.`);
        }

        if (endDeviation > allowedDeviationKM) {
            deviationDetected = true;
            deviationReasons.push(`End location deviated by ${endDeviation.toFixed(2)} km.`);
        }

        const distanceDifference = Math.abs(actual_distance_traveled - expectedDistance);
        if (distanceDifference > expectedDistance * allowedDistancePercentage) {
            deviationDetected = true;
            deviationReasons.push(`Expected distance: ${expectedDistance.toFixed(2)} km, but driver traveled ${actual_distance_traveled.toFixed(2)} km.`);
        }

        let skippedWaypoints = [];
        for (const leg of storedRoute) {
            const legStart = leg.start;
            const legEnd = leg.end;
            
            const startCheck = haversineDistance(start_lat, start_lng, legStart.latitude, legStart.longitude) < allowedDeviationKM;
            const endCheck = haversineDistance(end_lat, end_lng, legEnd.latitude, legEnd.longitude) < allowedDeviationKM;

            if (!startCheck && !endCheck) {
                skippedWaypoints.push(leg.end.address);
            }
        }

        if (skippedWaypoints.length > 0) {
            deviationDetected = true;
            deviationReasons.push(`Skipped waypoints: ${skippedWaypoints.join(', ')}`);
        }

        return res.status(200).json({
            message: deviationDetected ? 'Route deviation detected' : 'Driver followed the assigned route',
            order_ID,
            vehicle_ID,
            expected_distance: `${expectedDistance.toFixed(2)} km`,
            actual_distance: `${actual_distance_traveled.toFixed(2)} km`,
            start_deviation_km: startDeviation.toFixed(2),
            end_deviation_km: endDeviation.toFixed(2),
            skipped_waypoints: skippedWaypoints,
            deviation_detected: deviationDetected,
            deviation_reasons: deviationDetected ? deviationReasons : []
        });

    } catch (error) {
        logger.error('Error validating route:', error);
        return res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

module.exports = router;
