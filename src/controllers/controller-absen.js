const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

// Waktu saat ini di Asia/Jakarta, format 'YYYY-MM-DD HH:mm:ss'
function waktuJakarta() {
    return new Date().toLocaleString("en-CA", {
        timeZone: "Asia/Jakarta",
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(',', '');
}

// tanggal_kerja: check-out shift 3 (malam) = hari sebelumnya; lainnya = tanggal absen
function hitungTanggalKerja(tanggal, status_absen, shift) {
    const tanggalKerja = tanggal.slice(0, 10);
    if (status_absen === 2 && Number(shift) === 3) {
        const prev = new Date(tanggalKerja + 'T00:00:00Z');
        prev.setUTCDate(prev.getUTCDate() - 1);
        return prev.toISOString().slice(0, 10);
    }
    return tanggalKerja;
}

// Usulan shift default dari jam server (WIB): 6-14 -> 1, 14-22 -> 2, sisanya -> 3
function detectShift() {
    const jam = parseInt(waktuJakarta().slice(11, 13), 10);
    if (jam >= 6 && jam < 14) return 1;
    if (jam >= 14 && jam < 22) return 2;
    return 3;
}

// Query history untuk unit/cabang 20 (3 shift)
const SQL_HISTORY_UNIT20 = `
    SELECT *, IF(_IN > "08:01:00", "Terlambat", "Tepat Waktu") Status,
        CASE
            WHEN shift = 1 THEN 'Pagi'
            WHEN shift = 2 THEN 'Siang'
            WHEN shift = 3 THEN 'Malam'
            WHEN hjam >= 6 AND hjam < 14 THEN 'Pagi'
            WHEN hjam >= 14 AND hjam < 22 THEN 'Siang'
            ELSE 'Malam'
        END as shift_name
    FROM (
        SELECT DISTINCT
            kar_nama Nama,
            DATE_FORMAT(tanggal_kerja, "%Y-%m-%d") as Tanggal,
            COALESCE(
                (SELECT HOUR(tanggal) FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja LIMIT 1),
                HOUR(a.tanggal)) hjam,
            a.shift shift,
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja LIMIT 1) _IN,
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=2 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja LIMIT 1) _OUT
        FROM tabsensitampung a
        INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
        WHERE a.tanggal_kerja IS NOT NULL
    ) FINAL
`;

// Lakukan Absensi: validasi + INSERT tabsensi. Trigger menghitung tanggal_kerja & mengisi tabsensitampung.
function prosesAbsen(req, res, coba = false) {
    const kar_nik = req.body.kar_nik;
    const kd_cabang = req.body.kd_cabang;
    const latitude = req.body.latitude;
    const longitude = req.body.longitude;
    const status_absen = parseInt(req.body.status_absen, 10);
    const shift = parseInt(req.body.shift, 10) || detectShift();
    const tanggal = waktuJakarta();

    if (status_absen !== 1 && status_absen !== 2) {
        return res.status(400).json({ success: false, message: 'status_absen harus 1 (check-in) atau 2 (check-out)', code: 'status_invalid' });
    }

    const kerja = hitungTanggalKerja(tanggal, status_absen, shift);

    pool.getConnection(function (err, connection) {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Koneksi database gagal', code: 'error' });
        }

        const tolak = (pesan, kode = 'error') => {
            connection.release();
            res.status(400).json({ success: false, message: pesan, code: kode });
        };
        const selesai = () => {
            connection.release();
            const body = { success: true, message: 'Berhasil absensi!', status_absen, shift, tanggal, tanggal_kerja: kerja };
            if (coba) body.waktu_absensi = tanggal;
            res.send(body);
        };

        const masukkan = () => {
            connection.query(
                `INSERT INTO tabsensi (kar_nik, tanggal, cus_kode, customer, kd_cabang, cabang, latitude, longitude, status_absen, shift)
                 VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
                [kar_nik, tanggal, kd_cabang, latitude, longitude, status_absen, shift],
                function (error) {
                    if (error) {
                        console.error(error);
                        tolak('Terjadi kesalahan saat menyimpan absen', 'error');
                        return;
                    }
                    selesai();
                }
            );
        };

        // Duplikat: maksimal 1 record per (kar_nik, tanggal_kerja, status_absen)
        connection.query(
            'SELECT COUNT(*) AS jml FROM tabsensitampung WHERE kar_nik = ? AND tanggal_kerja = ? AND status_absen = ?',
            [kar_nik, kerja, status_absen],
            function (error, rows) {
                if (error) {
                    console.error(error);
                    tolak('Terjadi kesalahan saat cek absen', 'error');
                    return;
                }
                if (rows[0].jml > 0) {
tolak(status_absen === 1
                            ? 'Anda sudah Check In pada tanggal kerja ini'
                            : 'Anda sudah Check Out pada tanggal kerja ini', 'duplicate');
                    return;
                }

                // Check-in cabang 20: harus dalam toleransi jam masuk shift
                if (status_absen === 1 && String(kd_cabang) === '20') {
                    connection.query(
                        `SELECT toleransi_mulai, toleransi_selesai FROM tshift WHERE kd_cabang = ? AND kd_shift = ?`,
                        [String(kd_cabang), shift],
                        function (error, shiftRows) {
                            if (error) {
                                console.error(error);
                                tolak('Terjadi kesalahan saat cek shift', 'error');
                                return;
                            }
                            if (!shiftRows.length) {
                                tolak('Shift tidak dikenal', 'shift_unknown');
                                return;
                            }
                            const jam = tanggal.slice(11);
                            if (jam < shiftRows[0].toleransi_mulai || jam > shiftRows[0].toleransi_selesai) {
                                tolak('Di luar jam masuk shift, pilih shift yang sesuai', 'shift_window');
                                return;
                            }
                            masukkan();
                        }
                    );
                } else {
                    masukkan();
                }
            }
        );
    });
}

module.exports = {
    getShiftDefault(req, res) {
        const kd_cabang = req.query.kd_cabang || '20';
        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `SELECT kd_shift, nm_shift,
                    TIME_FORMAT(jam_mulai,"%H:%i") jam_mulai,
                    TIME_FORMAT(jam_selesai,"%H:%i") jam_selesai,
                    TIME_FORMAT(toleransi_mulai,"%H:%i") toleransi_mulai,
                    TIME_FORMAT(toleransi_selesai,"%H:%i") toleransi_selesai
                 FROM tshift WHERE kd_cabang = ? ORDER BY kd_shift`,
                [String(kd_cabang)],
                function (error, results) {
                    if (error) throw error;
                    res.send({
                        success: true,
                        data: results,
                        default_shift: detectShift()
                    });
                    connection.release();
                }
            );
        });
    },

    // Lakukan Absensi (check-in = status_absen 1, check-out = status_absen 2)
    lakukanAbsensi(req, res) {
        prosesAbsen(req, res);
    },
    lakukanAbsensiCoba(req, res) {
        prosesAbsen(req, res, true);
    },

    historyAbsensi(req, res) {
        let kar_nama = req.body.kar_nama;

        pool.getConnection(function (err, connection) {
            if (err) throw err;

            connection.query(
                "SELECT kar_kd_unit FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
                [kar_nama],
                function (err, rows) {
                    if (err) throw err;

                    if (!rows.length) {
                        res.send({ success: false, message: "Karyawan tidak ditemukan" });
                        connection.release();
                        return;
                    }

                    let kd_unit = rows[0].kar_kd_unit;

                    let sql, params;
                    if (kd_unit == 20) {
                        sql = SQL_HISTORY_UNIT20 + ` WHERE Nama = ? ORDER BY Tanggal DESC LIMIT 10;`;
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

                    connection.query(sql, params, function (error, results) {
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

        const jakartaTimeString = new Date().toLocaleString("en-CA", {
            timeZone: "Asia/Jakarta",
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        const jakartaDate = new Date(jakartaTimeString.replace(',', ''));
        const currentHour = jakartaDate.getHours();

        function formatLocalDate(date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        const today = formatLocalDate(jakartaDate);
        const kemarin = formatLocalDate(new Date(jakartaDate.getTime() - 24 * 60 * 60 * 1000));

        pool.getConnection(function (err, connection) {
            if (err) throw err;

            connection.query(
                "SELECT kar_kd_unit, kar_nik FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
                [kar_nama],
                function (err, rows) {
                    if (err) throw err;

                    if (!rows.length) {
                        res.send({ success: false, message: "Karyawan tidak ditemukan" });
                        connection.release();
                        return;
                    }

                    let kd_unit = rows[0].kar_kd_unit;
                    let kar_nik = rows[0].kar_nik;

                    if (kd_unit == 20) {
                        // Cabang 20 (3 shift): tampilkan sesi shift 3 (kerja = kemarin) yang masih
                        // terbuka sampai jam 14:00. Lewat 14:00 = reset ke hari ini (mulai shift 2).
                        let focus = today;
                        const tampilkanHariIni = () => {
                            const dates = focus === kemarin ? [kemarin, today] : [today];
                            const placeholders = dates.map(() => '?').join(',');
                            connection.query(
                                SQL_HISTORY_UNIT20 + ` WHERE Nama = ? AND Tanggal IN (${placeholders}) ORDER BY Tanggal ASC;`,
                                [kar_nama, ...dates],
                                function (error, results) {
                                    if (error) throw error;
                                    const shift = results.length > 0 ? results[0].shift : null;
                                    res.send({
                                        success: true,
                                        message: 'Berhasil ambil data hari ini!',
                                        kd_unit: kd_unit,
                                        workDate: focus,
                                        current_hour: currentHour,
                                        shift: shift,
                                        data: results
                                    });
                                }
                            );
                        };

                        if (currentHour < 14) {
                            connection.query(
                                `
                                SELECT 1 FROM tabsensitampung x
                                WHERE x.kar_nik = ? AND x.status_absen = 1 AND x.tanggal_kerja = ?
                                  AND NOT EXISTS (
                                      SELECT 1 FROM tabsensitampung y
                                      WHERE y.kar_nik = x.kar_nik
                                        AND y.tanggal_kerja = x.tanggal_kerja
                                        AND y.status_absen = 2)
                                LIMIT 1
                                `,
                                [kar_nik, kemarin],
                                function (err, checkRows) {
                                    if (err) throw err;
                                    focus = checkRows.length ? kemarin : today;
                                    tampilkanHariIni();
                                }
                            );
                        } else {
                            tampilkanHariIni();
                        }
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
                            function (error, results) {
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
        });
    },
}