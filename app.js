const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const cors = require('cors')

require('dotenv').config;

// EDIT DI SINI - Ganti app.use(cors()) menjadi:
app.use(cors({
  origin: '*', // Allow semua origin termasuk ngrok
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin']
}));

app.use(bodyParser.urlencoded({
    extended: false
}))
app.use(bodyParser.json())

const appRoute = require('./src/routes/route');
app.use('/', appRoute);

app.listen(process.env.PORT, () => {
    console.log('Server Berjalan di port ' + process.env.PORT);
});