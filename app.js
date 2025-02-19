const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const mysql = require('mysql2');
const connection = require('./dbConnection');
const cors = require('cors');
require('dotenv').config();

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
    origin:"*"
}));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());



app.get("/", (req, res, next)=>{
    res.json({
        name:"Truk",
        message:"Hii, I'm working"
    })
})


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


app.use('/truk/reg',signup);
app.use('/truk/log',login);
app.use('/truk/user',userData);
app.use('/truk/masLoc',masLocation);
app.use('/truk/business',businessPartner);
app.use('/truk/driver',drivers);
app.use('/truk/vehicle',vehicles);
app.use('/truk/package',packagesInfo);
app.use('/truk/carrier',carrier);
app.use('/truk/lane',lanes);
app.use('/truk/device',devices);
app.use('/truk/masterUom',masterUom);
app.use('/truk/masterProducts',products);
app.use('/truk/createOrder',order);
app.use('/truk/order',confirmOrder);
app.use('/truk/data',data);
app.use('/truk/products/packages',packages);
app.use('/truk/image',images);
app.use('/truk/route',route);

module.exports = app;