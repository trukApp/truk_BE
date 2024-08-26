const jwt = require('jsonwebtoken');
const logger = require('../logger/logger');
const messages = require('../responses/res_messages');

require('dotenv').config();

const secretKey = process.env.SECRET_KEY_JWT;

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

  function generateToken(userId, userType) {
    return jwt.sign({ userId, userType }, secretKey, { expiresIn: '24h' });
  }

  const tokenBlacklist = new Set();

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


  function isBlacklisted(token) {
      return tokenBlacklist.has(token);
  }


function verifyToken(req, res, next) {
  const tokenHeader = req.headers.authorization;
  if (!tokenHeader) {
      return res.status(401).json({ message: messages.UNAUTH });
  }

  const token = tokenHeader.split(' ')[1];

  if (tokenBlacklist.has(token)) {
      const now = Math.floor(Date.now() / 1000);
      const expirationTimestamp = getExpirationTimestampFromToken(token);
      if (expirationTimestamp && now > expirationTimestamp) {
          tokenBlacklist.delete(token);
      } else {
          return res.status(401).json({ message: 'Token is blacklisted' });
      }
  }

  jwt.verify(token, secretKey, (err, decoded) => {
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


function generateRefreshToken(userId, userType) {
    return jwt.sign({ userId, userType }, secretKey, { expiresIn: '7d' });
  }


function refreshToken(req, res) {
  const refreshToken = req.body.refreshToken;
  jwt.verify(refreshToken, secretKey, (err, decoded) => {
    logger.info("Decoded:", decoded);
    if (err) {
      logger.error('Refresh token verification error:', err);
      return res.status(403).json({ message: messages.FORBID });
    }

    const { userId, userType } = decoded;
    const newAccessToken = generateToken(userId, userType);
    res.json({ accessToken: newAccessToken });
  });
}


  module.exports = { generateToken, verifyToken, refreshToken, generateRefreshToken, addToBlacklist, isBlacklisted};
   


