const express = require('express');
const router = express.Router();
const connection = require('../../../dbConnection'); 
const { verifyToken } = require('../../JWT/jwtAuth');
const logger = require('../../logger/logger');
const responses = require('../../responses/res_messages');


router.get('/get-user', verifyToken, async (req, res) => {
    const { profile_id } = req.query;

    if (!profile_id) {
        return res.status(400).json({ message: 'Profile ID is required.' });
    }

    try {
        const [profileData] = await connection.query(
            'SELECT * FROM profile_data WHERE profile_id = ?', 
            [profile_id]
        );

        if (profileData.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const loginId = profileData[0].login_id;

        const [loginData] = await connection.query(
            'SELECT * FROM login_data WHERE login_id = ?', 
            [loginId]
        );

        if (loginData.length === 0) {
            return res.status(404).json({ message: 'Login data not found for this user.' });
        }

        const userData = {
            ...loginData[0],
            ...profileData[0]
        };

        return res.status(200).json(userData);
    } catch (error) {
        logger.error('Error fetching user data: ' + error.message);
        return res.status(500).json({ message: responses.FAILED });
    }
});



router.put('/edit-user', verifyToken, async (req, res) => {
    const { profile_id } = req.query;
    const { name, surname, email, profile_image, place_of_birth, current_address, residence_type, father_name, mother_name, siblings_name, spouse, children, occupation } = req.body;

    if (!profile_id) {
        return res.status(400).json({ message: 'Profile ID is required.' });
    }

    try {
        const [profileData] = await connection.query(
            'SELECT * FROM profile_data WHERE profile_id = ?', 
            [profile_id]
        );

        if (profileData.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const loginId = profileData[0].login_id;

        const updateLoginDataQuery = `
            UPDATE login_data 
            SET 
                name = COALESCE(?, name), 
                surname = COALESCE(?, surname), 
                email = COALESCE(?, email)
            WHERE login_id = ?
        `;
        await connection.query(updateLoginDataQuery, [name, surname, email, loginId]);

        const updateProfileDataQuery = `
            UPDATE profile_data 
            SET 
                profile_image = COALESCE(?, profile_image),
                place_of_birth = COALESCE(?, place_of_birth),
                current_address = COALESCE(?, current_address),
                residence_type = COALESCE(?, residence_type),
                father_name = COALESCE(?, father_name),
                mother_name = COALESCE(?, mother_name),
                siblings_name = COALESCE(?, siblings_name),
                spouse = COALESCE(?, spouse),
                children = COALESCE(?, children),
                occupation = COALESCE(?, occupation)
            WHERE profile_id = ?
        `;
        await connection.query(updateProfileDataQuery, [
            JSON.stringify(profile_image), place_of_birth, current_address, 
            residence_type, father_name, mother_name, 
            JSON.stringify(siblings_name), spouse, JSON.stringify(children), occupation, profile_id
        ]);

        const [updatedProfileData] = await connection.query(
            'SELECT * FROM profile_data WHERE profile_id = ?', 
            [profile_id]
        );

        const [updatedLoginData] = await connection.query(
            'SELECT * FROM login_data WHERE login_id = ?', 
            [loginId]
        );

        const updatedUserData = {
            ...updatedProfileData[0],
            ...updatedLoginData[0]
        };

        logger.info(`User data updated successfully for profile_id: ${profile_id}`);
        return res.status(200).json({
            message: 'User data updated successfully.',
            data: updatedUserData
        });
    } catch (error) {
        logger.error('Error updating user data: ' + error.message);
        return res.status(500).json({ message: 'Error updating user data' });
    }
});

module.exports = router;



