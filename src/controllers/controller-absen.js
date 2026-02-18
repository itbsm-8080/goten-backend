const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error',(err)=> {
    console.error(err);
});

module.exports ={
    // Lakukan Absensi
    lakukanAbsensi(req,res){
            let kar_nik = req.body.kar_nik;
            let tanggal = req.body.tanggal;
            // let tanggal = new Date(req.body.tanggal);
            let kd_cabang = req.body.kd_cabang;
            let latitude = req.body.latitude;
            let longitude = req.body.longitude;

            // tanggal.setDate(tanggal.getDate() + 1);

            // tanggal.setHours(22, 49, 30, 0);
            // tanggal.setHours(5, 0, 0, 0);

            // tanggal.toISOString().slice(0, 19).replace('T', ' ');
            pool.getConnection(function(err, connection) {
                if (err) throw err;
                connection.query(
                    `
                    INSERT INTO tabsensi (kar_nik, tanggal, cus_kode, customer, kd_cabang, cabang, latitude, longitude )
                    VALUES ( ? , ? , NULL, NULL, ? , NULL, ? , ? );
                    `
                , [kar_nik, tanggal, kd_cabang, latitude, longitude],
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
    lakukanAbsensiCoba(req,res){
        let kar_nik = req.body.kar_nik;
        let kd_cabang = req.body.kd_cabang;
        let latitude = req.body.latitude;
        let longitude = req.body.longitude;

        // GENERATE WAKTU JAKARTA DI BACKEND, jangan terima dari frontend
        const now = new Date();
        const jakartaTimeString = now.toLocaleString("en-CA", {
            timeZone: "Asia/Jakarta",
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        
        // Format: "2024-01-15 16:30:25"
        const tanggal = jakartaTimeString.replace(',', '');
console.log('tanggal', tanggal);

        pool.getConnection(function(err, connection) {
            if (err) throw err;
            connection.query(
                `
                INSERT INTO tabsensi (kar_nik, tanggal, cus_kode, customer, kd_cabang, cabang, latitude, longitude )
                VALUES ( ? , ? , NULL, NULL, ? , NULL, ? , ? );
                `
            , [kar_nik, tanggal, kd_cabang, latitude, longitude],
            function (error, results) {
                if(error) throw error;  
                res.send({ 
                    success: true, 
                    message: 'Berhasil absensi!',
                    waktu_absensi: tanggal // Kirim kembali untuk debug
                });
            });
            connection.release();
        })
    },
    historyAbsensi(req, res) {
        let kar_nama = req.body.kar_nama;

        pool.getConnection(function(err, connection) {
            if (err) throw err;

            // Step 1: ambil kd_unit dulu
            connection.query(
                "SELECT kar_kd_unit FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
                [kar_nama],
                function(err, rows) {
                    if (err) throw err;

                    if (!rows.length) {
                        res.send({ success: false, message: "Karyawan tidak ditemukan" });
                        connection.release();
                        return;
                    }

                    let kd_unit = rows[0].kar_kd_unit;

                    // Step 2: pilih query sesuai kd_unit
                    let sql, params;
                    if (kd_unit == 20) {
                        sql = `
                            SELECT *, 
                                IF(_in > "08:01:00", "Terlambat", "Tepat Waktu") Status,
                                CASE 
                                    WHEN shift_type = 'night' THEN 'Malam'
                                    WHEN shift_type = 'morning' THEN 'Pagi'
                                    ELSE 'Siang'
                                END as shift_name
                            FROM (
                                SELECT DISTINCT 
                                    kar_nama Nama,
                                    DATE_FORMAT(tanggal_kerja, "%Y-%m-%d") as Tanggal,
                                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                    FROM tabsensitampung 
                                    WHERE status_absen=1 AND kar_nik=a.kar_nik
                                    AND tanggal_kerja = a.tanggal_kerja LIMIT 1) _IN,
                                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                    FROM tabsensitampung 
                                    WHERE status_absen=2 AND kar_nik=a.kar_nik
                                    AND tanggal_kerja = a.tanggal_kerja LIMIT 1) _OUT,
                                    (SELECT 
                                        CASE 
                                            WHEN HOUR(tanggal) >= 19 OR HOUR(tanggal) < 6 THEN 'night'
                                            WHEN HOUR(tanggal) >= 6 AND HOUR(tanggal) < 14 THEN 'morning'
                                            ELSE 'afternoon'
                                        END
                                    FROM tabsensitampung 
                                    WHERE status_absen=1 AND kar_nik=a.kar_nik
                                    AND tanggal_kerja = a.tanggal_kerja LIMIT 1) shift_type
                                FROM tabsensitampung a 
                                INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
                                WHERE tanggal_kerja IS NOT NULL
                            ) FINAL
                            WHERE Nama = ? 
                            ORDER BY Tanggal DESC 
                            LIMIT 10;
                        `;
                        params = [kar_nama];
                    } else {
                        sql = `
                            SELECT *, IF(_in > "08:01:00","Terlambat","Tepat Waktu") Status  
                            FROM (
                                SELECT DISTINCT kar_nama Nama,
                                    DATE_FORMAT(tanggal,"%Y-%m-%d") Tanggal,
                                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                    FROM tabsensitampung 
                                    WHERE status_absen=1 AND kar_nik=a.kar_nik
                                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") = DATE_FORMAT(a.tanggal,"%Y-%m-%d")  
                                    LIMIT 1) _IN,
                                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                    FROM tabsensitampung 
                                    WHERE status_absen=2 AND kar_nik=a.kar_nik
                                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") = DATE_FORMAT(a.tanggal,"%Y-%m-%d")  
                                    LIMIT 1) _OUT
                                FROM tabsensitampung a 
                                INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
                            ) FINAL 
                            WHERE Nama = ? 
                            ORDER BY Tanggal DESC 
                            LIMIT 10;
                        `;
                        params = [kar_nama];
                    }

                    // Step 3: eksekusi query sesuai kondisi
                    connection.query(sql, params, function(error, results) {
                        if (error) throw error;
                        res.send({
                            success: true,
                            message: 'Berhasil ambil data history!',
                            kd_unit: kd_unit,
                            data: results
                        });
                    });

                    connection.release();
                }
            );
        });
    },
    historyAbsensiHariIni(req, res) {
        let kar_nama = req.body.kar_nama;

        // Hitung waktu Jakarta
        const now = new Date();
        const jakartaTimeString = now.toLocaleString("en-CA", {
            timeZone: "Asia/Jakarta",
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        const jakartaDate = new Date(jakartaTimeString);
        const currentHour = jakartaDate.getHours();

        // Helper format tanggal
        function formatLocalDate(date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        const today = formatLocalDate(jakartaDate);
        const tomorrow = formatLocalDate(new Date(jakartaDate.getTime() + 24*60*60*1000));

        pool.getConnection(function(err, connection) {
            if (err) throw err;

            connection.query(
                "SELECT kar_kd_unit, kar_nik FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
                [kar_nama],
                function(err, rows) {
                    if (err) throw err;

                    if (!rows.length) {
                        res.send({ success: false, message: "Karyawan tidak ditemukan" });
                        connection.release();
                        return;
                    }

                    let kd_unit = rows[0].kar_kd_unit;
                    let kar_nik = rows[0].kar_nik;

                    if (kd_unit == 20) {
                        let decideWorkDate = (cb) => {
                            if (currentHour < 19) {
                                cb(today);
                            } else {
                                connection.query(
                                    `
                                    SELECT 1 FROM tabsensitampung
                                    WHERE kar_nik = ? 
                                    AND status_absen = 1
                                    AND tanggal_kerja = ?
                                    AND HOUR(tanggal) < 19
                                    LIMIT 1
                                    `,
                                    [kar_nik, today],
                                    function(err, checkRows) {
                                        if (err) throw err;
                                        let workDate = checkRows.length ? today : tomorrow;
                                        cb(workDate);
                                    }
                                );
                            }
                        };

                        decideWorkDate((workDate) => {
                            connection.query(
                                `
                                SELECT *, 
                                    IF(_in > "08:01:00", "Terlambat", "Tepat Waktu") Status,
                                    CASE 
                                        WHEN shift_type = 'night' THEN 'Malam'
                                        WHEN shift_type = 'morning' THEN 'Pagi'
                                        ELSE 'Siang'
                                    END as shift_name
                                FROM (
                                    SELECT DISTINCT 
                                        kar_nama Nama,
                                        DATE_FORMAT(tanggal_kerja, "%Y-%m-%d") as Tanggal,
                                        (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                        FROM tabsensitampung 
                                        WHERE status_absen=1 AND kar_nik=a.kar_nik
                                        AND tanggal_kerja = a.tanggal_kerja LIMIT 1) _IN,
                                        (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                        FROM tabsensitampung 
                                        WHERE status_absen=2 AND kar_nik=a.kar_nik
                                        AND tanggal_kerja = a.tanggal_kerja LIMIT 1) _OUT,
                                        (SELECT 
                                            CASE 
                                                WHEN HOUR(tanggal) >= 19 OR HOUR(tanggal) < 6 THEN 'night'
                                                WHEN HOUR(tanggal) >= 6 AND HOUR(tanggal) < 14 THEN 'morning'
                                                ELSE 'afternoon'
                                            END
                                        FROM tabsensitampung 
                                        WHERE status_absen=1 AND kar_nik=a.kar_nik
                                        AND tanggal_kerja = a.tanggal_kerja LIMIT 1) shift_type
                                    FROM tabsensitampung a 
                                    INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
                                    WHERE tanggal_kerja IS NOT NULL
                                ) FINAL 
                                WHERE Nama = ? AND Tanggal = ?;
                                `,
                                [kar_nama, workDate],
                                function(error, results) {
                                    if (error) throw error;
                                    res.send({
                                        success: true,
                                        message: 'Berhasil ambil data hari ini!',
                                        kd_unit: kd_unit,
                                        workDate: workDate,
                                        current_hour: currentHour,
                                        data: results
                                    });
                                }
                            );
                        });

                    } else {
                        connection.query(
                            `
                            SELECT *, IF(_in > "08:01:00","Terlambat","Tepat Waktu") Status  
                            FROM (
                                SELECT DISTINCT kar_nama Nama,
                                    DATE_FORMAT(tanggal,"%Y-%m-%d") Tanggal,
                                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                    FROM tabsensitampung 
                                    WHERE status_absen=1 AND kar_nik=a.kar_nik
                                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") = DATE_FORMAT(a.tanggal,"%Y-%m-%d")  
                                    LIMIT 1) _IN,
                                    (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
                                    FROM tabsensitampung 
                                    WHERE status_absen=2 AND kar_nik=a.kar_nik
                                    AND DATE_FORMAT(tanggal,"%Y-%m-%d") = DATE_FORMAT(a.tanggal,"%Y-%m-%d")  
                                    LIMIT 1) _OUT
                                FROM tabsensitampung a 
                                INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
                            ) FINAL 
                            WHERE Nama = ? AND Tanggal = ?;
                            `,
                            [kar_nama, today],
                            function(error, results) {
                                if (error) throw error;
                                res.send({
                                    success: true,
                                    message: 'Berhasil ambil data hari ini!',
                                    kd_unit: kd_unit,
                                    workDate: today,
                                    current_hour: currentHour,
                                    data: results
                                });
                            }
                        );
                    }

                    connection.release();
                }
            );

            // Step 1: ambil kd_unit & kar_nik
            // connection.query(
            //     "SELECT kar_kd_unit, kar_nik FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
            //     [kar_nama],
            //     function(err, rows) {
            //         if (err) throw err;

            //         if (!rows.length) {
            //             res.send({ success: false, message: "Karyawan tidak ditemukan" });
            //             connection.release();
            //             return;
            //         }

            //         let kd_unit = rows[0].kar_kd_unit;
            //         let kar_nik = rows[0].kar_nik;

            //         // Step 2: logika khusus untuk kd_unit = 20
            //         if (kd_unit == 20) {
            //             let decideWorkDate = (cb) => {
            //                 if (currentHour < 19) {
            //                     cb(today);
            //                 } else {
            //                     // cek apakah ada absen masuk sebelum jam 19 hari ini
            //                     connection.query(
            //                         `
            //                         SELECT 1 FROM tabsensitampung
            //                         WHERE kar_nik = ? 
            //                         AND status_absen = 1
            //                         AND tanggal_kerja = ?
            //                         AND HOUR(tanggal) < 19
            //                         LIMIT 1
            //                         `,
            //                         [kar_nik, today],
            //                         function(err, checkRows) {
            //                             if (err) throw err;
            //                             let workDate = checkRows.length ? today : tomorrow;
            //                             cb(workDate);
            //                         }
            //                     );
            //                 }
            //             };

            //             decideWorkDate((workDate) => {
            //                 // Query absensi pakai workDate hasil cek
            //                 connection.query(
            //                     `
            //                     SELECT *, 
            //                         IF(_in > "08:01:00", "Terlambat", "Tepat Waktu") Status,
            //                         CASE 
            //                             WHEN shift_type = 'night' THEN 'Malam'
            //                             WHEN shift_type = 'morning' THEN 'Pagi'
            //                             ELSE 'Siang'
            //                         END as shift_name
            //                     FROM (
            //                         SELECT DISTINCT 
            //                             kar_nama Nama,
            //                             DATE_FORMAT(tanggal_kerja, "%Y-%m-%d") as Tanggal,
            //                             (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
            //                             FROM tabsensitampung 
            //                             WHERE status_absen=1 AND kar_nik=a.kar_nik
            //                             AND tanggal_kerja = a.tanggal_kerja LIMIT 1) _IN,
            //                             (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
            //                             FROM tabsensitampung 
            //                             WHERE status_absen=2 AND kar_nik=a.kar_nik
            //                             AND tanggal_kerja = a.tanggal_kerja LIMIT 1) _OUT,
            //                             (SELECT 
            //                                 CASE 
            //                                     WHEN HOUR(tanggal) >= 19 OR HOUR(tanggal) < 6 THEN 'night'
            //                                     WHEN HOUR(tanggal) >= 6 AND HOUR(tanggal) < 14 THEN 'morning'
            //                                     ELSE 'afternoon'
            //                                 END
            //                             FROM tabsensitampung 
            //                             WHERE status_absen=1 AND kar_nik=a.kar_nik
            //                             AND tanggal_kerja = a.tanggal_kerja LIMIT 1) shift_type
            //                         FROM tabsensitampung a 
            //                         INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
            //                         WHERE tanggal_kerja IS NOT NULL
            //                     ) FINAL 
            //                     WHERE Nama = ? AND Tanggal = ?;
            //                     `,
            //                     [kar_nama, workDate],
            //                     function(error, results) {
            //                         if (error) throw error;
            //                         res.send({
            //                             success: true,
            //                             message: 'Berhasil ambil data hari ini!',
            //                             kd_unit: kd_unit,
            //                             workDate: workDate,
            //                             current_hour: currentHour,
            //                             data: results
            //                         });
            //                     }
            //                 );
            //             });

            //         } else {
            //             // Step 3: kalau bukan unit 20
            //             connection.query(
            //                 `
            //                 SELECT *, IF(_in > "08:01:00","Terlambat","Tepat Waktu") Status  
            //                 FROM (
            //                     SELECT DISTINCT kar_nama Nama,
            //                         DATE_FORMAT(tanggal,"%Y-%m-%d") Tanggal,
            //                         (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
            //                         FROM tabsensitampung 
            //                         WHERE status_absen=1 AND kar_nik=a.kar_nik
            //                         AND DATE_FORMAT(tanggal,"%Y-%m-%d") = DATE_FORMAT(a.tanggal,"%Y-%m-%d")  
            //                         LIMIT 1) _IN,
            //                         (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") 
            //                         FROM tabsensitampung 
            //                         WHERE status_absen=2 AND kar_nik=a.kar_nik
            //                         AND DATE_FORMAT(tanggal,"%Y-%m-%d") = DATE_FORMAT(a.tanggal,"%Y-%m-%d")  
            //                         LIMIT 1) _OUT
            //                     FROM tabsensitampung a 
            //                     INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
            //                 ) FINAL 
            //                 WHERE Nama = ? AND Tanggal = CURDATE();
            //                 `,
            //                 [kar_nama],
            //                 function(error, results) {
            //                     if (error) throw error;
            //                     res.send({
            //                         success: true,
            //                         message: 'Berhasil ambil data hari ini!',
            //                         kd_unit: kd_unit,
            //                         workDate: today,
            //                         current_hour: currentHour,
            //                         data: results
            //                     });
            //                 }
            //             );
            //         }

            //         connection.release();
            //     }
            // );
        });
    },
}