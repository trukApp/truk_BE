// const express = require('express');
// const app = express();
// const bodyParser = require('body-parser');
// const mongoose = require('mongoose');
// const mysql = require('mysql2');
// const connection = require('./dbConnection');
// const cors = require('cors');
// require('dotenv').config();
// app.use(cors({
//     origin:"*"
// }));
// app.use(bodyParser.urlencoded({extended: false}));
// app.use(bodyParser.json());



// app.get("/", (req, res, next)=>{
//     res.json({
//         name:"jaiMp",
//         message:"Hii, I'm working"
//     })
// })


// const signup = require('./src/routes/signup/signup');
// const login = require('./src/routes/login/login');
// const userData = require('./src/routes/user/userData');


// app.use('/jaiMp/reg',signup);
// app.use('/jaiMp/log',login);
// app.use('/jaiMp/user',userData);


// module.exports = app;


const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Test Route
app.get('/', (req, res) => {
  res.json({
    name: 'jaiMp',
    message: "Hii, I'm working"
  });
});

// Routes
const signup = require('./src/routes/signup/signup');
const login = require('./src/routes/login/login');
const userData = require('./src/routes/user/userData');

app.use('/jaiMp/reg', signup);
app.use('/jaiMp/log', login);
app.use('/jaiMp/user', userData);

module.exports = app;
