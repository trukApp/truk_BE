const { gql } = require('apollo-server-express');

const typeDefs = gql`


  type Location {
  loc_ID: ID
  loc_desc: String
  longitude: Float
  latitude: Float
  name: String
  time_zone: String
  city: String
  state: String
  country: String
  pincode: String
  loc_type: String
  gln_code: String
  iata_code: String
  def_ship_from: Boolean
  def_ship_to: Boolean
  def_bill_to: Boolean
}


type Vehicle {
  vehicle_ID: ID
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
type Vehicles {
    vehicle_id: ID
    vehicle_name: String
    vehicle_type: String
    loc_ID: ID
    location: Location
  }
type VehicleResponse {
  message: String!
  vehicle: Vehicle
}
type VehiclesResponse {
    message: String
    vehicles: [Vehicle]
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
  package_id: ID
  pac_ID: ID!
  package_name: String
  package_description: String
  price: Float
  created_at: String
  updated_at: String
}
type Products {
  product_id: ID
  product_name: String
  product_description: String
  price: Float
  stock: Int
  created_at: String
  updated_at: String
}
type Product {
  product_ID: ID
  product_name: String
  product_description: String
  price: Float
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
  address_1: String
  address_2: String
}
type User {
  profile_id: ID
  username: String
  email: String
  created_at: String
  updated_at: String
}
type Order {
  order_id: ID
  user_id: ID
  total_amount: Float
  status: String
  created_at: String
}
type OrderById {
  order_ID: ID
  user_ID: ID
  total_price: Float
  status: String
  created_at: String
  updated_at: String
}
type UOM {
  unit_id: ID
  unit_name: String
  description: String
  created_at: String
  updated_at: String
}
type Carrier {
  carrier_ID: ID!
  carrier_name: String
  carrier_loc_of_operation: [Location]
  carrier_lanes: [Lane]
}
type Lane {
  ln_id: ID
  lane_ID: String!
  lane_transport_data: String
  src_loc_ID: ID
  src: Location
  des_loc_ID: ID
  des: Location
  src_loc_id: ID
  src_location: Location
  des_loc_id: ID!
  des_location: Location
}

type Device {
  device_id: ID!
  dev_ID: String!
  device_type: String
  device_UID: String
  sim_imei_num: String
  vehicle_number: String
  carrier_ID: ID
  loc_ID: ID
  carrier_name: String
  carrier_address: String
  location_desc: String
  city: String
  state: String
  country: String
}

type DetailedDevice {
  device_id: ID!
  dev_ID: String!
  device_type: String
  device_UID: String
  sim_imei_num: String
  vehicle_number: String
  carrier_ID: ID
  loc_ID: ID
  carrier_name: String
  carrier_address: String
  carrier_correspondence: String
  carrier_network_portal: String
  vehicle_types_handling: String
  carrier_loc_of_operation: String
  carrier_lanes: String
  location_desc: String
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
type Counts {
  vehicles: Int!
  products: Int!
  locations: Int!
  lanes: Int!
  devices: Int!
  drivers: Int!
  carriers: Int!
  customers: Int!
  vendors: Int!
  packages: Int!
  uoms: Int!
}
type BusinessPartner {
  partner_id: ID
  supplier_id: String
  customer_id: String
  name: String
  partner_type: String
  loc_ID: String
  correspondence: String
  loc_of_source: String
  pod_relevant: String
  partner_functions: String
  location: Location
  loc_of_source_data: Location
}
type Driver {
  driver_id: ID!
  dri_ID: String!
  driver_name: String
  address: String
  driver_correspondence: String
  vehicle_types: String
  logged_in: Boolean
  locations: [Location]
}
type BusinessPartnerResponse {
  message: String!
  partners: [BusinessPartner]
}
type CountResponse {
  message: String!
  counts: Counts!
}

type DeviceResponse {
  message: String!
  device: DetailedDevice
}

type DevicesResponse {
  message: String!
  devices: [Device]
}
type CarrierResponse {
  message: String!
  carrier: Carrier
}

type CarriersResponse {
  message: String!
  carriers: [Carrier]
}

type ProductsResponse {
  message: String!
  products: [Products]
}
type ProductResponse {
  message: String!
  product: Product
}
type PackageResponse {
  message: String!
  packages: [Package]!
  package: Package
}
type SignupResponse {
  message: String!
}
type UserResponse {
  message: String!
  profile: User
}
type OrdersResponse {
  message: String!
  orders: [Order]!
}
type OrderResponse {
  message: String!
  order: OrderById
}
type LaneResponse {
  message: String!
  lane: Lane
}

type LanesResponse {
  message: String!
  lanes: [Lane]
}

type UOMResponse {
  message: String!
  uom: UOM
}
type LocationResponse {
  message: String!
  locations: [Location]
}

type SearchLocationResponse {
  message: String!
  searchKey: String!
  results: [Location]
}
type DriverResponse {
  message: String!
  drivers: [Driver]
}

type SingleDriverResponse {
  message: String!
  driver: Driver
}
  type Query {
    getVehicle(vehicle_ID: ID!): VehicleResponse
    getVehicles(page: Int, limit: Int): VehiclesResponse
    getAllPackages: PackageResponse!
    getPackage(pac_ID: ID!): PackageResponse!
    getAllProducts(page: Int, limit: Int): ProductsResponse!
    getProduct(product_ID: ID!): ProductResponse!
    getUser(profile_id: ID!): UserResponse!
    allOrders(page: Int, limit: Int): OrdersResponse!
    getOrderById(order_ID: ID!): OrderResponse!
    allUOM: [UOM]!
    allUOMNames: [String]!
    getUOM(unit_id: ID!): UOMResponse!
    allLanes(page: Int, limit: Int): LanesResponse!
    laneById(lane_ID: ID!): LaneResponse!
    allLocations(page: Int, limit: Int): LocationResponse!
    searchLocations(searchKey: String!, page: Int, limit: Int): SearchLocationResponse!
    locationByID(loc_ID: ID!): LocationResponse!
    fetchLocationByFlag(def_ship_from: Boolean, def_ship_to: Boolean, def_bill_to: Boolean): LocationResponse!
    allDevices(page: Int, limit: Int): DevicesResponse!
    getDevice(dev_ID: ID!): DeviceResponse!
    getCounts: CountResponse!
    getBusinessPartners(partner_type: String, supplier_id: String, customer_id: String): BusinessPartnerResponse!
    allCarriers(page: Int, limit: Int): CarriersResponse!
    carrierById(carrier_ID: ID!): CarrierResponse!
    getDrivers(page: Int, limit: Int): DriverResponse!
    getDriver(dri_ID: ID!): SingleDriverResponse!
  }

  type Mutation {
  signup(input: SignupInput!): SignupResponse!
}
`;









module.exports = typeDefs;
