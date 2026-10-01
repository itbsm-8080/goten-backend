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

// Hanya cabang 20 yang memakai shift. Jabatan tidak dibatasi.
const KD_CABANG_SHIFT = '20';

// Shift 0 = Day Shift (absensi biasa, tanpa jadwal jam).
const SHIFT_DAY = 0;

// Ambang check-in Day Shift, dipakai saat tidak ada jadwal shift yang berlaku.
const TOLERANSI_DAY = '08:01:00';

// Tipe hari dari tanggal WIB 'YYYY-MM-DD HH:mm:ss' atau 'YYYY-MM-DD'
function tipeHari(tanggal) {
    const d = new Date(tanggal.slice(0, 10) + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0=Minggu, 6=Sabtu
    if (day === 0) return 'MINGGU';
    if (day === 6) return 'SABTU';
    return 'HARI';
}

// Jadwal hari ini untuk tipe_hari yang berlaku (borongan -> SABTU_BORONGAN)
function tipeShiftDari(tipe, borongan) {
    return tipe === 'SABTU' && borongan ? 'SABTU_BORONGAN' : tipe;
}

// Usulan shift default dari jam server (WIB). Hari Minggu tidak punya jadwal shift.
function detectShift(tipe, jamServer, borongan) {
    const jam = jamServer !== undefined ? jamServer : parseInt(waktuJakarta().slice(11, 13), 10);
    if (tipe === 'MINGGU') return SHIFT_DAY;
    if (tipe === 'SABTU_BORONGAN') {
        if (jam >= 5 && jam < 14) return 1;
        if (jam >= 14 && jam < 22) return 2;
        return 3;
    }
    if (tipe === 'SABTU' && borongan) {
        // Borongan hari kerja mengikuti jadwal Sabtu: lebih awal, 8 jam.
        if (jam >= 5 && jam < 14) return 1;
        if (jam >= 14 && jam < 22) return 2;
        return 3;
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

// Sesi check-in yang belum ditutup pada shift tertentu, hanya untuk hari ini/kemarin.
// Kalau tidak ada, tanggal kerja untuk check-out adalah hari ini.
const SESI_TERBUKA_SQL = `
    SELECT DATE_FORMAT(tanggal_kerja, "%Y-%m-%d") tanggal_kerja
    FROM tabsensitampung x
    WHERE x.kar_nik = ? AND COALESCE(x.shift, 0) = ? AND x.status_absen = 1
      AND x.tanggal_kerja >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), "%Y-%m-%d")
      AND NOT EXISTS (
          SELECT 1 FROM tabsensitampung y
          WHERE y.kar_nik = x.kar_nik
            AND COALESCE(y.shift, 0) = x.shift
            AND y.tanggal_kerja = x.tanggal_kerja
            AND y.status_absen = 2)
    ORDER BY x.tanggal_kerja DESC
    LIMIT 1
`;

function sesiTerbuka(kar_nik, shift) {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) return reject(err);
            connection.query(SESI_TERBUKA_SQL, [kar_nik, shift], (error, rows) => {
                connection.release();
                if (error) return reject(error);
                resolve(rows.length ? rows[0].tanggal_kerja : null);
            });
        });
    });
}

// Versi pure dari sesiTerbuka, untuk diuji tanpa database.
// rows harus sudah difilter ke satu shift.
function sesiTerbukaDari(rows) {
    const tertutup = new Set(rows.filter((r) => r.status_absen === 2).map((r) => r.tanggal_kerja));
    const terbuka = rows
        .filter((r) => r.status_absen === 1 && !tertutup.has(r.tanggal_kerja))
        .sort((a, b) => (a.tanggal_kerja < b.tanggal_kerja ? 1 : -1));
    return terbuka.length ? terbuka[0].tanggal_kerja : null;
}

// Tanggal kerja untuk check-out: ikut sesi check-in yang masih terbuka.
// Inilah yang bikin shift 3 malam (check-in 23:00, check-out 07:00) terhitung
// satu hari kerja, tanpa aturan shift khusus.
function tanggalKerjaCheckOut(rows, hariIni) {
    return sesiTerbukaDari(rows) || hariIni;
}

