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
        name:"jaiMp",
        message:"Hii, I'm working"
    })
})


const signup = require('./src/routes/signup/signup');
const login = require('./src/routes/login/login');
const userData = require('./src/routes/user/userData');


app.use('/jaiMp/reg',signup);
app.use('/jaiMp/log',login);
app.use('/jaiMp/user',userData);


module.exports = app;