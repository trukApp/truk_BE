const { gql } = require('apollo-server-express');

const typeDefs = gql`


  type Location {
  loc_ID: ID
  loc_desc: String
  longitude: Float
  latitude: Float
  time_zone: String
  city: String
  state: String
  country: String
  pincode: String
  loc_type: String
  gln_code: String
  iata_code: String
}
type Vehicle {
  vehicle_ID: ID!
  loc_ID: ID
  loc_desc: String
  longitude: Float
  latitude: Float
  time_zone: String
  city: String
  state: String
  country: String
  pincode: String
  loc_type: String
  gln_code: String
  iata_code: String
}
type VehicleResponse {
  message: String!
  vehicle: Vehicle
}
input SignupInput {
  first_name: String!
  last_name: String!
  gender: String
  mobile: String!
  email: String!
  password: String!
  user_type: String!
}


type Package {
  package_id: ID!
  pac_ID: ID!
  package_name: String
  package_description: String
  price: Float
  created_at: String
  updated_at: String
}
type Product {
  product_id: ID!
  product_name: String
  product_description: String
  price: Float
  stock: Int
  created_at: String
  updated_at: String
}

type ProductResponse {
  message: String!
  products: [Product]
}

type PackageResponse {
  message: String!
  packages: [Package]!
  package: Package
}
type SignupResponse {
  message: String!
}

  type Query {
    getVehicle(vehicle_ID: ID!): VehicleResponse
    getAllPackages: PackageResponse!
    getPackage(pac_ID: ID!): PackageResponse!
    getAllProducts(page: Int, limit: Int): ProductResponse!
  }

  type Mutation {
  signup(input: SignupInput!): SignupResponse!
}
`;









module.exports = typeDefs;