// Toleransi tidak menolak absen - hanya menandai terlambat.
// toleransi_selesai sudah diformat 'HH:MM:SS' oleh TIME_FORMAT di query.
function cekTerlambat(shift, jam, toleransi_selesai) {
    if (!shift || shift === SHIFT_DAY || !toleransi_selesai) return jam > TOLERANSI_DAY;
    return jam > toleransi_selesai;
}

// Shift akhir yang dipakai: Minggu selalu Day Shift, cabang lain juga Day Shift.
function resolveShift(tipe, diminta, tipeShift, borongan) {
    if (tipe === 'MINGGU') return SHIFT_DAY;
    if (!isNaN(diminta)) return diminta;
    return detectShift(tipeShift, undefined, borongan);
}

// Query history untuk unit/cabang 20 (Day Shift + 3 shift).
// Toleransi diambil per shift dari tshift, jadi tidak ada ambang 08:01 hardcoded di sini.
const SQL_HISTORY_UNIT20 = `
    SELECT *, IF(terlambat, "Terlambat", "Tepat Waktu") Status, shift_name
    FROM (
        SELECT DISTINCT
            kar_nama Nama,
            DATE_FORMAT(a.tanggal_kerja, "%Y-%m-%d") as Tanggal,
            COALESCE(a.shift, 0) shift,
            COALESCE(s.nm_shift, "Day Shift") shift_name,
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0) ORDER BY tanggal LIMIT 1) _IN,
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=2 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0) ORDER BY tanggal LIMIT 1) _OUT,
            IF(
                COALESCE(a.shift, 0) = 0 OR s.toleransi_selesai IS NULL,
                IF((SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0)) > "08:01:00", 1, 0),
                IF((SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0)) > TIME_FORMAT(s.toleransi_selesai, "%H:%i:%s"), 1, 0)
            ) terlambat
        FROM tabsensitampung a
        INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
        LEFT JOIN tshift s ON s.kd_cabang = "20" AND s.kd_shift = COALESCE(a.shift, 0) AND s.tipe_hari = CASE
            WHEN DAYOFWEEK(a.tanggal_kerja) = 7 THEN IF(LOWER(COALESCE(b.kar_sistem_gaji,"")) = "borongan", "SABTU_BORONGAN", "SABTU")
            WHEN DAYOFWEEK(a.tanggal_kerja) = 1 THEN "MINGGU"
            ELSE "HARI"
        END
        WHERE a.tanggal_kerja IS NOT NULL
    ) FINAL
`;

