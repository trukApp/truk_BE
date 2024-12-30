
const http = require('http');
const app = require('./app'); 
const {logger} = require('./src/logger/logger');
const port = process.env.PORT || 8088;

const server = http.createServer(app); 

server.listen(port, () => {
    // console.log('Node server running on port ' + port);
    logger.info('Node server running on port ' + port)
  });