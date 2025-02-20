const { gql } = require('apollo-server-express');

const typeDefs = gql`
#   type User {
#     login_id: ID!
#     mobile: String!
#     user_type: String!
#     profile: Profile
#     accessToken: String
#     refreshToken: String
#   }
  type User {
    login_id: ID!
    profile_id: ID!
    name: String
    surname: String
    mobile: String
    email: String
    user_type: String
    profile_image: String
    place_of_birth: String
    current_address: String
    residence_type: String
    father_name: String
    mother_name: String
    siblings_name: [String]
    spouse: String
    children: [String]
    occupation: String

    refreshToken: String
    accessToken: String
    profile: Profile
  }

  type Profile {
    login_id: ID!
    name: String
    email: String
  }

  type Query {
    userCheck(mobile: String!): User
    getUser(profile_id: ID!): User
  }

  type Mutation {
    logout: String,
    signup(name: String!, surname: String!, mobile: String!, email: String, user_type: String!): String,
    editUser(
      profile_id: ID!
      name: String
      surname: String
      email: String
      profile_image: String
      place_of_birth: String
      current_address: String
      residence_type: String
      father_name: String
      mother_name: String
      siblings_name: [String]
      spouse: String
      children: [String]
      occupation: String
    ): User
  }


`;

module.exports = typeDefs;
