const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

const rotiq = require('../services/rotiq');

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

const KD_CABANG_SHIFT = '20';
const JABATAN_DRIVER = rotiq.JABATAN_DRIVER;
const SHIFT_SORE = 2;

function unitRotiQ(kdUnit) {
  return rotiq.UNIT_ROTIQ.includes(String(kdUnit));
}

function pakaiShift(kdUnit, kdJabat) {
  return String(kdUnit) === KD_CABANG_SHIFT || rotiq.isShiftRotiQ(kdUnit, kdJabat);
}

function driverRotiQ(kdUnit, kdJabat) {
  return unitRotiQ(kdUnit) && String(kdJabat) === JABATAN_DRIVER;
}

// Jadwal RotiQ memakai unit acuan, dengan fallback ke unit RotiQ lain kalau
// unit pilihan belum punya baris tshift.
function syaratJadwalShift(kdUnitAsal, kdUnitAcuan) {
  if (!unitRotiQ(kdUnitAsal)) {
    return {
      where: `AND kd_cabang = ${mysql.escape(kdUnitAcuan)}`,
      order: 'kd_shift',
      fallback: false,
    };
  }
  return {
    where: `AND (kd_cabang = ${mysql.escape(kdUnitAcuan)} OR kd_cabang IN (${rotiq.UNIT_ROTIQ_SQL}))`,
    order: `kd_cabang = ${mysql.escape(kdUnitAcuan)} DESC, kd_shift`,
    fallback: true,
  };
}

function saringJadwalShift(rows) {
  const dipakai = new Set();
  return rows.filter((r) => {
    const kunci = Number(r.kd_shift);
    if (dipakai.has(kunci)) return false;
    dipakai.add(kunci);
    return true;
  });
}

// Shift 0 = Day Shift (absensi biasa, tanpa jadwal jam).
const SHIFT_DAY = 0;

// Ambang check-in Day Shift, dipakai saat tidak ada jadwal shift yang berlaku.
const TOLERANSI_DAY = '08:01:00';

// Radius jangkauan absen, meter. Nilai asli ada di tunit.radius_absen; ini
// cadangan kalau kolomnya kosong atau data unit tidak ketemu.
const RADIUS_JANGKAUAN = 25;

// Penolakan jarak ditahan sampai aplikasi yang mengirim kd_unit RotiQ tersebar.
// Versi sebelumnya memakai unit asal sebagai acuan, jadi bisa menolak absen sah.
// off = hitung saja, log = catat, block = tolak.
function modeRadiusAbsen() {
    return (process.env.ABSEN_RADIUS_MODE || 'off').toLowerCase();
}

