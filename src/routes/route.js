const router = require('express').Router();
const {
    karyawan
} = require('../controllers');
const {
    unit
} = require('../controllers');
const {
    absen
} = require('../controllers');
const {
    jabatan
} = require('../controllers');
const {
    statistik
} = require('../controllers');
const {
    auth
} = require('../controllers');



// CRUD Example
// // GET localhost:8080/karyawan => Ambil data semua karyawan
// router.get('/karyawan', karyawan.getDataKaryawan);

// // GET localhost:8080/karyawan/2 => Ambil data semua karyawan berdasarkan id = 2
// router.get('/karyawan/:id', karyawan.getDataKaryawanByID);

// // POST localhost:8080/karyawan/add => Tambah data karyawan ke database
// router.post('/karyawan/add', karyawan.addDataKaryawan);

// // POST localhost:8080/karyawan/edit => Edit data karyawan
// router.post('/karyawan/edit', karyawan.editDataKaryawan);

// // POST localhost:8080/karyawan/delete => Delete data karyawan
// router.post('/karyawan/delete', karyawan.deleteDataKaryawan);

router.get('/karyawan/unit/:kd_unit', karyawan.getDataKaryawanByUnit);
// router.get('/karyawan/:id', karyawan.getDataKaryawanByID)
router.post('/karyawan/registrasi', karyawan.registrasiKaryawan);
router.get('/karyawan/device_id/:device_id', karyawan.getdeviceKaryawan);




// GET localhost:8080/karyawan => Ambil data semua karyawan
router.get('/unit', unit.getDataUnit);
router.get('/unit/:kd_unit', unit.getDataNamaUnit);

router.get('/jabatan', jabatan.getDataJabatan);
router.get('/jabatan/:kd_jabat', jabatan.getDataJabatanByID);

router.post('/absensi/tambah', absen.lakukanAbsensi);
router.post('/absensi/tambahcoba', absen.lakukanAbsensiCoba);
router.post('/absensi/history', absen.historyAbsensi);
router.post('/absensi/hari-ini', absen.historyAbsensiHariIni);


router.post('/statistik/bln_ini', statistik.getStatistikBlnIni);
router.post('/statistik/all', statistik.getStatistikAll);

router.post('/auth/generate-otp', auth.generateOTP);
router.post('/auth/verify-otp', auth.verifyOTPLogin);
router.post('/auth/verify-token', auth.verifyToken);

router.get('/unitrotiq', unit.getRotiQUnits);

module.exports = router;