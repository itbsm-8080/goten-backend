const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const cors = require('cors')

require('dotenv').config;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin']
}));

app.use(bodyParser.urlencoded({
    extended: false,
    limit: '10mb'
}))
app.use(bodyParser.json({
    limit: '10mb'
}))

const appRoute = require('./src/routes/route');
app.use('/', appRoute);

app.listen(process.env.PORT, () => {
    console.log('Server Berjalan di port ' + process.env.PORT);
});
