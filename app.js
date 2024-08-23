const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();


const uri="mongodb+srv://jaimptrust:R1c312qPF6CPTs96@jaimp-dev.k7qfi2a.mongodb.net/?retryWrites=true&w=majority&appName=jaiMP-dev";

mongoose.set("strictQuery", false);
 mongoose.connect(uri)
.then(response =>{
   console.log('mongodb is connected')
})
.catch(error=>{
   console.log(error)
   console.log("error db is not connected")
});

app.use(cors({
    origin:"*"
}));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());



//to handle error 
app.use((req, res, next) => {

    const error = new Error('Not Found');
    error.status = 400;
    next(error); 

});


//error when nothing is responding
app.use((error, req, res, next) =>{
     
     res.status(error.status || 500);
     res.json({
         error:{
             message: error.message
         }

     });
})



module.exports = app;