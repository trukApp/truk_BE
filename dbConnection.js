const mysql = require('mysql2');
const {logger} = require('./src/logger/logger');
require('dotenv').config();

let connection;

const HEARTBEAT_INTERVAL = 30000;

function handleDisconnect() {
  connection =mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,    
        password: process.env.DB_PASSWORD,   
        database: process.env.DB_DATABASE    
      });

  connection.connect((err) => {
    if (err) {
      console.error('Error connecting to database:', err);
      setTimeout(handleDisconnect, 2000);
      return;
    }

    logger.info('Connected to MySQL database');

    const heartbeatIntervalId = setInterval(() => {
      connection.query('SELECT 1', (err) => {
        if (err) {
          console.error('Heartbeat error:', err);
          clearInterval(heartbeatIntervalId); // Stop heartbeat if error occurs
          handleDisconnect(); // Reconnect on error
        }
      });
    }, HEARTBEAT_INTERVAL);

    // Handle connection errors
    connection.on('error', (err) => {
      console.error('Database error:', err);

      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        console.log('Reconnecting to the database...');
        clearInterval(heartbeatIntervalId); // Stop heartbeat on connection loss
        handleDisconnect(); // Reconnect on connection loss
      } else {
        console.error('Unexpected error. Throwing it for now:', err);
        throw err; // Re-throw unexpected errors
      }
    });
  });
}

handleDisconnect();

module.exports = connection.promise();
