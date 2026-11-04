const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const cors = require('cors')

require('dotenv').config();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin',
    'X-App-Platform', 'X-App-Version-Code', 'X-App-Version-Name']
}));

app.use(bodyParser.urlencoded({
    extended: false,
    limit: '10mb'
}))
app.use(bodyParser.json({
    limit: '10mb'
}))

const cekVersi = require('./src/middlewares/cek_versi');
const appRoute = require('./src/routes/route');
app.use(cekVersi);
app.use('/', appRoute);

app.listen(process.env.PORT, () => {
    console.log('Server Berjalan di port ' + process.env.PORT);
});
