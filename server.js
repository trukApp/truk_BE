
// const http = require('http');
// const app = require('./app'); 
// const logger = require('./src/logger/logger');
// const port = process.env.PORT || 8088;

// const server = http.createServer(app); 

// server.listen(port, () => {
//     // console.log('Node server running on port ' + port);
//     logger.info('Node server running on port ' + port)
//   });


const http = require('http');
const express = require('express');
const { ApolloServer } = require('apollo-server-express');
const cors = require('cors');
const logger = require('./src/logger/logger');
const graphqlServer = require('./src/graphql');  // GraphQL setup

const app = express();
const port = process.env.PORT || 8088;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

async function startServer() {
  await graphqlServer.start();
  graphqlServer.applyMiddleware({ app });

  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📡 GraphQL available at http://localhost:${port}${graphqlServer.graphqlPath}`);
  });
}

startServer();