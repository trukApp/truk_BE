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
  des_loc_ID:String
  src_loc_ID:String

  address_1:String
address_2:String
contact_email:String
contact_name:String
contact_phone_number:String


location_id:Int


}


# type Vehicle {
#   vehicle_ID: ID
#   loc_ID: ID
#   loc_desc: String
#   longitude: Float
#   latitude: Float
#   time_zone: String
#   city: String
#   state: String
#   country: String
#   pincode: String
#   loc_type: String
#   gln_code: String
#   iata_code: String

#   truk_id: ID
#     vehicle_name: String
#     vehicle_type: String
#     registration_number: String
#     capacity: String
# }

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






  type PhysicalProperties {
  max_width: String
  max_height: String
  max_length: String
  tare_volume: String
  tare_weight: String
  max_gross_weight: String
}

type Capacity {
  cubic_capacity: String
  interior_width: String
  payload_weight: String
  interior_height: String
  interior_length: String
}

type TransportationDetails {
  ownership: String
  validity_from: String
  validity_to: String
  vehicle_type: String
  vehicle_group: String
}

type VehicleGroup {
  vehicle_type: String
  vehicle_group_desc: String
}

type Downtimes {
  reason: String
  downtime_desc: String
  downtime_location: String
  downtime_starts_from: String
  downtime_ends_from: String
}

type AdditionalDetails {
  cost_per_ton: String
}
type costDetails{
  cost:Int
  cost_criteria_per:String
}
type vegicke{
  insurance:String
  permit:String
  registration:String
}
type Vehicle {
  veh_id: Int
  vehicle_ID: String
  loc_ID: String
  loc_desc: String
  longitude: String
  latitude: String
  time_zone: String
  city: String
  state: String
  country: String
  pincode: String
  loc_type: String
  gln_code: String
  iata_code: String
  unlimited_usage: Int
  fragile_vehicle: Int
  hazardous_proof: Int
  danger_proof: Int
  temp_controlled_vehicle: Int
  individual_resource: String
  physical_properties: PhysicalProperties
  capacity: Capacity
  transportation_details: TransportationDetails
  vehicle_group: VehicleGroup
  downtimes: Downtimes
  additional_details: AdditionalDetails






  truk_id: ID
    vehicle_name: String
    vehicle_type: String
    registration_number: String




}

type VehicleResult {
  message: String
  vehicles: [Vehicle]
}


