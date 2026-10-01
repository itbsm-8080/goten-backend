const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

// Ambang check-in Day Shift (tidak ada jadwal shift yang berlaku).
const TOLERANSI_DAY = '08:01:00';

// Satu sesi = satu (tanggal_kerja, shift). Toleransi diambil dari tshift sesuai shift
// dan tipe hari, jadi tidak ada ambang 08:01 hardcoded untuk user shift.
// Sesi dengan _IN null (hanya ada check-out) tidak dihitung sebagai tepat waktu.
const SQL_STATISTIK = `
    SELECT
        Nama,
        SUM(CASE WHEN Status = 'Terlambat' THEN 1 ELSE 0 END) JumlahTerlambat,
        SUM(CASE WHEN Status = 'Tepat Waktu' THEN 1 ELSE 0 END) JumlahTepatWaktu,
        SUM(CASE WHEN Status = 'Terlambat' THEN 1 ELSE 0 END) / COUNT(*) * 100 PersentaseTerlambat,
        SUM(CASE WHEN Status = 'Tepat Waktu' THEN 1 ELSE 0 END) / COUNT(*) * 100 PersentaseTepatWaktu
    FROM (
        SELECT Nama, Tanggal, IF(terlambat, 'Terlambat', 'Tepat Waktu') Status
        FROM (
            SELECT DISTINCT
                kar_nama Nama,
                DATE_FORMAT(a.tanggal_kerja, "%Y-%m-%d") Tanggal,
                COALESCE(a.shift, 0) shift,
                (SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s")
                 FROM tabsensitampung
                 WHERE status_absen = 1 AND kar_nik = a.kar_nik
                   AND tanggal_kerja = a.tanggal_kerja
                   AND COALESCE(shift, 0) = COALESCE(a.shift, 0)) _IN,
                CASE
                    WHEN COALESCE(a.shift, 0) = 0 OR s.toleransi_selesai IS NULL THEN
                        IF((SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s")
                            FROM tabsensitampung
                            WHERE status_absen = 1 AND kar_nik = a.kar_nik
                              AND tanggal_kerja = a.tanggal_kerja
                              AND COALESCE(shift, 0) = COALESCE(a.shift, 0)) > ?, 1, 0)
                    ELSE
                        IF((SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s")
                            FROM tabsensitampung
                            WHERE status_absen = 1 AND kar_nik = a.kar_nik
                              AND tanggal_kerja = a.tanggal_kerja
                              AND COALESCE(shift, 0) = COALESCE(a.shift, 0)) > TIME_FORMAT(s.toleransi_selesai, "%H:%i:%s"), 1, 0)
                END terlambat
            FROM tabsensitampung a
            INNER JOIN tkaryawan b ON a.kar_nik = b.kar_nik
            LEFT JOIN tshift s ON s.kd_cabang = '20' AND s.kd_shift = COALESCE(a.shift, 0) AND s.tipe_hari = CASE
                WHEN DAYOFWEEK(a.tanggal_kerja) = 7 THEN IF(LOWER(COALESCE(b.kar_sistem_gaji, '')) = 'borongan', 'SABTU_BORONGAN', 'SABTU')
                WHEN DAYOFWEEK(a.tanggal_kerja) = 1 THEN 'MINGGU'
                ELSE 'HARI'
            END
            WHERE a.tanggal_kerja IS NOT NULL
              AND a.status_absen = 1
        ) SESI
    ) FINAL
    WHERE Nama = ? %FILTER%
    GROUP BY Nama
`;

// Jendela "bulan ini": sejak tanggal 25 bulan lalu, geser per hari 25.
const FILTER_BULAN_INI = `AND Tanggal > DATE_FORMAT(NOW(), '%Y-%m-25') - INTERVAL 1 MONTH`;

function jalankan(nama, filter) {
    return new Promise((resolve, reject) => {
        const params = [TOLERANSI_DAY, nama];
        pool.getConnection(function (err, connection) {
            if (err) return reject(err);
            connection.query(SQL_STATISTIK.replace('%FILTER%', filter || ''), params, function (error, results) {
                connection.release();
                if (error) return reject(error);
                resolve(results);
            });
        });
    });
}

module.exports = {
    getStatistikBlnIni(req, res) {
        jalankan(req.body.nama, FILTER_BULAN_INI).then(
            (data) => res.send({ success: true, message: 'Berhasil ambil data!', data }),
            (err) => { console.error(err); res.send({ success: false, message: 'Berhasil ambil data!', data: [] }); }
        );
    },
    getStatistikAll(req, res) {
        jalankan(req.body.nama, null).then(
            (data) => res.send({ success: true, message: 'Berhasil ambil data!', data }),
            (err) => { console.error(err); res.send({ success: false, message: 'Berhasil ambil data!', data: [] }); }
        );
    },
}
