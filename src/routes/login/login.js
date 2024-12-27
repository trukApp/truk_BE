const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const jwtAuth = require('../../JWT/jwtAuth');
const messages = require('../../responses/res_messages');


router.post('/login', async (req, res) => {
  const { email, mobile, password } = req.body;

  if ((!email && !mobile) || !password) {
      return res.status(400).json({ message: 'Email/Mobile and password are required.' });
  }

  try {
      // Fetch user based on email or mobile
      const [userResult] = await db.query(
          'SELECT * FROM dummy_signup WHERE (email = ? OR mobile = ?)',
          [email, mobile]
      );

      if (userResult.length === 0) {
          return res.status(404).json({ message: 'User not found. Please sign up first.' });
      }

      const user = userResult[0];

      // Compare the provided password directly
      if (user.password !== password) {
          return res.status(401).json({ message: 'Invalid password.' });
      }

      // Generate JWT token
      const accessToken = jwtAuth.generateToken(user.profile_id, user.user_type);
      const refreshToken = jwtAuth.generateRefreshToken(user.profile_id, user.user_type);

      return res.status(200).json({
          message: 'Login successful.',
          accessToken,
          refreshToken,
          user: user,
      });
  } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});

router.post('/user-check', async (req, res) => {
  const { mobile } = req.body;

  if (!mobile) {
    return res.status(400).json({ message: 'Mobile number is required' });
  }

  try {
    const [userRows] = await db.query('SELECT * FROM login_data WHERE mobile = ?', [mobile]);

    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRows[0];

    const [profileRows] = await db.query('SELECT * FROM profile_data WHERE login_id = ?', [user.login_id]);

    const accessToken = jwtAuth.generateToken(user.login_id, user.user_type);
    const refreshToken = jwtAuth.generateRefreshToken(user.login_id, user.user_type);

    res.json({
      user: {
        ...user,
        profile: profileRows[0] || {},
        accessToken,
        refreshToken
      }
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ message: messages.FAILED });
  }
});


router.post('/logout', async (req, res) => {
    try {
        // const user = req.body.user_id;
        // const sql = `SELECT external_id FROM onelove_v2.users WHERE user_id =?`;
        // const [sqlResult] = await connection.query(sql, user);
        // logger.info("sqlResult", sqlResult);
        // const uuId = sqlResult[0].external_id;
        // logger.info('external id', uuId);

        const tokenHeader = req.headers.authorization;
        if (tokenHeader) {
            const token = tokenHeader.split(' ')[1];
            jwtAuth.addToBlacklist(token);
        }
        return res.status(200).json({
            message: messages.LOGOUT
        });
    } catch (err) {
        logger.error("Error", err);
        return res.status(400).json({ message: messages.LOGOUT_FAILED });
    }
});

module.exports = router;