type vehiclesaidata{
  message: String
  vehicle_ID: String
  available:Int
 costing:costDetails
 self_vehicle_docs:vegicke
 self_vehicle_num:String
 str_id:Int
 strk_ID:String
}
type VehicleResultData {
  message: String
  vehiclesData: [vehiclesaidata]
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


# type Package {
#   package_id: ID
#   # pac_ID: ID!
#   package_name: String
#   package_description: String
#   price: Float
#   created_at: String
#   updated_at: String

#   handling_unit_type: String
#   pack_length: Float
#   pack_width: Float
#   pack_height: Float
#   packageItem: String
#   dimensions_uom: String
#   packaging_type_name: String
#   pac_ID: String
# }

type TaxInfo {
  tax_rate: String
}

type AdditionalInfo {
  invoice: String
  reference_id: String
}


type Packages {
  pac_ID: String
  pack_ID:String
  pac_id:String
  package_name: String
  package_description: String
  price: Float
  created_at: String
  updated_at: String
  package_info:String
  handling_unit_type: String
  pack_length: Float
  pack_width: Float
  pack_height: Float
  packageItem: String
  dimensions_uom: String
  packaging_type_name: String
  package_status:String
  product_ID: [Product] # Assuming this is an array of objects
  tax_info: TaxInfo
  additional_info: AdditionalInfo
  ship_from: String
  ship_to: String
  pickup_date_time: String
  dropoff_date_time: String
  return_label: String
  bill_to: String
  pack_volume:String
  pack_volume_uom:String
  package_id:Int
}
type Package {
  pac_id: ID
  pack_ID: String
  bill_to: String
  ship_from: String
  ship_to: String
  return_label: String
  pickup_date_time: String
  dropoff_date_time: String
  package_status: String
  additional_info: AdditionalInfo
  tax_info: TaxInfo
  product_ID: [Product]
  package_info:String
  package_id:Int




}

type PackagingType {
  pac_ID: String
  location: String
}

type Products {
  product_id: ID
  product_name: String
  product_description: String
  price: Float
  stock: Int
  created_at: String
  updated_at: String

  basic_uom: String
  best_before: String
  can_combine: Boolean
  dangerous_goods: Boolean
  documents: String
  expiration: String
  fragile_goods: Boolean
  hazardous: Boolean
  hsn_code: String
  loc_ID: ID
  packaging_type: [PackagingType]  # Changed to a separate type for clarity
  packing_label: Boolean
  prod_id: ID
  product_ID: ID
  product_desc: String
  sales_uom: String
  sku_num: String
  special_instructions: String
  stacking_factor: Float
  temp_controlled: Boolean
  volume: Float
  volume_uom: String
  weight: Float
  weight_uom: String
}

type PartnerFunctions {
  ship_to_party: String
  sold_to_party: String
  bill_to_party: String
}

type Correspondence {
  contact_person: String
  contact_number: String
  email: String
}
type Product {
  product_ID: ID
  product_id: ID
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
  sku_num: String
  hsn_code: String

  prod_ID:String
quantity:Int
package_info:String
}



type User {
  profile_id: ID
  username: String
  email: String
  created_at: String
  updated_at: String
}
type LoadArrangement {
  location: String
  packages: [String]
  stop: Int
}

type RoutePoint {
  address: String
  latitude: Float
  longitude: Float
}

type RouteAddress {
  distance: String
  duration: String
  end: RoutePoint
  loadAfterStop: Int
  start: RoutePoint
}

type LatLong {
  lat: Float
  lng: Float
}

type Allocation {
  cost: Float
  route: [RouteAddress]
  packages: [String]
  vehicle_ID: String
  leftoverVolume: Float
  leftoverWeight: Float
  loadArrangement: [LoadArrangement]
  occupiedVolume: Float
  occupiedWeight: Float
  sampleRoutePoints: [LatLong]
  totalVolumeCapacity: Int
  totalWeightcapacity: Int
}

type Order {
  ord_id: Int
  order_ID: String
  order_status: String
  scenario_label: String
  total_cost: String
  created_at: String
  updated_at: String
  order_docs: [String]
  allocated_packages: [String]
  allocated_vehicles: [String]
  unallocated_packages: [String]
  allocations: [Allocation]
}


type UOM {
  alt_unit_desc:String
alt_unit_name:String
unit_desc:String
unit_id:String
unit_name:String
}
type Carrier {
  carrier_ID: ID
  carrier_name: String
  carrier_loc_of_operation: [String] # List of location IDs
  carrier_lanes: [String] # List of lane IDs
  vehicle_types_handling: [String]  # List of vehicle types
  carrier_correspondence: CarrierCorrespondence
  carrier_address: String
  cr_id: Int!
  carrier_network_portal: Int
  contract: String
  contract_valid_upto: String
}

type CarrierCorrespondence {
  name: String
  email: String
  phone: String
}

type Lane {
  ln_id: ID
  lane_ID: String
  lane_transport_data: LaneTransportData
  src_location_id: String
  src_loc_desc: String
  src_longitude: String
  src_latitude: String
  src_city: String
  src_state: String
  des_location_id: String
  des_loc_desc: String
  des_longitude: String
  des_latitude: String
  des_city: String
  des_state: String
  src_loc_ID:String
  des_loc_ID:String

}

type LaneTransportData {
  start_time: String
  end_time: String
  transport_cost: String
  transport_distance: String
  transport_duration: String
  vehcle_type: String
}

type LanesResponse {
  message: String
  lanes: [Lane]
}

type Device {
  device_id: ID
  dev_ID: String
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
  device_id: ID
  dev_ID: String
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
  vehicles: Int
  products: Int
  locations: Int
  lanes: Int
  devices: Int
  drivers: Int
  carriers: Int
  customers: Int
  vendors: Int
  packages: Int
  uoms: Int
}

type BusinessPartner {
  location: Location
  loc_of_source_location: Location
  partner_id: Int
  supplier_id: String
  customer_id: String
  name: String
  partner_type: String
  loc_ID: String
  pod_relevant: Int
  loc_of_source: String
  loc_of_source_pincode: String
  loc_of_source_state: String
  loc_of_source_city: String
  loc_of_source_country: String
  location_country: String
  location_city: String
  location_state: String
  location_pincode: String
  location_loc_ID: String
  loc_of_source_loc_ID: String
  partner_functions: PartnerFunctions
  correspondence: Correspondence
}

type DriverCorrespondence {
  email: String
  phone: String
  expiry_date: String
  driving_license: String
}
type Driver {
  driver_id: Int
  dri_ID: String
  driver_name: String
  address: String
  driver_availability: Int
  driver_correspondence: DriverCorrespondence
  locations: [String]
  logged_in: Int
  vehicle_types: [String]
}
type Assiged{
  dev_ID:String
  dri_ID:String
  self_vehicle_num:String
  strk_ID:String
}
type AssignedOrder {
  assign_ID: ID
  order_ID: ID
  assigned_vehicle_data: [Assiged]
  self_transport: Int
  scenario_label: String
  total_cost: String
  allocations: [Allocation]
  allocated_packages: [String]
  unallocated_packages: [String]
  allocated_vehicles: [String]
  created_at: String
  updated_at: String
  order_status: String
  # order_docs:[String]
  # pod:[String]
  pod_doc:String
  

}

type AssignedOrderResponse {
  message: String
  data: [AssignedOrder]
}


type BusinessPartnerResponse {
  message: String
  partners: [BusinessPartner]
}



type DeviceResponse {
  message: String
  device: DetailedDevice
}

type DevicesResponse {
  message: String
  devices: [Device]
}
type CarrierResponse {
  message: String
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
type PackagesResponses {
  message: String
  packages: [Packages]
}
type PackageResponse {
  message: String
  packages: [Package]
}

type SignupResponse {
  message: String!
}
type UserResponse {
  message: String!
  profile: User
}
type OrderResponse {
  message: String
  orders: [Order]
}
type AdditionalData {
  attachment:String
  department:String
  invoice:String
  po_number:String
  reference_id:String
  sales_order_number:String
}
type TaxInfoData {
  carrier_gst:String
  receiver_gst:String
  self_transport:String
  sender_gst:String
  tax_rate:String
}
type PackageDetails {
  pac_id: Int
  pack_ID: String
  bill_to: String
  ship_from: String
  ship_to: String
  return_label: Int
  pickup_date_time: String
  dropoff_date_time: String
  package_status: String
  additional_info: AdditionalData
  tax_info: TaxInfoData
  product_ID: [Product]
  package_info:String
}
type OrderByIdResponse {
  message: String
  order: Order
  allocated_packages_details: [PackageDetails]
  allocated_vehicles: [Vehicle]
}

type LaneResponse {
  message: String!
  lane: Lane
}



type UOMResponse {
  message: String
  uom: UOM
}
type LocationResponse {
  message: String
  locations: [Location]
}

type SearchLocationResponse {
  message: String
  searchKey: String
  results: [Location]
}

type DriverResult {
  message: String
  drivers: [Driver]
}
type SingleDriverResponse {
  message: String
  driver: Driver
}





type SelfVehicle {
  available: Boolean
  costing: Costing
  self_vehicle_docs: SelfVehicleDocs
  self_vehicle_num: String
  str_id: String
  strk_ID: ID
  vehicle_ID: String
}

type Costing {
  cost: Float
  cost_criteria_per: String
}

type SelfVehicleDocs {
  insurance: String
  permit: String
  registration: String
}

type SelfVehiclesResponse {
  message: String
  data: [SelfVehicle]
}


type CarrierVehicle {
  act_truk_ID: String
  act_vehicle_num: String
  carrier_ID: String
  truk_id: ID
  carrier_name: String
  carrier_address: String
  carrier_correspondence: String
  vehicle_types_handling: String
  carrier_network_portal: String
  carrier_loc_of_operation: String
  carrier_lanes: String

}

type SearchTrucksResponse {
  message: String
  searchKey: String
  results: [CarrierVehicle]
}



type SearchDriversResponse {
  message: String
  searchKey: String
  results: [Driver]
}

type CountData {
  vehicles: Int
  products: Int
  locations: Int
  lanes: Int
  devices: Int
  drivers: Int
  carriers: Int
  customers: Int
  vendors: Int
  packages: Int
  uoms: Int
}


type CountResponse {
  message: String
  counts: CountData
}

type ProductSearchResult {
  message: String
  searchKey: String
  results: [Product]
}

  type Query {
    getVehicle(vehicle_ID: ID!): VehicleResponse
    # getVehicles(page: Int, limit: Int): VehiclesResponse
    getVehicles(page: Int, limit: Int): VehicleResult
    # getAllPackages(page: Int, limit: Int): PackagesResponses
    getAllPackages(page: Int, limit: Int): PackagesResponses
    allPackages(page: Int, limit: Int): PackagesResponses
    getPackage(pac_ID: ID!): PackageResponse!
    getAllProducts(page: Int, limit: Int): ProductsResponse!
    getProduct(product_ID: ID!): ProductResponse!
    getUser(profile_id: ID!): UserResponse!
    # allOrders(page: Int, limit: Int): OrdersResponse!
    getAllOrders(page: Int, limit: Int): OrderResponse
    getOrderById(order_ID: String): OrderByIdResponse
    allUOM: [UOM]!
    allUOMNames: [String]!
    getUOM(unit_id: ID!): UOMResponse!
    allLanes(page: Int, limit: Int): LanesResponse
    laneById(lane_ID: ID!): LaneResponse!
    getAllLocations(page: Int, limit: Int): LocationResponse
    searchLocations(searchKey: String, page: Int, limit: Int): SearchLocationResponse
    locationByID(loc_ID: ID!): LocationResponse!
    fetchLocationByFlag(def_ship_from: Boolean, def_ship_to: Boolean, def_bill_to: Boolean): LocationResponse
    getDevice(dev_ID: ID!): DeviceResponse!
    getAllDevices(page: Int, limit: Int): DevicesResponse
    getCounts: CountResponse!
    getBusinessPartners(partner_type: String, supplier_id: Int, customer_id: String): BusinessPartnerResponse
    allCarriers(page: Int, limit: Int): CarriersResponse!
    carrierById(carrier_ID: ID!): CarrierResponse!
    getDrivers(page: Int, limit: Int): DriverResult
    getDriver(dri_ID: ID!): SingleDriverResponse!
    getAssignedOrder(assign_ID: ID, order_ID: ID, dri_ID: ID): AssignedOrderResponse!
    getAllVehicles: [VehicleResultData]
    # searchProducts(searchKey: String!, page: Int, limit: Int): [Product]
    getAllSelfVehicles: SelfVehiclesResponse
    searchTrucks(searchKey: String!, page: Int, limit: Int): SearchTrucksResponse
    searchDrivers(searchKey: String!, page: Int, limit: Int): SearchDriversResponse
    getCountData: CountResponse
    searchProducts(searchKey: String!, page: Int, limit: Int): ProductSearchResult
  }

  type Mutation {
  signup(input: SignupInput!): SignupResponse!
}
`;









module.exports = typeDefs;
