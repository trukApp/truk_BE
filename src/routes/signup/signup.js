const express = require('express');
const router = express.Router();
const connection = require('../../../dbConnection');
const logger = require('../../logger/logger');
const responses = require('../../responses/res_messages');


router.post('/signup', async (req, res) => {

    const { name, surname, mobile, email, user_type } = req.body;

    if (!name || !surname || !mobile || !user_type) {
        return res.status(400).json({ message: 'Name, surname, mobile and user_type are required.' });
    }

    try {
        const [existingUser] = await connection.query('SELECT * FROM login_data WHERE mobile = ?', [mobile]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: 'Mobile number already registered.' });
        }
        const result = await connection.query('INSERT INTO login_data (name, surname, mobile, email, user_type) VALUES (?, ?, ?, ?, ?)', [name, surname, mobile, email, user_type]);
     
        if (result[0].affectedRows > 0) {
            const loginId = result[0].insertId; 
            await connection.query(
                'INSERT INTO profile_data (login_id) VALUES (?)', 
                [loginId]
            );
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