// Jarak dua titik bumi (meter), haversine. radius bumi 6371 km.
function jarakMeter(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Parse koordinat yang mungkin datang sebagai string atau null.
// tunit.latitude/longitude bertipe varchar, jadi harus di-cast.
function koordinatAngka(nilai) {
    const n = parseFloat(nilai);
    return Number.isFinite(n) ? n : null;
}

// Validasi lokasi check-in/check-out terhadap titik absen di tunit.
// - unit tanpa koordinat  -> lewati, unitnya tidak bisa dikunci
// - koordinat HP tidak valid -> tolak, kalau dilewati tinggal(absen tanpa koordinat
// - jarak >= radius        -> tolak
function cekJangkauan(latHp, lngHp, latUnit, lngUnit, radius = RADIUS_JANGKAUAN) {
    const la = koordinatAngka(latHp);
    const ln = koordinatAngka(lngHp);
    if (la === null || ln === null) {
        return { ok: false, kode: 'koordinat_invalid', pesan: 'Lokasi GPS tidak terbaca, pastikan lokasi HP aktif' };
    }
    if (la === 0 && ln === 0) {
        return { ok: false, kode: 'koordinat_invalid', pesan: 'Lokasi GPS belum siap, coba beberapa saat lagi' };
    }

    const ua = koordinatAngka(latUnit);
    const un = koordinatAngka(lngUnit);
    // tunit tanpa koordinat: tidak ada titik acuan, jadi tidak bisa dinilai.
    if (ua === null || un === null || (ua === 0 && un === 0)) return { ok: true };

    const jarak = jarakMeter(la, ln, ua, un);
    if (jarak >= radius) {
        return {
            ok: false,
            kode: 'out_of_range',
            pesan: `Di luar jangkauan ${radius} meter dari titik absen (jarak ${Math.round(jarak)} meter)`,
            jarak,
        };
    }
    return { ok: true, jarak };
}

// Tipe hari dari tanggal WIB 'YYYY-MM-DD HH:mm:ss' atau 'YYYY-MM-DD'
function tipeHari(tanggal) {
    const d = new Date(tanggal.slice(0, 10) + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0=Minggu, 6=Sabtu
    if (day === 0) return 'MINGGU';
    if (day === 6) return 'SABTU';
    return 'HARI';
}

// Jadwal hari ini untuk tipe_hari yang berlaku (borongan -> SABTU_BORONGAN)
function tipeShiftDari(tipe, borongan, driver, kategori) {
    if (driver) return 'HARI_DRIVER';
    if (kategori === 'kasir') return 'HARI';
    if (tipe === 'MINGGU') return tipe;
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

// Sesi yang punya Check In pada hari ini/kemarin, semua shift, beserta jam check-in
// pertamanya, jumlah check-out, dan apakah jadwal shift-nya melewati tengah malam.
//
// 'malam' dibaca dari tshift (jam_selesai < jam_mulai), bukan dari nomor shift: shift 3
// Sabtu 17:00-22:00 tidak melewati tengah malam, sedangkan 3 HARI 23:00-07:00 dan
// 3 SABTU_BORONGAN 22:00-06:00 iya. Kalau jadwalnya diubah HR, aturannya ikut.
const SESI_PENGHALANGI_SQL = `
    SELECT
        DATE_FORMAT(rani.tanggal_kerja, "%Y-%m-%d") tanggal_kerja,
        COALESCE(rani.shift, 0) shift,
        (SELECT IF(ts.jam_selesai < ts.jam_mulai, 1, 0)
         FROM tshift ts
         INNER JOIN tkaryawan tk ON tk.kar_nik = rani.kar_nik
         WHERE ts.kd_cabang = tk.kar_kd_unit AND ts.kd_shift = COALESCE(rani.shift, 0)
           AND ts.tipe_hari = ${rotiq.tipeJadwalSql('rani.tanggal_kerja', 'tk')}
         LIMIT 1) malam,
        (SELECT MIN(tanggal) FROM tabsensi
         WHERE kar_nik = rani.kar_nik AND COALESCE(shift, 0) = COALESCE(rani.shift, 0)
           AND tanggal_kerja = rani.tanggal_kerja AND status_absen = 1) check_in_pertama,
        (SELECT COUNT(*) FROM tabsensi
         WHERE kar_nik = rani.kar_nik AND COALESCE(shift, 0) = COALESCE(rani.shift, 0)
           AND tanggal_kerja = rani.tanggal_kerja AND status_absen = 2) jumlah_check_out
    FROM tabsensi rani
    WHERE rani.kar_nik = ? AND rani.status_absen = 1
      AND rani.tanggal_kerja >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), "%Y-%m-%d")
    ORDER BY rani.tanggal_kerja DESC, rani.tanggal DESC
`;

// Jam berapa sesi yang belum keluar masih memblokir check-in baru, dihitung dari
// tengah malam setelah tanggal kerjanya.
const BATAS_RESET_BIASA = 1; // 01:00 - sesi biasa selesai jam itu
const BATAS_RESET_MALAM = 9; // 09:00 - shift malam 23:00-07:00 baru selesai sekitar jam 7

// Sesi tanpa check-out memblokir check-in baru hanya sampai batas resetnya:
// sesi biasa sampai 01:00, sesi shift malam sampai 09:00. Sesi yang sudah punya
// check-out tidak pernah memblokir, berapa pun umurnya.
function sesiMemblockir(sesi, sekarang) {
    if (!sesi || Number(sesi.jumlahCheckOut) > 0) return false;
    const bagian = String(sesi.tanggalKerja || '').split('-').map(Number);
    if (bagian.length !== 3 || bagian.some((n) => !Number.isFinite(n))) return false;
    const [y, m, d] = bagian;
    // Masih di tanggal kerja sesi itu sendiri -> belum selesai apa pun.
    if (sekarang < new Date(y, m - 1, d + 1)) return true;
    const batasJam = Number(sesi.malam) ? BATAS_RESET_MALAM : BATAS_RESET_BIASA;
    return sekarang < new Date(y, m - 1, d + 1, batasJam, 0, 0);
}

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

// Semua sesi yang punya Check In hari ini/kemarin, untuk dipakai validasi check-in.
function sesiPenghalang(kar_nik) {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) return reject(err);
            connection.query(SESI_PENGHALANGI_SQL, [kar_nik], (error, rows) => {
                connection.release();
                if (error) return reject(error);
                resolve(rows.map((r) => ({
                    tanggalKerja: r.tanggal_kerja,
                    shift: Number(r.shift),
                    malam: Number(r.malam),
                    checkInPertama: r.check_in_pertama,
                    jumlahCheckOut: Number(r.jumlah_check_out),
                })));
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
    if (tipeShift === 'MINGGU') return SHIFT_DAY;
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
            IF(s.jam_selesai IS NULL, 0, IF(s.jam_selesai < s.jam_mulai, 1, 0)) malam,
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0) ORDER BY tanggal LIMIT 1) _IN,
            (SELECT DATE_FORMAT(tanggal,"%H:%i:%s") FROM tabsensitampung WHERE status_absen=2 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0) ORDER BY tanggal DESC LIMIT 1) _OUT,
            IF(
                COALESCE(a.shift, 0) = 0 OR s.toleransi_selesai IS NULL,
                IF((SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0)) > "08:01:00", 1, 0),
                IF((SELECT TIME_FORMAT(MIN(tanggal), "%H:%i:%s") FROM tabsensitampung WHERE status_absen=1 AND kar_nik=a.kar_nik AND tanggal_kerja=a.tanggal_kerja AND COALESCE(shift,0)=COALESCE(a.shift,0)) > TIME_FORMAT(s.toleransi_selesai, "%H:%i:%s"), 1, 0)
            ) terlambat
        FROM tabsensitampung a
        INNER JOIN tkaryawan b ON a.kar_nik=b.kar_nik
        LEFT JOIN tshift s ON s.kd_cabang = b.kar_kd_unit AND s.kd_shift = COALESCE(a.shift, 0) AND s.tipe_hari = ${rotiq.tipeJadwalSql('a.tanggal_kerja', 'b')}
        WHERE a.tanggal_kerja IS NOT NULL
    ) FINAL
