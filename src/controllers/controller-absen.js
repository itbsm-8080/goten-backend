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

// Sesi check-in terakhir pada shift tertentu (hari ini/kemarin), beserta jam check-in
// pertamanya dan jumlah check-out yang sudah tercatat.
//
// Dihitung dari tabsensi (log mentah), bukan tabsensitampung: tabel cermin punya
// PRIMARY KEY (kar_nik, tanggal, status_absen) sehingga dua check-out di detik yang sama
// saling menimpa dan tidak bisa dipakai menghitung jumlah tap.
const SESI_SESUDAHNYA_SQL = `
    SELECT
        DATE_FORMAT(rani.tanggal_kerja, "%Y-%m-%d") tanggal_kerja,
        (SELECT MIN(tanggal) FROM tabsensi
         WHERE kar_nik = rani.kar_nik AND COALESCE(shift, 0) = COALESCE(rani.shift, 0)
           AND tanggal_kerja = rani.tanggal_kerja AND status_absen = 1) check_in_pertama,
        (SELECT COUNT(*) FROM tabsensi
         WHERE kar_nik = rani.kar_nik AND COALESCE(shift, 0) = COALESCE(rani.shift, 0)
           AND tanggal_kerja = rani.tanggal_kerja AND status_absen = 2) jumlah_check_out,
        (SELECT MAX(tanggal) FROM tabsensi
         WHERE kar_nik = rani.kar_nik AND COALESCE(shift, 0) = COALESCE(rani.shift, 0)
           AND tanggal_kerja = rani.tanggal_kerja AND status_absen = 2) check_out_terakhir
    FROM tabsensi rani
    WHERE rani.kar_nik = ? AND COALESCE(rani.shift, 0) = ? AND rani.status_absen = 1
      AND rani.tanggal_kerja >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), "%Y-%m-%d")
    ORDER BY rani.tanggal_kerja DESC, rani.tanggal DESC
    LIMIT 1
`;

// Batas check-out berulang: maksimal 3x per sesi.
// Batas jam hanya berlaku untuk check-out kedua ke atas (koreksi tap sebelumnya).
// Check-out pertama tidak dibatasi jam, karena shift normal 8 jam dan ada yang lembur.
const MAX_CHECK_OUT = 3;
const MAKS_JAM_CHECK_OUT = 10;

function sesiTerakhir(kar_nik, shift) {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) return reject(err);
            connection.query(SESI_SESUDAHNYA_SQL, [kar_nik, shift], (error, rows) => {
                connection.release();
                if (error) return reject(error);
                if (!rows.length) return resolve(null);
                const r = rows[0];
                resolve({
                    tanggalKerja: r.tanggal_kerja,
                    checkInPertama: r.check_in_pertama,
                    jumlahCheckOut: r.jumlah_check_out,
                    checkOutTerakhir: r.check_out_terakhir,
                });
            });
        });
    });
}

// Versi pure dari sesiTerakhir, untuk diuji tanpa database.
// rows harus sudah difilter ke satu shift dan satu tanggal_kerja.
function sesiTerakhirDari(rows) {
    if (!rows.length) return null;
    const masuk = rows.filter((r) => r.status_absen === 1).map((r) => r.tanggal).sort();
    const keluar = rows.filter((r) => r.status_absen === 2).map((r) => r.tanggal).sort();
    return {
        checkInPertama: masuk[0] || null,
        jumlahCheckOut: keluar.length,
        checkOutTerakhir: keluar[keluar.length - 1] || null,
    };
}

