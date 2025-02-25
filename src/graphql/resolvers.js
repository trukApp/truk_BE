
// const db = require('../../dbConnection');
const db = require('../../dbConnection')
const jwtAuth = require('../JWT/jwtAuth');
const messages = require('../responses/res_messages');

const resolvers = {
  Query: {
    
      async getVehicle(_, { vehicle_ID }, context) {
        // Verify token (authentication middleware)
        // if (!context.user) throw new Error("Unauthorized access");
  
        if (!vehicle_ID) {
          throw new Error("vehicle_ID is required.");
        }
  
        try {
          const [vehicle] = await db.query(`
              SELECT 
                  v.*, 
                  l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
                  l.city, l.state, l.country, l.pincode, l.loc_type, 
                  l.gln_code, l.iata_code
              FROM master_vehicles v
              LEFT JOIN master_locations l ON v.loc_ID = l.loc_ID
              WHERE v.vehicle_ID = ?
          `, [vehicle_ID]);
  
          if (vehicle.length === 0) {
            throw new Error("Vehicle not found.");
          }
  
          return {
            message: "Vehicle fetched successfully",
            vehicle: vehicle[0],
          };
        } catch (error) {
          console.error("Error fetching vehicle:", error);
          throw new Error("An error occurred while fetching the vehicle.");
        }},
      
        async getAllPackages(_, __, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const [packages] = await db.query(`
              SELECT * FROM master_package_info ORDER BY package_id DESC
            `);
    
            return {
              message: "Packages retrieved successfully",
              packages,
            };
          } catch (error) {
            logger.error("Error fetching packages:", error);
            throw new Error("An error occurred while fetching packages.");
          }
        },
        async getPackage(_, { pac_ID }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!pac_ID) {
            throw new Error("Please provide a valid pac_ID.");
          }
    
          try {
            const [packageData] = await db.query(
              `SELECT * FROM master_package_info WHERE pac_ID = ?`,
              [pac_ID]
            );
    
            if (!packageData.length) {
              throw new Error("Package not found.");
            }
    
            return {
              message: "Package retrieved successfully",
              package: packageData[0],
            };
          } catch (error) {
            logger.error("Error fetching package:", error);
            throw new Error("An error occurred while fetching the package.");
          }
        },

        async getAllProducts(_, { page = 1, limit = 10 }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const offset = (page - 1) * limit;
            const query = `SELECT * FROM master_products LIMIT ? OFFSET ?`;
            const [products] = await db.query(query, [parseInt(limit), parseInt(offset)]);
    
            return {
              message: "Products retrieved successfully",
              products,
            };
          } catch (error) {
            logger.error("Error fetching products:", error);
            throw new Error("An error occurred while fetching products.");
          }
        },
   
  },

  Mutation: {
    async signup(_, { input }) {
      const { first_name, last_name, gender, mobile, email, password, user_type } = input;

      if (!first_name || !last_name || !mobile || !email || !user_type) {
        throw new Error("Name, surname, mobile, email, and user_type are required.");
      }

      try {
        const [existingUser] = await db.query('SELECT * FROM signup WHERE mobile = ?', [mobile]);
        if (existingUser.length > 0) {
          throw new Error("Mobile number already registered.");
        }

        const [existingMail] = await db.query('SELECT * FROM signup WHERE email = ?', [email]);
        if (existingMail.length > 0) {
          throw new Error("Email already registered.");
        }

        const [result] = await db.query(
          'INSERT INTO signup (first_name, last_name, gender, mobile, email, password, user_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [first_name, last_name, gender, mobile, email, password, user_type]
        );

        if (result.affectedRows > 0) {
          return { message: "User signed up successfully" };
        } else {
          throw new Error("Failed to insert new user.");
        }
      } catch (error) {
        console.error("Error during signup process:", error.message);
        throw new Error("An error occurred during signup.");
      }
    },
  }
};

module.exports = resolvers;