`;

// Sesi 7 hari terakhir untuk cabang 20. DESC supaya sesi terbaru ada di baris
// pertama - client mengambil sesi pertama yang cocok, dan kalau urut ASC card
// menampilkan data tertua (mis. sesi minggu lalu yang check-out-nya kosong).
const SQL_HISTORY_7_HARI = SQL_HISTORY_UNIT20
    + ` WHERE Nama = ? AND Tanggal >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 7 DAY), "%Y-%m-%d")`
    + ` ORDER BY Tanggal DESC, shift DESC;`;

// Sesi yang relevan untuk status hari ini.
//
// Memakai aturan yang sama dengan validasi check-in supaya kartu dan server tidak
// berbeda paham. Baris history (_IN/_OUT) dipetakan ke bentuk sesi yang sama
// dengan SESI_PENGHALANGI_SQL, termasuk penanda 'malam' dari jadwal tshift.
//
// sesiTampil = work date yang boleh muncul di kartu: hari ini, plus sesi yang belum
// keluar dan belum melewati batas resetnya. Sesi yang sudah keluar dari hari
// sebelumnya tidak ditampilkan - itu bukan absen hari ini.
function sesiAktif(results, hariIni, sekarang) {
    // Diurutkan sendiri, jangan bergantung urutan dari SQL: sesi terbaru harus
    // jadi acuan walau urutan rows berubah.
    const urut = results
        .filter((r) => r._IN)
        .sort((a, b) => (a.Tanggal < b.Tanggal ? 1 : a.Tanggal > b.Tanggal ? -1 : 0))
        .map((r) => ({
            tanggalKerja: r.Tanggal,
            shift: Number(r.shift),
            malam: Number(r.malam),
            jumlahCheckOut: r._OUT ? 1 : 0,
            row: r,
        }));

    const tampil = urut.filter((s) => s.tanggalKerja === hariIni || sesiMemblockir(s, sekarang));
    const terbuka = urut.filter((s) => sesiMemblockir(s, sekarang));

    return {
        open: terbuka.length ? terbuka[0].row : null,
        openShift: terbuka.map((s) => s.shift),
        openWorkDate: terbuka.map((s) => s.tanggalKerja),
        // Sesi yang masih boleh ditutup: sesi hari ini, atau yang belum keluar.
        checkOutShift: tampil.map((s) => s.shift),
        sesiTampil: Array.from(new Set(tampil.map((s) => s.tanggalKerja))),
    };
}

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
            // Titik acuan absen: unit asal (u), atau unit pilihan client (p) kalau
            // karyawannya berhak - RotiQ boleh pindah unit, akunting boleh pindah
            // cabang BSM. Syarat hak akses ada di ON clause, bukan di sini, supaya
            // kd_unit dari karyawan lain tidak bisa mengganti titik acuan.
            // Radius ikut unit acuan, jadi tiap lokasi bisa beda.
            `SELECT k.kar_kd_unit, k.kar_kd_jabat, k.kar_sistem_gaji,
                    p.kd_unit kd_unit_acuan,
                    COALESCE(p.latitude, u.latitude) lat_unit,
                    COALESCE(p.longitude, u.longitude) lng_unit,
                    COALESCE(p.radius_absen, u.radius_absen, ${RADIUS_JANGKAUAN}) radius_unit
             FROM tkaryawan k
             LEFT JOIN tunit u ON u.kd_unit = k.kar_kd_unit
             LEFT JOIN tunit p ON p.kd_unit = ? AND ${rotiq.syaratUnitPilihan('p')}
             WHERE k.kar_nik = ? LIMIT 1`,
            [req.body.kd_unit || '', kar_nik],
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
                const kdUnitAcuan = String(kary[0].kd_unit_acuan || kd_cabang);
                const kd_jabat = String(kary[0].kar_kd_jabat || '');
                const borongan = String(kary[0].kar_sistem_gaji || '').toLowerCase() === 'borongan';
                const kategoriRotiQ = rotiq.kategoriShift(kd_cabang, kd_jabat);
                const tipeShift = tipeShiftDari(tipe, borongan, kategoriRotiQ === 'driver', kategoriRotiQ);
               const isShift = pakaiShift(kd_cabang, kd_jabat) && (tipe !== "MINGGU" || kategoriRotiQ !== null);
                const satuPerHari = isShift && kategoriRotiQ !== null && kategoriRotiQ !== 'driver';

                // Minggu hanya Day Shift. Client yang mengirim shift lain tetap dipaksa ke 0.
                const shift = isShift
                    ? resolveShift(tipe, parseInt(req.body.shift, 10), tipeShift, borongan)
                    : SHIFT_DAY;

                const jam = tanggal.slice(11);

                // Validasi lokasi sebelum validasi lain: orang yang di luar jangkauan
                // tidak boleh membakar jatah check-out berulang cuma untuk ditolak.
                const radiusUnit = Number(kary[0].radius_unit) || RADIUS_JANGKAUAN;
                const jangkauan = cekJangkauan(latitude, longitude, kary[0].lat_unit, kary[0].lng_unit, radiusUnit);
                if (!jangkauan.ok) {
                    // Koordinat rusak selalu ditolak. Jarak hanya ditolak kalau
                    // mode-nya sudah block.
                    const mode = modeRadiusAbsen();
                    if (jangkauan.kode !== 'out_of_range' || mode === 'block') {
                        return tolak(jangkauan.pesan, jangkauan.kode);
                    }
                    if (mode === 'log') {
                        console.log(`[radius] ${kar_nik} ${Math.round(jangkauan.jarak)}m > ${radiusUnit}m`);
                    }
                }

                // Jadwal mengikuti unit acuan. Toleransi hanya menandai terlambat.
                const jadwal = syaratJadwalShift(kd_cabang, kdUnitAcuan);
                connection.query(
                    `SELECT kd_cabang,
                            TIME_FORMAT(toleransi_mulai, "%H:%i:%s") toleransi_mulai,
                            TIME_FORMAT(toleransi_selesai, "%H:%i:%s") toleransi_selesai
                    FROM tshift
                    WHERE kd_shift = ${shift} AND tipe_hari = ${mysql.escape(tipeShift)}
                    ${jadwal.where}
                    ORDER BY ${jadwal.order} LIMIT 1`,
                    function (error, shiftRows) {
                        if (error) {
                            console.error(error);
                            return tolak('Terjadi kesalahan saat cek shift', 'error');
                        }

                        if (isShift && unitRotiQ(kd_cabang) && !shiftRows.length) {
                            return tolak('Shift tidak valid untuk unit ini', 'shift_invalid');
                        }
                        if (jadwal.fallback && shiftRows.length
                            && String(shiftRows[0].kd_cabang) !== kdUnitAcuan) {
                            console.log(`[shift] ${kar_nik}: unit ${kdUnitAcuan} memakai jadwal ${shiftRows[0].kd_cabang}`);
                        }
                        const bukaCheckIn = shiftRows.length ? shiftRows[0].toleransi_mulai : null;

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

                       if (
                            status_absen === 1 &&
                            driverRotiQ(kd_cabang, kd_jabat) &&
                            shift === SHIFT_SORE &&
                            bukaCheckIn &&
                            jam < bukaCheckIn
                        ) {
                            return tolak(
                                `Check In sore baru dibuka pukul ${bukaCheckIn.slice(0, 5)}`,
                                'belum_waktunya',
                            );
                        }

                        // Check-in: sesi lama yang belum check-out masih memblokir sampai
                        // batas resetnya (01:00 untuk sesi biasa, 09:00 untuk shift malam).
                        // Sesi yang sudah keluar tidak pernah memblokir.
                        if (status_absen === 1 && isShift) {
                            return sesiPenghalang(kar_nik).then((daftar) => {
                                const sekarang = new Date(tanggal.replace(' ', 'T'));
                                const blocker = daftar.find((s) => sesiMemblockir(s, sekarang));
                                if (!blocker) return lanjut(tanggal.slice(0, 10), false);
                                const batasJam = blocker.malam ? BATAS_RESET_MALAM : BATAS_RESET_BIASA;
                                return tolak(
                                    `Sesi ${blocker.tanggalKerja} belum Check Out. `
                                    + `Check In baru bisa dilakukan setelah pukul ${String(batasJam).padStart(2, '0')}:00`,
                                    'sesi_masih_terbuka'
                                );
                            }, () => tolak('Terjadi kesalahan saat cek sesi', 'error'));
                        }

                        lanjut(tanggal.slice(0, 10), false);

                        function lanjut(kerja, perbaikan) {
                            // Duplikat. Check-in tetap maksimal sekali; check-out boleh berulang
                            // sampai batas MAX_CHECK_OUT (sudah divalidasi di bolehCheckOut).
                            if (status_absen === 1) {
                                connection.query(
                                satuPerHari
                                    ? `SELECT COUNT(*) AS jml FROM tabsensitampung WHERE kar_nik = ? AND tanggal_kerja = ? AND status_absen = ?`
                                    : `SELECT COUNT(*) AS jml FROM tabsensitampung WHERE kar_nik = ? AND tanggal_kerja = ? AND COALESCE(shift,0) = ? AND status_absen = ?`,
                                satuPerHari ? [kar_nik, kerja, status_absen] : [kar_nik, kerja, shift, status_absen],
                                    function (error, rows) {
                                        if (error) {
                                            console.error(error);
                                            return tolak('Terjadi kesalahan saat cek absen', 'error');
                                        }
                                        if (rows[0].jml > 0) {
                                           const pesanDuplikat = isShift && !satuPerHari
                                                ? 'Anda sudah Check In pada shift ini'
                                                : 'Anda sudah Check In hari ini';
                                            return tolak(pesanDuplikat, 'duplicate');
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
                `SELECT k.kar_kd_unit, k.kar_kd_jabat, k.kar_sistem_gaji, p.kd_unit kd_unit_acuan
                 FROM tkaryawan k
                 LEFT JOIN tunit p ON p.kd_unit = ? AND ${rotiq.syaratUnitPilihan('p')}
                 WHERE k.kar_nik = ? LIMIT 1`,
                [req.body.kd_unit || '', kar_nik],
                function (err, kary) {
                    if (err) { connection.release(); return res.status(500).json({ success: false, message: 'Koneksi database gagal', code: 'error' }); }
                    if (!kary.length) {
                        connection.release();
                        return kirim({ data: [], default_shift: SHIFT_DAY, non_shift: true });
                    }

                    // Gate dari data karyawan, jadwal dari unit acuan.
                    const kd_cabang = String(kary[0].kar_kd_unit || '');
                    const kdUnitAcuan = String(kary[0].kd_unit_acuan || kd_cabang);
                    const borongan = String(kary[0].kar_sistem_gaji || '').toLowerCase() === 'borongan';
                    const kd_jabat = String(kary[0].kar_kd_jabat || '');
                    const kategoriRotiQ = rotiq.kategoriShift(kd_cabang, kd_jabat);
                    const tipeShift = tipeShiftDari(tipe, borongan, kategoriRotiQ === 'driver', kategoriRotiQ);

                    if (!pakaiShift(kd_cabang, kd_jabat) || (tipe === 'MINGGU' && !kategoriRotiQ)) {
                        connection.release();
                        return kirim({ data: dayShift, default_shift: SHIFT_DAY, non_shift: true, kd_unit_acuan: kdUnitAcuan });
                    }

                    const jadwal = syaratJadwalShift(kd_cabang, kdUnitAcuan);
                    connection.query(
                        `SELECT kd_cabang, kd_shift, nm_shift,
                            TIME_FORMAT(jam_mulai,"%H:%i") jam_mulai,
                            TIME_FORMAT(jam_selesai,"%H:%i") jam_selesai,
                            TIME_FORMAT(toleransi_mulai,"%H:%i") toleransi_mulai,
                            TIME_FORMAT(toleransi_selesai,"%H:%i") toleransi_selesai
                         FROM tshift
                         WHERE tipe_hari = ${mysql.escape(tipeShift)} ${jadwal.where}
                         ORDER BY ${jadwal.order}`,
                        function (error, results) {
                            connection.release();
                            if (error) return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat cek shift', code: 'error' });
                            const daftar = jadwal.fallback ? saringJadwalShift(results) : results;
                            if (unitRotiQ(kd_cabang)) {
                                const sekarang = waktuJakarta().slice(11, 16);
                                const sudahBuka = daftar
                                    .filter((r) => r.toleransi_mulai && r.toleransi_mulai <= sekarang)
                                    .sort((a, b) => Number(a.kd_shift) - Number(b.kd_shift));
                                const terpilih = sudahBuka.length ? sudahBuka[sudahBuka.length - 1] : daftar[0];
                                return kirim({
                                    data: daftar,
                                    default_shift: terpilih ? terpilih.kd_shift : SHIFT_DAY,
                                    non_shift: false,
                                    kd_unit_acuan: kdUnitAcuan,
                                });
                            }
                            kirim({
                                data: [...dayShift, ...daftar],
                                default_shift: detectShift(tipeShift, undefined, borongan),
                                non_shift: false,
                                kd_unit_acuan: kdUnitAcuan,
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
        SESI_PENGHALANGI_SQL,
        sesiMemblockir,
        BATAS_RESET_BIASA,
        BATAS_RESET_MALAM,
        sesiTerakhirDari,
        bolehCheckOut,
        jarakMeter,
        cekJangkauan,
        RADIUS_JANGKAUAN,
        cekTerlambat,
        resolveShift,
        detectShift,
        tipeShiftDari,
        TOLERANSI_DAY,
        MAX_CHECK_OUT,
        MAKS_JAM_CHECK_OUT,
        sesiAktif,
        SQL_HISTORY_7_HARI,
        syaratJadwalShift,
        saringJadwalShift,
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
                    let isShiftUser = pakaiShift(kd_unit, rows[0].kar_kd_jabat);

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
        // Sesi tanpa check-out memblokir Check In baru hanya sampai batas resetnya
        // (01:00 sesi biasa, 09:00 shift malam) - dipakai oleh sesiAktif di bawah.
        const now = new Date(
            jakartaDate.getFullYear(), jakartaDate.getMonth(), jakartaDate.getDate(),
            jakartaDate.getHours(), jakartaDate.getMinutes(), jakartaDate.getSeconds()
        );

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
                    let isShiftUser = pakaiShift(kd_unit, rows[0].kar_kd_jabat);

                    if (isShiftUser) {
                        // Cabang 20: sesi 7 hari terakhir per (tanggal_kerja, shift).
                        // open_shift = sesi yang belum keluar dan masih dalam batas resetnya,
                        // jadi tidak bisa mengunci Check In selamanya.
                        // sesi_tampil = work date yang boleh muncul di kartu, client
                        // tidak perlu tahu aturan 01:00/09:00.
                        connection.query(
                            SQL_HISTORY_7_HARI,
                            [kar_nama],
                            function (error, results) {
                                if (error) throw error;
                                connection.release();

                                const aktif = sesiAktif(results, today, now);

                                res.send({
                                    success: true,
                                    message: 'Berhasil ambil data hari ini!',
                                    kd_unit: kd_unit,
                                    today: today,
                                    workDate: aktif.open ? aktif.open.Tanggal : today,
                                    current_hour: currentHour,
                                    shift: aktif.open ? Number(aktif.open.shift) : null,
                                    open_shift: aktif.openShift,
                                    open_work_date: aktif.openWorkDate,
                                    check_out_shift: aktif.checkOutShift,
                                    sesi_tampil: aktif.sesiTampil,
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
                                    today: today,
                                    workDate: today,
                                    current_hour: currentHour,
                                    open_shift: terbuka.map((r) => Number(r.shift ?? 0)),
                                    open_work_date: terbuka.map(() => today),
                                    check_out_shift: denganMasuk.map((r) => Number(r.shift ?? 0)),
                                    // Sama seperti cabang 20: client hanya menampilkan sesi yang
                                    // ada di daftar ini. Tanpa field ini, kartu di web dan
                                    // Flutter kosong untuk semua cabang selain 20.
                                    sesi_tampil: denganMasuk.map((r) => r.Tanggal),
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