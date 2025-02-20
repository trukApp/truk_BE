const { ApolloServer } = require('apollo-server-express');
const typeDefs = require('./schema');
// const resolvers = require('./resolvers');
const resolvers = require('./resolvers')

const graphqlServer = new ApolloServer({
  typeDefs,
  resolvers,
  context: ({ req }) => ({ req })  // Pass headers for authentication
});

module.exports = graphqlServer;