// Lakukan Absensi: validasi + INSERT tabsensi. Trigger hanya mencerminkan ke tabsensitampung.
function prosesAbsen(req, res, coba = false) {
    const kar_nik = req.body.kar_nik;
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
            'SELECT kar_kd_unit, kar_sistem_gaji FROM tkaryawan WHERE kar_nik = ? LIMIT 1',
            [kar_nik],
            function (err, kary) {
                if (err) {
                    console.error(err);
                    return tolak('Terjadi kesalahan saat cek karyawan', 'error');
                }
                if (!kary.length) {
                    return tolak('Karyawan tidak ditemukan', 'error');
                }

                // Gate dibaca dari data karyawan, bukan dari body client.
                const kd_cabang = String(kary[0].kar_kd_unit || '');
                const borongan = String(kary[0].kar_sistem_gaji || '').toLowerCase() === 'borongan';
                const tipeShift = tipeShiftDari(tipe, borongan);
                const isShift = kd_cabang === KD_CABANG_SHIFT && tipe !== 'MINGGU';

                // Minggu hanya Day Shift. Client yang mengirim shift lain tetap dipaksa ke 0.
                const shift = isShift
                    ? resolveShift(tipe, parseInt(req.body.shift, 10), tipeShift, borongan)
                    : SHIFT_DAY;

                const jam = tanggal.slice(11);

                // Toleransi hanya menandai terlambat, tidak menolak.
                connection.query(
                    `SELECT TIME_FORMAT(toleransi_selesai, "%H:%i:%s") toleransi_selesai
                     FROM tshift WHERE kd_cabang = ? AND kd_shift = ? AND tipe_hari = ?`,
                    [kd_cabang, shift, tipeShift],
                    function (error, shiftRows) {
                        if (error) {
                            console.error(error);
                            return tolak('Terjadi kesalahan saat cek shift', 'error');
                        }
                        const toleransi = shiftRows.length ? shiftRows[0].toleransi_selesai : null;
                        const terlambat = status_absen === 1 && cekTerlambat(shift, jam, toleransi);

                        // Check-out memakai tanggal kerja sesi check-in yang masih terbuka
                        // pada shift ini (bikin shift 3 malam 23:00-07:00 terhitung satu hari kerja).
                        if (status_absen === 2) {
                            return sesiTerbuka(kar_nik, shift).then((tgl) => {
                                if (!tgl) return tolak('Belum ada Check In pada shift ini', 'no_open_session');
                                lanjut(tgl);
                            }, () => tolak('Terjadi kesalahan saat cek sesi', 'error'));
                        }

                        lanjut(tanggal.slice(0, 10));

                        function lanjut(kerja) {
                            // Duplikat: maksimal 1 record per (kar_nik, tanggal_kerja, shift, status_absen)
                            connection.query(
                                `SELECT COUNT(*) AS jml FROM tabsensitampung
                                 WHERE kar_nik = ? AND tanggal_kerja = ? AND COALESCE(shift,0) = ? AND status_absen = ?`,
                                [kar_nik, kerja, shift, status_absen],
                                function (error, rows) {
                                    if (error) {
                                        console.error(error);
                                        return tolak('Terjadi kesalahan saat cek absen', 'error');
                                    }
                                    if (rows[0].jml > 0) {
                                        return tolak(status_absen === 1
                                            ? 'Anda sudah Check In pada shift ini'
                                            : 'Anda sudah Check Out pada shift ini', 'duplicate');
                                    }

                                    connection.query(
                                        `INSERT INTO tabsensi (kar_nik, tanggal, cus_kode, customer, kd_cabang, cabang, latitude, longitude, status_absen, shift, tanggal_kerja)
                                         VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
                                        [kar_nik, tanggal, kd_cabang, latitude, longitude, status_absen, shift, kerja],
                                        function (error) {
                                            if (error) {
                                                console.error(error);
                                                return tolak('Terjadi kesalahan saat menyimpan absen', 'error');
                                            }
                                            connection.release();
                                            const body = {
                                                success: true,
                                                message: 'Berhasil absensi!',
                                                status_absen,
                                                shift,
                                                shift_name: shift ? undefined : 'Day Shift',
                                                terlambat,
                                                tanggal,
                                                tanggal_kerja: kerja,
                                            };
                                            if (coba) body.waktu_absensi = tanggal;
                                            res.send(body);
                                        }
                                    );
                                }
                            );
                        }
                    }
                );
            }
        );
    });
}

module.exports = {
    // Daftar shift hari ini untuk karyawan (POST). Semua karyawan cabang 20 punya pilihan,
    // termasuk hari Minggu (hanya Day Shift). Cabang lain tidak punya pilihan shift.
    getShiftDefault(req, res) {
        const kar_nik = req.body.kar_nik;
        const tanggal = waktuJakarta();
        const tipe = tipeHari(tanggal);

        const kirim = (hasil) => res.send({ success: true, ...hasil });
        const dayShift = [{ kd_shift: SHIFT_DAY, nm_shift: 'Day Shift', jam_mulai: null, jam_selesai: null, toleransi_mulai: null, toleransi_selesai: null }];

        pool.getConnection(function (err, connection) {
            if (err) return res.status(500).json({ success: false, message: 'Koneksi database gagal', code: 'error' });

            connection.query(
                'SELECT kar_kd_unit, kar_sistem_gaji FROM tkaryawan WHERE kar_nik = ? LIMIT 1',
                [kar_nik],
                function (err, kary) {
                    if (err) { connection.release(); return res.status(500).json({ success: false, message: 'Koneksi database gagal', code: 'error' }); }
                    if (!kary.length) {
                        connection.release();
                        return kirim({ data: [], default_shift: SHIFT_DAY, non_shift: true });
                    }

                    // Gate dari data karyawan, bukan dari body client.
                    const kd_cabang = String(kary[0].kar_kd_unit || '');
                    const borongan = String(kary[0].kar_sistem_gaji || '').toLowerCase() === 'borongan';

                    if (kd_cabang !== KD_CABANG_SHIFT || tipe === 'MINGGU') {
                        connection.release();
                        return kirim({ data: dayShift, default_shift: SHIFT_DAY, non_shift: true });
                    }

                    const tipeShift = tipeShiftDari(tipe, borongan);
                    connection.query(
                        `SELECT kd_shift, nm_shift,
                            TIME_FORMAT(jam_mulai,"%H:%i") jam_mulai,
                            TIME_FORMAT(jam_selesai,"%H:%i") jam_selesai,
                            TIME_FORMAT(toleransi_mulai,"%H:%i") toleransi_mulai,
                            TIME_FORMAT(toleransi_selesai,"%H:%i") toleransi_selesai
                         FROM tshift WHERE kd_cabang = ? AND tipe_hari = ? ORDER BY kd_shift`,
                        [kd_cabang, tipeShift],
                        function (error, results) {
                            connection.release();
                            if (error) return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat cek shift', code: 'error' });
                            kirim({
                                data: [...dayShift, ...results],
                                default_shift: detectShift(tipeShift, undefined, borongan),
                                non_shift: false,
                            });
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

    // Fungsi murni untuk test/absensi.test.js
    _test: {
        SESI_TERBUKA_SQL,
        sesiTerbukaDari,
        tanggalKerjaCheckOut,
        cekTerlambat,
      resolveShift,
      detectShift,
      tipeShiftDari,
      TOLERANSI_DAY,
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
                    let isShiftUser = String(kd_unit) === KD_CABANG_SHIFT;

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
                    let isShiftUser = String(kd_unit) === KD_CABANG_SHIFT;

                    if (isShiftUser) {
                        // Cabang 20: sesi 7 hari terakhir per (tanggal_kerja, shift), plus sesi
                        // yang masih terbuka supaya client bisa menentukan tombol aktif tanpa menebak.
                        connection.query(
                            SQL_HISTORY_UNIT20 + ` WHERE Nama = ? AND Tanggal >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 7 DAY), "%Y-%m-%d") ORDER BY Tanggal ASC, shift ASC;`,
                            [kar_nama],
                            function (error, results) {
                                if (error) throw error;
                                connection.release();

                                const terbuka = results.filter((r) => r._IN && !r._OUT);
                                const open = terbuka.length ? terbuka[terbuka.length - 1] : null;

                                res.send({
                                    success: true,
                                    message: 'Berhasil ambil data hari ini!',
                                    kd_unit: kd_unit,
                                    workDate: open ? open.Tanggal : today,
                                    current_hour: currentHour,
                                    shift: open ? Number(open.shift) : null,
                                    // Sesi yang akan ditutup kalau user tekan Check Out.
                                    open_shift: terbuka.map((r) => Number(r.shift)),
                                    open_work_date: terbuka.map((r) => r.Tanggal),
                                    data: results
                                });
                            }
                        );
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
                                connection.release();
                                const terbuka = results.filter((r) => r._IN && !r._OUT);
                                res.send({
                                    success: true,
                                    message: 'Berhasil ambil data hari ini!',
                                    kd_unit: kd_unit,
                                    workDate: today,
                                    current_hour: currentHour,
                                    open_shift: terbuka.map((r) => Number(r.shift ?? 0)),
                                    open_work_date: terbuka.map(() => today),
                                    data: results
                                });
                            }
                        );
                    }
                }
            );
        });
    },
}