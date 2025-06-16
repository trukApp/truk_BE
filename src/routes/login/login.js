const express = require('express');
const router = express.Router();
const db = require('../../../dbConnection');
const jwtAuth = require('../../JWT/jwtAuth');
const messages = require('../../responses/res_messages');
const {logger} = require('../../logger/logger');
const nodemailer = require('nodemailer');


const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: {
    user: 'jaimptrust@gmail.com',
    pass: 'rzwo ionh krdm zpdp '
  }
});


router.post('/login', async (req, res) => {
  const { email, mobile, password } = req.body;


  if ((!email && !mobile) || !password) {
      return res.status(400).json({ message: 'Email/Mobile and password are required.' });
  }


  try {
      const [userResult] = await db.query(
          'SELECT * FROM signup WHERE (email = ? OR mobile = ?)',
          [email, mobile]
      );


      if (userResult.length === 0) {
          return res.status(404).json({ message: 'User not found. Please sign up first.' });
      }


      const user = userResult[0];


      if (user.password !== password) {
          return res.status(401).json({ message: 'Invalid password.' });
      }


      const accessToken = jwtAuth.generateToken(user.profile_id, user.user_type);
      const refreshToken = jwtAuth.generateRefreshToken(user.profile_id, user.user_type);


      return res.status(200).json({
          message: 'Login successful.',
          accessToken,
          refreshToken,
         "profile_id": user.profile_id
      });
  } catch (error) {
      logger.error('Login error:', error);
      return res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});


// router.post('/user-check', async (req, res) => {
//   const { mobile } = req.body;


//   if (!mobile) {
//     return res.status(400).json({ message: 'Mobile number is required' });
//   }


//   try {
//     const [userRows] = await db.query('SELECT * FROM login_data WHERE mobile = ?', [mobile]);


//     if (userRows.length === 0) {
//       return res.status(404).json({ message: 'User not found' });
//     }


//     const user = userRows[0];


//     const [profileRows] = await db.query('SELECT * FROM profile_data WHERE login_id = ?', [user.login_id]);


//     const accessToken = jwtAuth.generateToken(user.login_id, user.user_type);
//     const refreshToken = jwtAuth.generateRefreshToken(user.login_id, user.user_type);


//     res.json({
//       user: {
//         ...user,
//         profile: profileRows[0] || {},
//         accessToken,
//         refreshToken
//       }
//     });
//   } catch (error) {
//     console.error('Error during login:', error);
//     res.status(500).json({ message: messages.FAILED });
//   }
// });




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




router.post('/refresh-token', (req, res) => {


  const refreshTokenValue = req.body.refreshToken;
  jwtAuth.refreshToken(req, res, (err, newAccessToken) => {
      if (err) {
          return res.status(403).json({ message: messages.FORBID});
      }
      res.status(200).json({ accessToken: newAccessToken });
  });
});




router.post('/forgot-pin', async (req, res) => {
  const { email } = req.body;


  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }


  try {
    const [userRows] = await db.query('SELECT * FROM signup WHERE email = ?', [email]);


    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }


    const otp = Math.floor(100000 + Math.random() * 900000);


    await db.query('UPDATE signup SET otp = ? WHERE email = ?', [otp, email]);


    const mailOptions = {
      from: 'jaimptrust@gmail.com',
      to: email,
      subject: 'Your OTP for PIN reset',
      text: `Your OTP for resetting your PIN is: ${otp}`
    };


    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        logger.error('Error sending OTP email:', error);
        return res.status(500).json({ message: 'Failed to send OTP email' });
      }
      return res.status(200).json({ message: 'OTP sent to your email' });
    });


  } catch (error) {
    logger.error('Error during OTP generation:', error);
    return res.status(500).json({ message: 'Failed to process OTP request' });
  }
});






router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;


  if (!email || !otp) {
    return res.status(400).json({ message: 'Email and OTP are required' });
  }


  try {
    const [userRows] = await db.query('SELECT * FROM signup WHERE email = ? AND otp = ?', [email, otp]);


    if (userRows.length === 0) {
      return res.status(400).json({ message: 'Invalid OTP or email' });
    }


    return res.status(200).json({ message: 'OTP verified successfully' });


  } catch (error) {
    logger.error('Error during OTP verification:', error);
    return res.status(500).json({ message: 'Failed to verify OTP' });
  }
});




router.put('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;


  if (!email || !newPassword) {
    return res.status(400).json({ message: 'Email and new Password are required' });
  }


  try {
    const [userRows] = await db.query('SELECT password FROM signup WHERE email = ?', [email]);


    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }


    const currentPin = userRows[0].password;


    if (newPassword === currentPin) {
      return res.status(400).json({ message: 'New Password cannot be the same as the current PIN' });
    }


    await db.query('UPDATE signup SET password = ?, otp = NULL WHERE email = ?', [newPassword, email]);


    return res.status(200).json({ message: 'PIN reset successfully' });


  } catch (error) {
    logger.error('Error during PIN reset:', error);
    return res.status(500).json({ message: 'Failed to reset PIN' });
  }
});


module.exports = router;



