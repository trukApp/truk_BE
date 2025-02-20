
// const db = require('../../dbConnection');
const db = require('../../dbConnection')
const jwtAuth = require('../JWT/jwtAuth');
const messages = require('../responses/res_messages');

const resolvers = {
  Query: {
    async userCheck(_, { mobile }) {
      console.log(mobile)
      if (!mobile) throw new Error('Mobile number is required');
      try {
        const [userRows] = await db.query('SELECT * FROM login_data WHERE mobile = ?', [mobile]);

        if (userRows.length === 0) throw new Error('User not found');

        const user = userRows[0];
        const [profileRows] = await db.query('SELECT * FROM profile_data WHERE login_id = ?', [user.login_id]);

        return {
          ...user,
          profile: profileRows[0] || {},
          accessToken: jwtAuth.generateToken(user.login_id, user.user_type),
          refreshToken: jwtAuth.generateRefreshToken(user.login_id, user.user_type),
        };
      } catch (error) {
        throw new Error(error.message);
      }
    },

    async getUser(_, { profile_id }, context) {
      const rows = await db.select().from('profile_data');
      console.log(rows);
      
    //   if (!context.user) throw new Error("Unauthorized access");
      if (!profile_id) throw new Error("Profile ID is required.");

      try {
        const [profileData] = await db.query('SELECT * FROM profile_data WHERE profile_id = ?', [profile_id]);

        if (profileData.length === 0) throw new Error("User not found.");

        const loginId = profileData[0].login_id;
        const [loginData] = await db.query('SELECT * FROM login_data WHERE login_id = ?', [loginId]);

        if (loginData.length === 0) throw new Error("Login data not found for this user.");

        return { ...loginData[0], ...profileData[0] };
      } catch (error) {
        throw new Error("Error fetching user data: " + error.message);
      }
    }
  },

  Mutation: {
    async logout(_, __, { req }) {
      try {
        const tokenHeader = req.headers.authorization;
        if (tokenHeader) {
          const token = tokenHeader.split(' ')[1];
          jwtAuth.addToBlacklist(token);
        }
        return messages.LOGOUT;
      } catch (error) {
        throw new Error(messages.LOGOUT_FAILED);
      }
    },

    async signup(_, { name, surname, mobile, email, user_type }) {
      if (!name || !surname || !mobile || !user_type) {
        throw new Error('Name, surname, mobile, and user_type are required.');
      }

      try {
        const [existingUser] = await db.query('SELECT * FROM login_data WHERE mobile = ?', [mobile]);
        if (existingUser.length > 0) {
          throw new Error('Mobile number already registered.');
        }

        const result = await db.query(
          'INSERT INTO login_data (name, surname, mobile, email, user_type) VALUES (?, ?, ?, ?, ?)',
          [name, surname, mobile, email, user_type]
        );

        if (result[0].affectedRows > 0) {
          const loginId = result[0].insertId;
          await db.query('INSERT INTO profile_data (login_id) VALUES (?)', [loginId]);

          return messages.POST_SUCCESS;
        } else {
          throw new Error(messages.POST_FAILED);
        }
      } catch (error) {
        throw new Error("Error during signup process: " + error.message);
      }
    },

    async editUser(_, args, context) {
    //   if (!context.user) throw new Error("Unauthorized access");
      const { profile_id, ...updateFields } = args;

      if (!profile_id) throw new Error("Profile ID is required.");

      try {
        const [profileData] = await db.query('SELECT * FROM profile_data WHERE profile_id = ?', [profile_id]);

        if (profileData.length === 0) throw new Error("User not found.");

        const loginId = profileData[0].login_id;

        // Update login_data table
        const updateLoginQuery = `
          UPDATE login_data 
          SET name = COALESCE(?, name), 
              surname = COALESCE(?, surname), 
              email = COALESCE(?, email)
          WHERE login_id = ?
        `;
        await db.query(updateLoginQuery, [updateFields.name, updateFields.surname, updateFields.email, loginId]);

        // Update profile_data table
        const updateProfileQuery = `
          UPDATE profile_data 
          SET profile_image = COALESCE(?, profile_image),
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
        await db.query(updateProfileQuery, [
          updateFields.profile_image, updateFields.place_of_birth, updateFields.current_address,
          updateFields.residence_type, updateFields.father_name, updateFields.mother_name,
          JSON.stringify(updateFields.siblings_name), updateFields.spouse, JSON.stringify(updateFields.children), 
          updateFields.occupation, profile_id
        ]);

        // Get updated user data
        const [updatedProfileData] = await db.query('SELECT * FROM profile_data WHERE profile_id = ?', [profile_id]);
        const [updatedLoginData] = await db.query('SELECT * FROM login_data WHERE login_id = ?', [loginId]);

        return { ...updatedLoginData[0], ...updatedProfileData[0] };
      } catch (error) {
        throw new Error("Error updating user data: " + error.message);
      }
    }
  }
};

module.exports = resolvers;
