const express = require('express');
const router = express.Router();
const connection = require('../../../dbConnection');
const logger = require('../../logger/logger');
const responses = require('../../responses/res_messages');


router.post('/signup', async (req, res) => {
    const { first_name, last_name, gender, mobile, email, password, user_type, otp } = req.body;

    if (!first_name || !last_name || !mobile || !email || !user_type) {
        return res.status(400).json({ message: 'Name, surname, mobile, and user_type are required.' });
    }

    try {
        const [existingUser] = await connection.query('SELECT * FROM dummy_signup WHERE mobile = ?', [mobile]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: 'Mobile number already registered.' });
        }
        
        const [existingMail] = await connection.query('SELECT * FROM dummy_signup WHERE email = ?', [email]);
        if (existingMail.length > 0) {
            return res.status(400).json({ message: 'Email already registered.' });
        }
        
        const [result] = await connection.query(
            'INSERT INTO dummy_signup (first_name, last_name, gender, mobile, email, password, user_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [first_name, last_name, gender, mobile, email, password, user_type]
        );
        
        if (result.affectedRows > 0) {
            logger.info(`User signed up successfully with mobile: ${mobile}`);
            return res.status(201).json({ message: responses.POST_SUCCESS });
        } else {
            logger.error('Failed to insert new user.');
            return res.status(500).json({ message: responses.POST_FAILED });
        }
    } catch (error) {
        logger.error('Error during signup process: ' + error.message);
        return res.status(500).json({ message: responses.FAILED });
    }
});


module.exports = router;
