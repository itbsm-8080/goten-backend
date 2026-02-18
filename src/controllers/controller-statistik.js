const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

module.exports = {
    getStatistikBlnIni(req, res) {
        let nama = req.body.nama;
        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `
                SELECT
                Nama,
                    count(case when Status = 'Terlambat' then 1 else null end) as JumlahTerlambat,
                    count(case when Status = 'Tepat Waktu' then 1 else null END) as JumlahTepatWaktu,
                    count(case when Status = 'Terlambat' then 1 else null END)/COUNT(Status)*100 as PersentaseTerlambat,
                    count(case when Status = 'Tepat Waktu' then 1 else null END)/COUNT(Status)*100 as PersentaseTepatWaktu FROM (
                SELECT *, if (_in > "08:01:00" ,"Terlambat","Tepat Waktu") Status  FROM (
                    SELECT DISTINCT kar_nama Nama,DATE_FORMAT(tanggal,"%Y-%m-%d") Tanggal,
                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik
                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") =DATE_FORMAT(a.tanggal,"%Y-%m-%d")  limit 1) _IN,
                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=2 AND kar_nik=a.kar_nik
                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") =DATE_FORMAT(a.tanggal,"%Y-%m-%d")  limit 1)  _OUT
                    FROM tabsensitampung a INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik) FINAL WHERE Nama = ? AND Tanggal > DATE_FORMAT(NOW(), '%Y-%m-25') - INTERVAL 1 MONTH ) FINAL
           
                    `, [nama],
                function (error, results) {
                    if (error) throw error;
                    res.send({
                        success: true,
                        message: 'Berhasil ambil data!',
                        data: results
                    });
                });
            connection.release();
        })
    },
    getStatistikAll(req, res) {
        let nama = req.body.nama;
        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `
                SELECT
                Nama,
                    count(case when Status = 'Terlambat' then 1 else null end) as JumlahTerlambat,
                    count(case when Status = 'Tepat Waktu' then 1 else null END) as JumlahTepatWaktu,
                    count(case when Status = 'Terlambat' then 1 else null END)/COUNT(Status)*100 as PersentaseTerlambat,
                    count(case when Status = 'Tepat Waktu' then 1 else null END)/COUNT(Status)*100 as PersentaseTepatWaktu FROM (
                SELECT *, if (_in > "08:01:00" ,"Terlambat","Tepat Waktu") Status  FROM (
                    SELECT DISTINCT kar_nama Nama,DATE_FORMAT(tanggal,"%Y-%m-%d") Tanggal,
                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik
                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") =DATE_FORMAT(a.tanggal,"%Y-%m-%d")  limit 1) _IN,
                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=2 AND kar_nik=a.kar_nik
                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") =DATE_FORMAT(a.tanggal,"%Y-%m-%d")  limit 1)  _OUT
                    FROM tabsensitampung a INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik) FINAL WHERE Nama = ? ) FINAL
           
                    `, [nama],
                function (error, results) {
                    if (error) throw error;
                    res.send({
                        success: true,
                        message: 'Berhasil ambil data!',
                        data: results
                    });
                });
            connection.release();
        })
    },

}