const jwt = require('jsonwebtoken');
const {logger} = require('../logger/logger');
const messages = require('../responses/res_messages');
require('dotenv').config();

const secretKey = process.env.SECRET_KEY_JWT;

// Utility function to extract expiration timestamp from the token
function getExpirationTimestampFromToken(token) {
    try {
        const decoded = jwt.decode(token);
        if (decoded && decoded.exp) {
            return decoded.exp;
        }
    } catch (err) {
        logger.error('Error decoding token:', err);
    }
    return null;
}

// Function to generate an access token with explicit algorithm
function generateToken(userId, userType) {
    return jwt.sign({ userId, userType }, secretKey, { 
        expiresIn: '24h',
        algorithm: 'HS256'  
    });
}

// Function to generate a refresh token with explicit algorithm
function generateRefreshToken(userId, userType) {
    return jwt.sign({ userId, userType }, secretKey, { 
        expiresIn: '7d',
        algorithm: 'HS256' 
    });
}

// Token blacklist for invalidated tokens
const tokenBlacklist = new Set();

// Function to add a token to the blacklist
function addToBlacklist(token) {
    const expirationTimestamp = getExpirationTimestampFromToken(token);
    if (expirationTimestamp) {
        const now = Math.floor(Date.now() / 1000);
        const expiresIn = expirationTimestamp - now;
        setTimeout(() => {
            tokenBlacklist.delete(token);
        }, expiresIn * 1000);
    }
    tokenBlacklist.add(token);
}

// Function to check if a token is blacklisted
function isBlacklisted(token) {
    return tokenBlacklist.has(token);
}

// Middleware function to verify the token
function verifyToken(req, res, next) {
    const tokenHeader = req.headers.authorization;
    if (!tokenHeader) {
        return res.status(401).json({ message: messages.UNAUTH });
    }

    const token = tokenHeader.split(' ')[1];

    if (isBlacklisted(token)) {
        const now = Math.floor(Date.now() / 1000);
        const expirationTimestamp = getExpirationTimestampFromToken(token);
        if (expirationTimestamp && now > expirationTimestamp) {
            tokenBlacklist.delete(token);
        } else {
            return res.status(401).json({ message: 'Token is blacklisted' });
        }
    }

    jwt.verify(token, secretKey, { algorithms: ['HS256'] }, (err, decoded) => {
        logger.info("Decoded:", decoded);
        if (err) {
            logger.error('JWT verification error:', err);
            return res.status(403).json({ message: messages.FORBID });
        }

        const expirationTimestamp = getExpirationTimestampFromToken(token);
        if (expirationTimestamp && Date.now() >= expirationTimestamp * 1000) {
            return res.status(401).json({ message: 'Token has expired' });
        }

        req.userId = decoded.userId;
        req.userType = decoded.userType;
        next();
    });
}

// Function to refresh the access token using a refresh token
function refreshToken(req, res) {
    const refreshToken = req.body.refreshToken;
    jwt.verify(refreshToken, secretKey, { algorithms: ['HS256'] }, (err, decoded) => {
        if (err) {
            logger.error('Refresh token verification error:', err);
            return res.status(403).json({ message: messages.FORBID });
        }

        const { userId, userType } = decoded;
        const newAccessToken = generateToken(userId, userType);
        res.json({ accessToken: newAccessToken });
    });
}

module.exports = { 
    generateToken, 
    verifyToken, 
    refreshToken, 
    generateRefreshToken, 
    addToBlacklist, 
    isBlacklisted 
};
