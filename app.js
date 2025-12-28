const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const mysql = require('mysql2');
const connection = require('./dbConnection');
const cors = require('cors');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();
const { logger, requestLogger } = require('./src/logger/logger'); // path looks right from your tree


app.use(requestLogger);


//Mongo
// const uri="mongodb+srv://jaimptrust:R1c312qPF6CPTs96@jaimp-dev.k7qfi2a.mongodb.net/?retryWrites=true&w=majority&appName=jaiMP-dev";

// mongoose.set("strictQuery", false);
//  mongoose.connect(uri)
// .then(response =>{
//    console.log('mongodb is connected')
// })
// .catch(error=>{
//    console.log(error)
//    console.log("error db is not connected")
// });



app.use(cors({
  origin: "*"
}));
// app.use(bodyParser.urlencoded({ extended: false }));
// app.use(bodyParser.json());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100000 }));




app.get("/", (req, res, next) => {
  res.json({
    name: "Truk",
    message: "Hii, I'm working"
  })
})

const masterSwaggerDocument = JSON.parse(fs.readFileSync('./src/swagger/master-swagger.json', 'utf8'));
// const userSwaggerDocument = JSON.parse(fs.readFileSync('./src/swagger/user-swagger.json', 'utf8'));

const combinedSwaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'TrukApp API',
    version: '1.0.0',
    description: 'TrukApp API documentation'
  },
  servers: [
    {
      url: 'http://localhost:8088'
    },
    {
      url: 'https://dev-api.trukapp.com'
    }
  ],

  tags: [
    ...masterSwaggerDocument.tags

  ],
  paths: {
    ...masterSwaggerDocument.paths

  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      }
    }
  },
  security: [
    {
      bearerAuth: []
    }
  ]
};

app.use('/trukapp-api-docs', swaggerUi.serve, swaggerUi.setup(combinedSwaggerDocument));



const signup = require('./src/routes/signup/signup');
const login = require('./src/routes/login/login');
const userData = require('./src/routes/user/userData');
const masLocation = require('./src/routes/masterLocations/masLocations');
const businessPartner = require('./src/routes/businessPartner/businessPartner');
const carrier = require('./src/routes/businessPartner/carriers');
const drivers = require('./src/routes/businessPartner/drivers');
const vehicles = require('./src/routes/vehicles/vehicle');
const packagesInfo = require('./src/routes/packages/packageinfo');
const packages = require('./src/routes/packages/packages');
const lanes = require('./src/routes/masterLocations/lanes');
const devices = require('./src/routes/devices/masterDevices');
const masterUom = require('./src/routes/masterUom/uom');
const products = require('./src/routes/masterProducts/products');
const order = require('./src/routes/order/order');
const confirmOrder = require('./src/routes/order/confirmOrder');
const data = require('./src/routes/data/dataCount');
const images = require('./src/routes/images/image');
const route = require('./src/routes/order/routeValidate');
const assign = require('./src/routes/order/assignOrder');
const actVehicles = require('./src/routes/vehicles/actVehicles');
const selfVehicles = require('./src/routes/vehicles/selfVehicles');
const assignCarriers = require('./src/routes/order/assignCarrier');
const assignmentBidding = require('./src/routes/order/assignmentBidding');
const masDocks = require('./src/routes/masterLocations/masDocks');
const healthRoutes = require('./src/routes/health');
const ai = require('./src/routes/ai/index');
const LOR = require('./src/routes/client/LOR');
const invoice = require('./src/routes/client/invoice');
const ordrs = require('./src/routes/client/ordrs');

app.use('/health', healthRoutes);
app.use('/truk/reg', signup);
app.use('/truk/log', login);
app.use('/truk/user', userData);
app.use('/truk/masLoc', masLocation);
app.use('/truk/business', businessPartner);
app.use('/truk/driver', drivers);
app.use('/truk/vehicle', vehicles);
app.use('/truk/package', packagesInfo);
app.use('/truk/carrier', carrier);
app.use('/truk/lane', lanes);
app.use('/truk/device', devices);
app.use('/truk/masterUom', masterUom);
app.use('/truk/masterProducts', products);
app.use('/truk/createOrder', order);
app.use('/truk/order', confirmOrder);
app.use('/truk/data', data);
app.use('/truk/products/packages', packages);
app.use('/truk/image', images);
app.use('/truk/route', route);
app.use('/truk/ao', assign);
app.use('/truk/veh', actVehicles);
app.use('/truk/self', selfVehicles);
app.use('/truk/carrier-assignment', assignCarriers);
app.use('/truk/assignment-bid', assignmentBidding);
app.use('/truk/masterDock', masDocks)
app.use('/truk/ai',ai);
app.use('/truk/LOR',LOR);
app.use('/truk/invoice',invoice);
app.use('/truk/ordrs',ordrs);


// Global error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({
    message: "Internal Server Error",
    detail: err.message
  });
});

// 404 forwarder (optional)
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// Global error handling middleware
app.use((err, req, res, next) => {
  if (logger?.error) {
    logger.error('Unhandled error', {
      message: err.message,
      stack: err.stack,
      path: req.originalUrl,
      method: req.method
    });
  } else {
    console.error('Unhandled error', err);
  }
  res.status(err.status || 500).json({
    message: err.message || 'Internal Server Error'
  });
});




module.exports = app;