
// const db = require('../../dbConnection');
const db = require('../../dbConnection')
const jwtAuth = require('../JWT/jwtAuth');
const messages = require('../responses/res_messages');
const applyPagination = require('../utils/pagination');
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
        getVehicles: async (_, { page, limit }) => {
          try {
            const query = `
              SELECT 
                  v.*, 
                  l.loc_ID, l.loc_desc, l.longitude, l.latitude, l.time_zone, 
                  l.city, l.state, l.country, l.pincode, l.loc_type, 
                  l.gln_code, l.iata_code
              FROM master_vehicles v
              LEFT JOIN master_locations l ON v.loc_ID = l.loc_ID
            `;
    
            const paginatedQuery = applyPagination(query, page, limit);
            const [vehicles] = await db.query(paginatedQuery);
    
            return {
              message: 'Vehicles fetched successfully',
              vehicles,
            };
          } catch (error) {
            console.error('Error fetching vehicles:', error);
            throw new Error('An error occurred while fetching vehicles.');
          }
        },
      
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
        async getProduct(_, { product_ID }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!product_ID) {
            throw new Error("product_ID is required.");
          }
    
          try {
            const [productData] = await db.query(
              `
                SELECT 
                    p.*, 
                    l.loc_desc, 
                    l.longitude, 
                    l.latitude, 
                    l.time_zone, 
                    l.city, 
                    l.state, 
                    l.country, 
                    l.pincode, 
                    l.loc_type, 
                    l.gln_code, 
                    l.iata_code, 
                    l.address_1, 
                    l.address_2
                FROM master_products p
                LEFT JOIN master_locations l ON p.loc_ID = l.loc_ID
                WHERE p.product_ID = ?
              `,
              [product_ID]
            );
    
            if (productData.length === 0) {
              throw new Error("Product not found.");
            }
    
            return {
              message: "Product retrieved successfully",
              product: productData[0],
            };
          } catch (error) {
            logger.error("Error fetching product:", error);
            throw new Error("An error occurred while fetching the product.");
          }
        },
        async getUser(_, { profile_id }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!profile_id) {
            throw new Error("Profile ID is required.");
          }
    
          try {
            const [profileData] = await connection.query(
              "SELECT * FROM signup WHERE profile_id = ?",
              [profile_id]
            );
    
            if (!profileData.length) {
              throw new Error("User not found.");
            }
    
            return {
              message: "User verification successful.",
              profile: profileData[0],
            };
          } catch (error) {
            logger.error("Error fetching user data: " + error.message);
            throw new Error("An error occurred while fetching user data.");
          }
        },
        async allOrders(_, { page, limit }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            let query = `SELECT * FROM orders ORDER BY created_at DESC`;
            query = applyPagination(query, page, limit); // Ensure this function handles pagination correctly
    
            const [orders] = await db.query(query);
    
            if (!orders.length) {
              throw new Error("No orders found.");
            }
    
            return {
              message: "Orders retrieved successfully.",
              orders,
            };
          } catch (error) {
            logger.error("Error fetching all orders:", error);
            throw new Error("Server error.");
          }
        },
        async getOrderById(_, { order_ID }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!order_ID) {
            throw new Error("Missing required parameter: order_ID");
          }
    
          try {
            const [orderData] = await db.query(
              `SELECT * FROM orders WHERE order_ID = ?`,
              [order_ID]
            );
    
            if (!orderData.length) {
              throw new Error("Order not found.");
            }
    
            return {
              message: "Order retrieved successfully.",
              order: orderData[0],
            };
          } catch (error) {
            logger.error("Error fetching order by ID:", error);
            throw new Error("Server error.");
          }
        },
        async allUOM(_, __, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const [uomList] = await db.query(`SELECT * FROM master_uom`);
            return uomList;
          } catch (error) {
            logger.error("Error fetching units of measurement:", error);
            throw new Error("An error occurred while fetching units of measurement.");
          }
        },
    
        async allUOMNames(_, __, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const [uomNames] = await db.query(`SELECT unit_name FROM master_uom`);
            return uomNames.map((uom) => uom.unit_name);
          } catch (error) {
            logger.error("Error fetching unit names:", error);
            throw new Error("An error occurred while fetching unit names.");
          }
        },
    
        async getUOM(_, { unit_id }, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!unit_id) {
            throw new Error("unit_id is required.");
          }
    
          try {
            const [uom] = await db.query(`SELECT * FROM master_uom WHERE unit_id = ?`, [unit_id]);
    
            if (uom.length === 0) {
              throw new Error("Unit of measurement not found.");
            }
    
            return {
              message: "Unit of measurement retrieved successfully.",
              uom: uom[0],
            };
          } catch (error) {
            logger.error("Error fetching unit of measurement:", error);
            throw new Error("An error occurred while fetching the unit of measurement.");
          }
        },

        async allLanes(_, { page, limit }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const query = `
              SELECT 
                  ml.ln_id, 
                  ml.lane_ID, 
                  ml.lane_transport_data,
                  ml.src_loc_ID, 
                  src.loc_ID AS src_loc_ID, 
                  src.loc_desc AS src_loc_desc, 
                  src.longitude AS src_longitude, 
                  src.latitude AS src_latitude, 
                  src.city AS src_city, 
                  src.state AS src_state,
                  ml.des_loc_ID, 
                  des.loc_ID AS des_loc_ID, 
                  des.loc_desc AS des_loc_desc, 
                  des.longitude AS des_longitude, 
                  des.latitude AS des_latitude, 
                  des.city AS des_city, 
                  des.state AS des_state
              FROM master_lanes ml
              LEFT JOIN master_locations src ON ml.src_loc_ID = src.loc_ID
              LEFT JOIN master_locations des ON ml.des_loc_ID = des.loc_ID
            `;
    
            const paginatedQuery = applyPagination(query, page, limit);
            const [lanes] = await db.query(paginatedQuery);
    
            return {
              message: "Lanes retrieved successfully",
              lanes,
            };
          } catch (error) {
            logger.error("Error retrieving lanes:", error);
            throw new Error("An error occurred while retrieving lanes.");
          }
        },
    
        async laneById(_, { lane_ID }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!lane_ID) {
            throw new Error("Please provide lane_ID.");
          }
    
          try {
            const query = `
              SELECT 
                  ml.ln_id, 
                  ml.lane_ID, 
                  ml.lane_transport_data, 
                  ml.src_loc_ID, 
                  src.loc_ID AS src_loc_ID, 
                  src.loc_desc AS src_loc_desc, 
                  src.longitude AS src_longitude, 
                  src.latitude AS src_latitude, 
                  src.time_zone AS src_time_zone, 
                  src.city AS src_city, 
                  src.state AS src_state, 
                  src.country AS src_country, 
                  src.pincode AS src_pincode, 
                  src.loc_type AS src_loc_type, 
                  src.gln_code AS src_gln_code, 
                  src.iata_code AS src_iata_code, 
                  ml.des_loc_ID,  
                  des.loc_ID AS des_loc_ID, 
                  des.loc_desc AS des_loc_desc, 
                  des.longitude AS des_longitude, 
                  des.latitude AS des_latitude, 
                  des.time_zone AS des_time_zone, 
                  des.city AS des_city, 
                  des.state AS des_state, 
                  des.country AS des_country, 
                  des.pincode AS des_pincode, 
                  des.loc_type AS des_loc_type, 
                  des.gln_code AS des_gln_code, 
                  des.iata_code AS des_iata_code
              FROM master_lanes ml
              LEFT JOIN master_locations src ON ml.src_loc_ID = src.loc_ID
              LEFT JOIN master_locations des ON ml.des_loc_ID = des.loc_ID
              WHERE ml.lane_ID = ?
            `;
    
            const [lane] = await db.query(query, [lane_ID]);
    
            if (lane.length === 0) {
              throw new Error("Lane not found.");
            }
    
            return {
              message: "Lane retrieved successfully",
              lane: lane[0],
            };
          } catch (error) {
            logger.error("Error retrieving lane:", error);
            throw new Error("An error occurred while retrieving the lane.");
          }
        },

        async allLocations(_, { page, limit }, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const query = `SELECT * FROM master_locations`;
            const paginatedQuery = applyPagination(query, page, limit);
            const [locations] = await db.query(paginatedQuery);
    
            return {
              message: "Locations retrieved successfully",
              locations,
            };
          } catch (error) {
            logger.error("Error fetching locations:", error);
            throw new Error("An error occurred while fetching locations.");
          }
        },
    
        async searchLocations(_, { searchKey, page, limit }, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!searchKey || searchKey.trim().length < 1) {
            throw new Error("Search key is required in the query.");
          }
    
          try {
            const query = `
              SELECT * FROM master_locations 
              WHERE 
                  loc_ID LIKE ? 
                  OR city LIKE ? 
                  OR state LIKE ? 
                  OR pincode LIKE ? 
                  OR loc_type LIKE ?
            `;
            const searchPattern = `%${searchKey}%`;
    
            const paginatedQuery = applyPagination(query, page, limit);
            const [locations] = await db.query(paginatedQuery, [
              searchPattern,
              searchPattern,
              searchPattern,
              searchPattern,
              searchPattern,
            ]);
    
            if (locations.length === 0) {
              throw new Error("No locations found matching the search criteria.");
            }
    
            return {
              message: "Locations retrieved successfully.",
              searchKey,
              results: locations,
            };
          } catch (error) {
            logger.error("Error searching locations:", error);
            throw new Error("An error occurred while searching locations.");
          }
        },
    
        async locationByID(_, { loc_ID }, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const query = "SELECT * FROM master_locations WHERE loc_ID = ?";
            const [locations] = await db.query(query, [loc_ID]);
    
            return {
              locations,
            };
          } catch (error) {
            logger.error(error);
            throw new Error("Server error.");
          }
        },
    
        async fetchLocationByFlag(_, { def_ship_from, def_ship_to, def_bill_to }, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (
            [def_ship_from, def_ship_to, def_bill_to].filter((v) => v !== undefined).length !== 1
          ) {
            throw new Error("Pass exactly one of def_ship_from, def_ship_to, or def_bill_to.");
          }
    
          try {
            let fieldToQuery;
            if (def_ship_from !== undefined) fieldToQuery = "def_ship_from";
            if (def_ship_to !== undefined) fieldToQuery = "def_ship_to";
            if (def_bill_to !== undefined) fieldToQuery = "def_bill_to";
    
            const query = `SELECT * FROM master_locations WHERE ${fieldToQuery} = 1`;
            const [locations] = await db.query(query);
    
            if (locations.length === 0) {
              throw new Error(`No locations found where ${fieldToQuery} = 1.`);
            }
    
            return {
              message: `Locations retrieved successfully for ${fieldToQuery} = 1`,
              locations,
            };
          } catch (error) {
            logger.error(error);
            throw new Error("Server error.");
          }
        },

        async allDevices(_, { page, limit }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const query = `
              SELECT 
                d.device_id, d.dev_ID, d.device_type, d.device_UID, d.sim_imei_num, 
                d.vehicle_number, d.carrier_ID, d.loc_ID,
                c.carrier_name, c.carrier_address,
                l.loc_desc AS location_desc, l.city, l.state, l.country
              FROM master_devices d
              LEFT JOIN carriers c ON d.carrier_ID = c.carrier_ID
              LEFT JOIN master_locations l ON d.loc_ID = l.loc_ID
            `;
    
            const paginatedQuery = applyPagination(query, page, limit);
            const [devices] = await db.query(paginatedQuery);
    
            return {
              message: "Devices retrieved successfully",
              devices,
            };
          } catch (error) {
            logger.error("Error fetching devices:", error);
            throw new Error("An error occurred while fetching devices.");
          }
        },
    
        async getDevice(_, { dev_ID }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!dev_ID) {
            throw new Error("Please provide dev_ID.");
          }
    
          try {
            const query = `
              SELECT 
                d.device_id, d.dev_ID, d.device_type, d.device_UID, d.sim_imei_num, 
                d.vehicle_number, d.carrier_ID, d.loc_ID,
                c.carrier_name, c.carrier_address, 
                c.carrier_correspondence, c.carrier_network_portal, c.vehicle_types_handling, 
                c.carrier_loc_of_operation, c.carrier_lanes,
                l.loc_desc AS location_desc, l.longitude, 
                l.latitude, l.time_zone, l.city, l.state, l.country, l.pincode, l.loc_type, 
                l.gln_code, l.iata_code
              FROM master_devices d
              LEFT JOIN carriers c ON d.carrier_ID = c.carrier_ID
              LEFT JOIN master_locations l ON d.loc_ID = l.loc_ID
              WHERE d.dev_ID = ?
            `;
    
            const [device] = await db.query(query, [dev_ID]);
    
            if (device.length === 0) {
              throw new Error("Device not found.");
            }
    
            return {
              message: "Device retrieved successfully",
              device: device[0],
            };
          } catch (error) {
            logger.error("Error fetching device:", error);
            throw new Error("An error occurred while fetching the device.");
          }
        },
        async getCounts(_, __, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const queries = {
              vehicles: `SELECT COUNT(*) AS count FROM master_vehicles`,
              products: `SELECT COUNT(*) AS count FROM master_products`,
              locations: `SELECT COUNT(*) AS count FROM master_locations`,
              lanes: `SELECT COUNT(*) AS count FROM master_lanes`,
              devices: `SELECT COUNT(*) AS count FROM master_devices`,
              drivers: `SELECT COUNT(*) AS count FROM master_drivers`,
              carriers: `SELECT COUNT(*) AS count FROM carriers`,
              customers: `SELECT COUNT(*) AS count FROM business_partners WHERE partner_type = 'customer'`,
              vendors: `SELECT COUNT(*) AS count FROM business_partners WHERE partner_type = 'vendor'`,
              packages: `SELECT COUNT(*) AS count FROM master_package_info`,
              uoms: `SELECT COUNT(*) AS count FROM master_uom`
            };
    
            const results = await Promise.all(
              Object.values(queries).map(query => db.query(query))
            );
    
            return {
              message: "Counts retrieved successfully",
              counts: {
                vehicles: results[0][0][0].count || 0,
                products: results[1][0][0].count || 0,
                locations: results[2][0][0].count || 0,
                lanes: results[3][0][0].count || 0,
                devices: results[4][0][0].count || 0,
                drivers: results[5][0][0].count || 0,
                carriers: results[6][0][0].count || 0,
                customers: results[7][0][0].count || 0,
                vendors: results[8][0][0].count || 0,
                packages: results[9][0][0].count || 0,
                uoms: results[10][0][0].count || 0
              }
            };
    
          } catch (error) {
            logger.error("Error retrieving counts:", error);
            throw new Error("An error occurred while retrieving counts.");
          }
        },
        async getBusinessPartners(_, { partner_type, supplier_id, customer_id }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!partner_type && !supplier_id && !customer_id) {
            throw new Error(
              "At least one of partner_type, supplier_id, or customer_id is required."
            );
          }
    
          // Build dynamic query conditions
          const conditions = [];
          const queryParams = [];
    
          if (partner_type) {
            conditions.push("bp.partner_type = ?");
            queryParams.push(partner_type);
          }
    
          if (supplier_id) {
            conditions.push("bp.supplier_id = ?");
            queryParams.push(supplier_id);
          }
    
          if (customer_id) {
            conditions.push("bp.customer_id = ?");
            queryParams.push(customer_id);
          }
    
          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    
          try {
            const query = `
              SELECT 
                  bp.partner_id,
                  bp.supplier_id,
                  bp.customer_id,
                  bp.name,
                  bp.partner_type,
                  bp.loc_ID,
                  bp.correspondence,
                  bp.loc_of_source,
                  bp.pod_relevant,
                  bp.partner_functions,
                  loc1.loc_ID AS location_loc_ID,
                  loc1.loc_desc AS location_loc_desc,
                  loc1.longitude AS location_longitude,
                  loc1.latitude AS location_latitude,
                  loc1.time_zone AS location_time_zone,
                  loc1.city AS location_city,
                  loc1.state AS location_state,
                  loc1.country AS location_country,
                  loc1.pincode AS location_pincode,
                  loc1.loc_type AS location_loc_type,
                  loc1.gln_code AS location_gln_code,
                  loc1.iata_code AS location_iata_code,
                  loc2.loc_ID AS loc_of_source_loc_ID,
                  loc2.loc_desc AS loc_of_source_loc_desc,
                  loc2.longitude AS loc_of_source_longitude,
                  loc2.latitude AS loc_of_source_latitude,
                  loc2.time_zone AS loc_of_source_time_zone,
                  loc2.city AS loc_of_source_city,
                  loc2.state AS loc_of_source_state,
                  loc2.country AS loc_of_source_country,
                  loc2.pincode AS loc_of_source_pincode,
                  loc2.loc_type AS loc_of_source_loc_type,
                  loc2.gln_code AS loc_of_source_gln_code,
                  loc2.iata_code AS loc_of_source_iata_code
              FROM 
                  business_partners bp
              LEFT JOIN 
                  master_locations loc1 ON bp.loc_ID = loc1.loc_ID
              LEFT JOIN 
                  master_locations loc2 ON bp.loc_of_source = loc2.loc_ID
              ${whereClause}
              ORDER BY 
                  bp.partner_id DESC
            `;
    
            // Execute query
            const [partners] = await db.query(query, queryParams);
    
            return {
              message: "Business partners retrieved successfully",
              partners,
            };
          } catch (error) {
            logger.error("Error retrieving business partners:", error);
            throw new Error("An error occurred while retrieving business partners.");
          }
        },
        async allCarriers(_, { page, limit }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            let query = `SELECT * FROM carriers`;
            const paginatedQuery = applyPagination(query, page, limit);
            const [carriers] = await db.query(paginatedQuery);
    
            if (carriers.length === 0) {
              throw new Error("No carriers found.");
            }
    
            return {
              message: "Carriers retrieved successfully",
              carriers,
            };
          } catch (error) {
            logger.error("Error retrieving carriers:", error);
            throw new Error("An error occurred while retrieving carriers.");
          }
        },
    
        async carrierById(_, { carrier_ID }, context) {
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!carrier_ID) {
            throw new Error("Please provide carrier_ID.");
          }
    
          try {
            const [carriers] = await db.query(`SELECT * FROM carriers WHERE carrier_ID = ?`, [carrier_ID]);
    
            if (carriers.length === 0) {
              throw new Error("Carrier not found.");
            }
    
            const carrier = carriers[0];
    
            // Helper function to parse JSON fields
            const parseJson = (data) => {
              if (!data) return [];
              if (typeof data === "string") {
                try {
                  return JSON.parse(data);
                } catch {
                  return data.split(",").map((item) => item.trim().replace(/["[\]]/g, ""));
                }
              }
              return Array.isArray(data) ? data : [];
            };
    
            const locOfOperation = parseJson(carrier.carrier_loc_of_operation);
            const carrierLanes = parseJson(carrier.carrier_lanes);
    
            // Fetch locations
            const [locations] = locOfOperation.length
              ? await db.query(`SELECT * FROM master_locations WHERE loc_ID IN (?)`, [locOfOperation])
              : [[]];
    
            // Fetch lanes
            const [lanes] = carrierLanes.length
              ? await db.query(
                  `
                  SELECT 
                    ml.ln_id, ml.lane_ID, ml.lane_transport_data, 
                    ml.src_loc_id, 
                    src.loc_ID AS src_loc_ID, src.loc_desc AS src_loc_desc, 
                    src.longitude AS src_longitude, src.latitude AS src_latitude, 
                    src.city AS src_city, src.state AS src_state,
                    ml.des_loc_id, 
                    des.loc_ID AS des_loc_ID, des.loc_desc AS des_loc_desc, 
                    des.longitude AS des_longitude, des.latitude AS des_latitude, 
                    des.city AS des_city, des.state AS des_state
                  FROM master_lanes ml
                  LEFT JOIN master_locations src ON ml.src_loc_id = src.location_id
                  LEFT JOIN master_locations des ON ml.des_loc_id = des.location_id
                  WHERE ml.lane_ID IN (?)
                  `,
                  [carrierLanes]
                )
              : [[]];
    
            return {
              message: "Carrier retrieved successfully",
              carrier: {
                ...carrier,
                carrier_loc_of_operation: locations,
                carrier_lanes: lanes,
              },
            };
          } catch (error) {
            logger.error("Error retrieving carrier by ID:", error);
            throw new Error("An error occurred while retrieving the carrier.");
          }
        },
        async getDrivers(_, { page, limit }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          try {
            const query = `SELECT * FROM master_drivers`;
            const paginatedQuery = applyPagination(query, page, limit);
            const [drivers] = await db.query(paginatedQuery);
    
            return {
              message: "Drivers retrieved successfully",
              drivers,
            };
          } catch (error) {
            logger.error("Error retrieving drivers:", error);
            throw new Error("An error occurred while retrieving drivers.");
          }
        },
    
        async getDriver(_, { dri_ID }, context) {
          // Verify authentication
          // if (!context.user) {
          //   throw new Error("Unauthorized access");
          // }
    
          if (!dri_ID) {
            throw new Error("dri_ID is required.");
          }
    
          try {
            const [drivers] = await db.query(
              `
              SELECT 
                driver_id,
                dri_ID,
                locations,
                driver_name,
                address,
                driver_correspondence,
                vehicle_types,
                logged_in
              FROM 
                master_drivers
              WHERE 
                dri_ID = ?
            `,
              [dri_ID]
            );
    
            if (drivers.length === 0) {
              throw new Error("Driver not found.");
            }
    
            const driver = drivers[0];
    
            // Parse JSON fields safely
            const parseJson = (data) => {
              if (!data) return [];
              if (typeof data === "string") {
                try {
                  return JSON.parse(data);
                } catch {
                  return data.split(",").map((item) => item.trim().replace(/["[\]]/g, ""));
                }
              }
              return Array.isArray(data) ? data : [];
            };
    
            const driverLocations = parseJson(driver.locations);
    
            // Fetch locations based on driver's locations
            const [locations] = driverLocations.length
              ? await db.query(`SELECT * FROM master_locations WHERE loc_ID IN (?)`, [driverLocations])
              : [[]];
    
            return {
              message: "Driver retrieved successfully",
              driver: {
                ...driver,
                locations: locations,
              },
            };
          } catch (error) {
            logger.error("Error retrieving driver:", error);
            throw new Error("An error occurred while retrieving the driver.");
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
