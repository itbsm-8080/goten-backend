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

// tanggal_kerja: check-out shift 3 Senin-Jumat (23-07) = hari sebelumnya; lainnya = tanggal absen
function hitungTanggalKerja(tanggal, status_absen, shift, tipe) {
    const tanggalKerja = tanggal.slice(0, 10);
    if (status_absen === 2 && Number(shift) === 3 && tipe === 'HARI') {
        const prev = new Date(tanggalKerja + 'T00:00:00Z');
        prev.setUTCDate(prev.getUTCDate() - 1);
        return prev.toISOString().slice(0, 10);
    }
    return tanggalKerja;
}

// Hanya jabatan ini yang memakai shift (unit 20). Ubah di sini jika ada jabatan baru.
const SHIFT_JABATAN = ['25', '53', '65', '34', '59'];

function isShiftEligible(jabat) {
    return SHIFT_JABATAN.includes(String(jabat));
}

// Tipe hari dari tanggal WIB 'YYYY-MM-DD HH:mm:ss' atau 'YYYY-MM-DD'
function tipeHari(tanggal) {
    const d = new Date(tanggal.slice(0, 10) + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0=Minggu, 6=Sabtu
    if (day === 0) return 'MINGGU';
    if (day === 6) return 'SABTU';
    return 'HARI';
}

// Usulan shift default dari jam server (WIB) per tipe hari
function detectShift(tipe) {
    const jam = parseInt(waktuJakarta().slice(11, 13), 10);
    if (tipe === 'SABTU_BORONGAN') {
        if (jam >= 5 && jam < 14) return 1;
        return 2;
    }
    if (tipe === 'SABTU') {
        if (jam >= 5 && jam < 12) return 1;
        if (jam >= 12 && jam < 17) return 2;
        return 3;
    }
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
    const tanggal = waktuJakarta();
    const tipe = tipeHari(tanggal);

    if (status_absen !== 1 && status_absen !== 2) {
        return res.status(400).json({ success: false, message: 'status_absen harus 1 (check-in) atau 2 (check-out)', code: 'status_invalid' });
    }

    pool.getConnection(function (err, connection) {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Koneksi database gagal', code: 'error' });
        }

        const tolak = (pesan, kode = 'error') => {
            connection.release();
            res.status(400).json({ success: false, message: pesan, code: kode });
        };

        connection.query(
            'SELECT kar_kd_jabat, kar_sistem_gaji FROM tkaryawan WHERE kar_nik = ? LIMIT 1',
            [kar_nik],
            function (err, kary) {
                if (err) {
                    console.error(err);
                    return tolak('Terjadi kesalahan saat cek karyawan', 'error');
                }
                if (!kary.length) {
                    return tolak('Karyawan tidak ditemukan', 'error');
                }

                const jabat = kary[0].kar_kd_jabat;
                const borongan = String(kary[0].kar_sistem_gaji || '').toLowerCase() === 'borongan';
                const isShift = String(kd_cabang) === '20' && isShiftEligible(jabat) && tipe !== 'MINGGU';
                const tipeShift = tipe === 'SABTU' && borongan ? 'SABTU_BORONGAN' : tipe;
                const shift = isShift ? (parseInt(req.body.shift, 10) || detectShift(tipeShift)) : null;
                const kerja = isShift
                    ? hitungTanggalKerja(tanggal, status_absen, shift, tipeShift)
                    : tanggal.slice(0, 10);

                const selesai = () => {
                    connection.release();
                    const body = { success: true, message: 'Berhasil absensi!', status_absen, shift, tanggal, tanggal_kerja: kerja };
                    if (coba) body.waktu_absensi = tanggal;
                    res.send(body);
                };

                const masukkan = (shiftVal) => {
                    connection.query(
                        `INSERT INTO tabsensi (kar_nik, tanggal, cus_kode, customer, kd_cabang, cabang, latitude, longitude, status_absen, shift)
                         VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
                        [kar_nik, tanggal, kd_cabang, latitude, longitude, status_absen, shiftVal],
                        function (error) {
                            if (error) {
                                console.error(error);
                                return tolak('Terjadi kesalahan saat menyimpan absen', 'error');
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
                            return tolak('Terjadi kesalahan saat cek absen', 'error');
                        }
                        if (rows[0].jml > 0) {
                            return tolak(status_absen === 1
                                ? 'Anda sudah Check In pada tanggal kerja ini'
                                : 'Anda sudah Check Out pada tanggal kerja ini', 'duplicate');
                        }

                        // Jalur shift: check-in wajib dalam toleransi jam masuk shift hari itu
                        if (isShift) {
                            if (status_absen === 1) {
                                connection.query(
                                    `SELECT toleransi_mulai, toleransi_selesai FROM tshift WHERE kd_cabang = ? AND kd_shift = ? AND tipe_hari = ?`,
                                    [String(kd_cabang), shift, tipeShift],
                                    function (error, shiftRows) {
                                        if (error) {
                                            console.error(error);
                                            return tolak('Terjadi kesalahan saat cek shift', 'error');
                                        }
                                        if (!shiftRows.length) {
                                            return tolak('Shift tidak dikenal', 'shift_unknown');
                                        }
                                        const jam = tanggal.slice(11);
                                        if (jam < shiftRows[0].toleransi_mulai || jam > shiftRows[0].toleransi_selesai) {
                                            return tolak('Di luar jam masuk shift, pilih shift yang sesuai', 'shift_window');
                                        }
                                        masukkan(shift);
                                    }
                                );
                            } else {
                                masukkan(shift);
                            }
                        } else {
                            masukkan(null);
                        }
                    }
                );
            }
        );
    });
}

module.exports = {
    // Daftar shift hari ini untuk karyawan (POST). non_shift = karyawan bukan shift.
    getShiftDefault(req, res) {
        const kar_nik = req.body.kar_nik;
        const kd_cabang = req.body.kd_cabang || '20';
        const tanggal = waktuJakarta();
        const tipe = tipeHari(tanggal);

        const kirim = (hasil) => res.send({ success: true, ...hasil });

        pool.getConnection(function (err, connection) {
            if (err) throw err;

            connection.query(
                'SELECT kar_kd_jabat, kar_sistem_gaji FROM tkaryawan WHERE kar_nik = ? LIMIT 1',
                [kar_nik],
                function (err, kary) {
                    if (err) { connection.release(); throw err; }
                    if (!kary.length) {
                        connection.release();
                        kirim({ data: [], default_shift: null, non_shift: true });
                        return;
                    }

                    const jabat = kary[0].kar_kd_jabat;
                    const borongan = String(kary[0].kar_sistem_gaji || '').toLowerCase() === 'borongan';
                    const isShift = String(kd_cabang) === '20' && isShiftEligible(jabat) && tipe !== 'MINGGU';

                    if (!isShift) {
                        connection.release();
                        kirim({ data: [], default_shift: null, non_shift: true });
                        return;
                    }

                    const tipeShift = tipe === 'SABTU' && borongan ? 'SABTU_BORONGAN' : tipe;
                    connection.query(
                        `SELECT kd_shift, nm_shift,
                            TIME_FORMAT(jam_mulai,"%H:%i") jam_mulai,
                            TIME_FORMAT(jam_selesai,"%H:%i") jam_selesai,
                            TIME_FORMAT(toleransi_mulai,"%H:%i") toleransi_mulai,
                            TIME_FORMAT(toleransi_selesai,"%H:%i") toleransi_selesai
                         FROM tshift WHERE kd_cabang = ? AND tipe_hari = ? ORDER BY kd_shift`,
                        [String(kd_cabang), tipeShift],
                        function (error, results) {
                            connection.release();
                            if (error) throw error;
                            kirim({ data: results, default_shift: detectShift(tipeShift), non_shift: false });
                        }
                    );
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
                "SELECT kar_kd_unit, kar_kd_jabat FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
                [kar_nama],
                function (err, rows) {
                    if (err) throw err;

                    if (!rows.length) {
                        res.send({ success: false, message: "Karyawan tidak ditemukan" });
                        connection.release();
                        return;
                    }

                    let kd_unit = rows[0].kar_kd_unit;
                    let isShiftUser = kd_unit == 20 && isShiftEligible(rows[0].kar_kd_jabat);

                    let sql, params;
                    if (isShiftUser) {
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
                "SELECT kar_kd_unit, kar_kd_jabat, kar_nik FROM tkaryawan WHERE kar_nama = ? LIMIT 1",
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
                    let isShiftUser = kd_unit == 20 && isShiftEligible(rows[0].kar_kd_jabat) && currentHour >= 0 && tipeHari(today) !== 'MINGGU';

                    if (isShiftUser) {
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