// Terima atau tolak check-out.
// - tidak ada check-in       -> tolak (harus check in dulu)
// - sudah MAX_CHECK_OUT      -> tolak
// - sudah pernah check-out dan lewat MAKS_JAM_CHECK_OUT jam -> tolak
//
// Batas jam sengaja hanya untuk check-out kedua ke atas. Check-out pertama tidak
// dibatasi karena shift normal 8 jam dan sebagian orang lembur lebih dari 10 jam -
// membatasinya membuat mereka tidak bisa pulang sama sekali.
function bolehCheckOut(sesi, sekarang) {
    if (!sesi || !sesi.checkInPertama) {
        return { ok: false, kode: 'no_open_session', pesan: 'Belum ada Check In pada shift ini' };
    }
    if (sesi.jumlahCheckOut >= MAX_CHECK_OUT) {
        return {
            ok: false,
            kode: 'max_check_out',
            pesan: `Check Out sudah dicatat ${MAX_CHECK_OUT} kali, tidak bisa diubah lagi`,
        };
    }
    if (sesi.jumlahCheckOut > 0) {
        const jam = (sekarang.getTime() - sesi.checkInPertama.getTime()) / 3600000;
        if (jam > MAKS_JAM_CHECK_OUT) {
            return {
                ok: false,
                kode: 'checkout_expired',
                pesan: `Check Out hanya bisa diubah dalam ${MAKS_JAM_CHECK_OUT} jam setelah Check In`,
            };
        }
    }
    return { ok: true, perbaikan: sesi.jumlahCheckOut > 0 };
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
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=2 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0) ORDER BY tanggal DESC LIMIT 1) _OUT,
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

                        // Check-out.
                        //
                        // Cabang 20: pakai sesi check-in terakhir pada shift ini, supaya shift 3
                        // malam (23:00-07:00) terhitung satu hari kerja, dan supaya sesi yang
                        // sudah tertutup masih bisa ditutup lagi (batas 3x / 10 jam koreksi).
                        //
                        // Cabang selain 20: data historisnya tidak punya tanggal_kerja maupun
                        // shift, jadi pakai tanggal hari ini - seperti sebelum fitur shift ada.
                        if (status_absen === 2 && isShift) {
                            return sesiTerakhir(kar_nik, shift).then((sesi) => {
                                const cek = bolehCheckOut(sesi, new Date(tanggal.replace(' ', 'T')));
                                if (!cek.ok) return tolak(cek.pesan, cek.kode);
                                lanjut(sesi.tanggalKerja, cek.perbaikan);
                            }, () => tolak('Terjadi kesalahan saat cek sesi', 'error'));
                        }

                        lanjut(tanggal.slice(0, 10), false);

                        function lanjut(kerja, perbaikan) {
                            // Duplikat. Check-in tetap maksimal sekali; check-out boleh berulang
                            // sampai batas MAX_CHECK_OUT (sudah divalidasi di bolehCheckOut).
                            if (status_absen === 1) {
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
                                            return tolak('Anda sudah Check In pada shift ini', 'duplicate');
                                        }
                                        simpan();
                                    }
                                );
                            } else {
                                simpan();
                            }

                            function simpan() {
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
                                            perbaikan: !!perbaikan,
                                            tanggal,
                                            tanggal_kerja: kerja,
                                        };
                                        if (coba) body.waktu_absensi = tanggal;
                                        res.send(body);
                                    }
                                );
                            }
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
        SESI_SESUDAHNYA_SQL,
        sesiTerakhirDari,
        bolehCheckOut,
        cekTerlambat,
        resolveShift,
        detectShift,
        tipeShiftDari,
        TOLERANSI_DAY,
        MAX_CHECK_OUT,
        MAKS_JAM_CHECK_OUT,
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
                                    ORDER BY tanggal DESC LIMIT 1) _OUT
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
                        // Cabang 20: sesi 7 hari terakhir per (tanggal_kerja, shift).
                        // check_out_shift = shift yang punya Check In (boleh ditutup lagi kalau
                        // masih dalam batas 3x / 10 jam koreksi). open_shift = yang belum ditutup.
                        connection.query(
                            SQL_HISTORY_UNIT20 + ` WHERE Nama = ? AND Tanggal >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 7 DAY), "%Y-%m-%d") ORDER BY Tanggal ASC, shift ASC;`,
                            [kar_nama],
                            function (error, results) {
                                if (error) throw error;
                                connection.release();

                                const denganMasuk = results.filter((r) => r._IN);
                                const terbuka = denganMasuk.filter((r) => !r._OUT);
                                const open = terbuka.length ? terbuka[terbuka.length - 1] : null;

                                res.send({
                                    success: true,
                                    message: 'Berhasil ambil data hari ini!',
                                    kd_unit: kd_unit,
                                    workDate: open ? open.Tanggal : today,
                                    current_hour: currentHour,
                                    shift: open ? Number(open.shift) : null,
                                    open_shift: terbuka.map((r) => Number(r.shift)),
                                    open_work_date: terbuka.map((r) => r.Tanggal),
                                    check_out_shift: denganMasuk.map((r) => Number(r.shift)),
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
                                    ORDER BY tanggal DESC LIMIT 1) _OUT
                                FROM tabsensitampung a
                                INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
                            ) FINAL
                            WHERE Nama = ? AND Tanggal = ?;
                            `,
                            [kar_nama, today],
                            function (error, results) {
                                if (error) throw error;
                                connection.release();
                                const denganMasuk = results.filter((r) => r._IN);
                                const terbuka = denganMasuk.filter((r) => !r._OUT);
                                res.send({
                                    success: true,
                                    message: 'Berhasil ambil data hari ini!',
                                    kd_unit: kd_unit,
                                    workDate: today,
                                    current_hour: currentHour,
                                    open_shift: terbuka.map((r) => Number(r.shift ?? 0)),
                                    open_work_date: terbuka.map(() => today),
                                    check_out_shift: denganMasuk.map((r) => Number(r.shift ?? 0)),
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