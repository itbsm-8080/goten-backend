const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error',(err)=> {
    console.error(err);
});

module.exports ={
    // Ambil data semua karyawan
    getDataKaryawanByUnit(req,res){
        let kd_unit = req.params.kd_unit;
        pool.getConnection(function(err, connection) {
            if (err) throw err;
            connection.query(
                `
                SELECT tkaryawan.kar_nik, tkaryawan.kar_nama FROM tkaryawan INNER JOIN tunit ON tkaryawan.kar_kd_unit=tunit.kd_unit WHERE tunit.kd_unit = ? AND kar_status_aktif=1;
                `
            , [kd_unit],
            function (error, results) {
                if(error) throw error;  
                res.send({ 
                    success: true, 
                    message: 'Berhasil ambil data!',
                    data: results
                });
            });
            connection.release();
        })
    },
    registrasiKaryawan(req,res){
            let device_id = req.body.device_id;
            let kar_nm = req.body.kar_nm;
            let unit = req.body.kd_unit;
            pool.getConnection(function(err, connection) {
                if (err) throw err;
                connection.query(
                    `
                    UPDATE tkaryawan SET kar_registrasi = ? WHERE kar_nama= ? AND kar_kd_unit= ?;
                    `
                , [device_id, kar_nm, unit],
                function (error, results) {
                    if(error) throw error;  
                    res.send({ 
                        success: true, 
                        message: 'Berhasil ambil data!',
                        data: results
                    });
                });
                connection.release();
            })
        },
        getdeviceKaryawan(req,res){
            let device_id = req.params.device_id;
            pool.getConnection(function(err, connection) {
                if (err) throw err;
                connection.query(
                    `
                    SELECT * FROM tkaryawan WHERE kar_registrasi = ?;
                    `
                , [device_id],
                function (error, results) {
                    if(error) throw error;  
                    res.send({ 
                        success: true, 
                        message: 'Berhasil ambil data!',
                        data: results
                    });
                });
                connection.release();
            })
        },
    // CRUD Example
    // // Ambil data semua karyawan
    // getDataKaryawan(req,res){
    //     pool.getConnection(function(err, connection) {
    //         if (err) throw err;
    //         connection.query(
    //             `
    //             SELECT * FROM tabel_karyawan;
    //             `
    //         , function (error, results) {
    //             if(error) throw error;  
    //             res.send({ 
    //                 success: true, 
    //                 message: 'Berhasil ambil data!',
    //                 data: results 
    //             });
    //         });
    //         connection.release();
    //     })
    // },
    // // Ambil data karyawan berdasarkan ID
    // getDataKaryawanByID(req,res){
    //     let id = req.params.id;
    //     pool.getConnection(function(err, connection) {
    //         if (err) throw err;
    //         connection.query(
    //             `
    //             SELECT * FROM tabel_karyawan WHERE karyawan_id = ?;
    //             `
    //         , [id],
    //         function (error, results) {
    //             if(error) throw error;  
    //             res.send({ 
    //                 success: true, 
    //                 message: 'Berhasil ambil data!',
    //                 data: results
    //             });
    //         });
    //         connection.release();
    //     })
    // },
    // // Simpan data karyawan
    // addDataKaryawan(req,res){
    //     let data = {
    //         karyawan_nama : req.body.nama,
    //         karyawan_umur : req.body.umur,
    //         karyawan_alamat : req.body.alamat,
    //         karyawan_jabatan : req.body.jabatan
    //     }
    //     pool.getConnection(function(err, connection) {
    //         if (err) throw err;
    //         connection.query(
    //             `
    //             INSERT INTO tabel_karyawan SET ?;
    //             `
    //         , [data],
    //         function (error, results) {
    //             if(error) throw error;  
    //             res.send({ 
    //                 success: true, 
    //                 message: 'Berhasil tambah data!',
    //             });
    //         });
    //         connection.release();
    //     })
    // },
    // // Update data karyawan
    // editDataKaryawan(req,res){
    //     let dataEdit = {
    //         karyawan_nama : req.body.nama,
    //         karyawan_umur : req.body.umur,
    //         karyawan_alamat : req.body.alamat,
    //         karyawan_jabatan : req.body.jabatan
    //     }
    //     let id = req.body.id
    //     pool.getConnection(function(err, connection) {
    //         if (err) throw err;
    //         connection.query(
    //             `
    //             UPDATE tabel_karyawan SET ? WHERE karyawan_id = ?;
    //             `
    //         , [dataEdit, id],
    //         function (error, results) {
    //             if(error) throw error;  
    //             res.send({ 
    //                 success: true, 
    //                 message: 'Berhasil edit data!',
    //             });
    //         });
    //         connection.release();
    //     })
    // },
    // // Delete data karyawan
    // deleteDataKaryawan(req,res){
    //     let id = req.body.id
    //     pool.getConnection(function(err, connection) {
    //         if (err) throw err;
    //         connection.query(
    //             `
    //             DELETE FROM tabel_karyawan WHERE karyawan_id = ?;
    //             `
    //         , [id],
    //         function (error, results) {
    //             if(error) throw error;  
    //             res.send({ 
    //                 success: true, 
    //                 message: 'Berhasil hapus data!'
    //             });
    //         });
    //         connection.release();
    //     })
    // }
}