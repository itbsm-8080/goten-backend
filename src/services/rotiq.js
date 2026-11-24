const mysql = require('mysql');
// Siapa yang boleh memilih lokasi absen di luar unit asalnya.
//
// Dipakai controller-izin (daftar unit untuk picker) dan controller-absen
// (titik acuan validasi jarak). Daftarnya sengaja di satu tempat supaya kedua
// controller tidak berbeda diam-diam.

// yang dibawah ini memakai shift untuk unit RotiQ
//kasir = penjaga toko, kasir, kru toko = 22, 47, 45 = dua shift 06.00 - 14.00, 13.00 - 21.00
//pengiriman = pengiriman = 21 = dua shift 07.00 - 12.00, 16.00 - 19.00, dua kali absen

const UNIT_ROTIQ = ['19', '22', '23', '24', '25', '27', '28'];
const JABATAN_KASIR = ['22', '47', '45'];
const JABATAN_PRODUKSI = ['43', '46', '48'];
const JABATAN_DRIVER = '21';
const JABATAN_ROTIQ = [JABATAN_DRIVER, ...JABATAN_KASIR, ...JABATAN_PRODUKSI];
const UNIT_ROTIQ_SQL = UNIT_ROTIQ.map((u) => `'${u}'`).join(',');
const JABATAN_KASIR_SQL = JABATAN_KASIR.map((j) => `'${j}'`).join(',');

function kategoriShift(kdUnit, kdJabat) {
    if (!UNIT_ROTIQ.includes(String(kdUnit))) return null;
    const jabat = String(kdJabat);
    if (jabat === JABATAN_DRIVER) return 'driver';
    if (JABATAN_KASIR.includes(jabat)) return 'kasir';
    return null;
}

function isShiftRotiQ(kdUnit, kdJabat) {
    return kategoriShift(kdUnit, kdJabat) !== null;
}

function tipeJadwalSql(tgl, k) {
    return `CASE
        WHEN ${k}.kar_kd_unit IN (${UNIT_ROTIQ_SQL}) AND ${k}.kar_kd_jabat = '${JABATAN_DRIVER}'
            THEN 'HARI_DRIVER'
        WHEN ${k}.kar_kd_unit IN (${UNIT_ROTIQ_SQL}) AND ${k}.kar_kd_jabat IN (${JABATAN_KASIR_SQL})
            THEN 'HARI'
        WHEN DAYOFWEEK(${tgl}) = 1 THEN 'MINGGU'
        WHEN DAYOFWEEK(${tgl}) = 7
            THEN IF(LOWER(COALESCE(${k}.kar_sistem_gaji, '')) = 'borongan', 'SABTU_BORONGAN', 'SABTU')
        ELSE 'HARI'
    END`;
}

// Akunting pusat: boleh absen di cabang BSM mana pun.
const UNIT_AKUNTING = '18';
const JABATAN_AKUNTING = '72';

// Penanda cabang BSM di tunit.nm_unit2.
const NM_UNIT2_BSM = 'PT BUMI SARANA MAJU';

// Penanda unit RotiQ di tunit.nm_unit.
const NM_UNIT_ROTIQ = '%RotiQ%';

function isRotiQMobile(kdUnit, kdJabat) {
    return UNIT_ROTIQ.includes(String(kdUnit)) && JABATAN_ROTIQ.includes(String(kdJabat));
}

function isAkunting(kdUnit, kdJabat) {
    return String(kdUnit) === UNIT_AKUNTING && String(kdJabat) === JABATAN_AKUNTING;
}

function bisaPilihUnit(kdUnit, kdJabat) {
    return isRotiQMobile(kdUnit, kdJabat) || isAkunting(kdUnit, kdJabat);
}

// Syarat join unit pilihan (alias p) untuk karyawan (alias k).
//
// Ditulis sebagai fragmen ON, bukan WHERE, supaya kd_unit dari client hanya
// menggeser titik acuan kalau karyawannya memang berhak atas unit itu.
// Unit di luar haknya tidak cocok, join jadi NULL, dan titik acuan kembali ke
// unit asal.
function syaratUnitPilihan(alias = 'p') {
    return `(
        (k.kar_kd_unit = '${UNIT_AKUNTING}' AND k.kar_kd_jabat = '${JABATAN_AKUNTING}'
            AND ${alias}.nm_unit2 = '${NM_UNIT2_BSM}')
        OR (k.kar_kd_unit IN (${UNIT_ROTIQ.map((u) => `'${u}'`).join(',')})
            AND k.kar_kd_jabat IN (${JABATAN_ROTIQ.map((j) => `'${j}'`).join(',')})
            AND ${alias}.nm_unit LIKE '${NM_UNIT_ROTIQ}')${klausaSemuaUnit(alias)}
    )`;
}

const NIK_SEMUA_UNIT = (process.env.ABSEN_SEMUA_UNIT_NIK || '18122024001')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

function bisaSemuaUnit(nik) {
    const bersih = String(nik || '').trim();
    return bersih !== '' && NIK_SEMUA_UNIT.includes(bersih);
}

function syaratKoordinat(alias = '') {
    const p = alias ? `${alias}.` : '';
    return `${p}latitude IS NOT NULL AND ${p}latitude <> '' AND ${p}longitude IS NOT NULL AND ${p}longitude <> ''`;
}

function klausaSemuaUnit(alias) {
    if (NIK_SEMUA_UNIT.length === 0) return '';
    const daftar = NIK_SEMUA_UNIT.map((n) => mysql.escape(n)).join(',');
    return `
        OR (k.kar_nik IN (${daftar})
            AND ${syaratKoordinat(alias)})`;
}

module.exports = {
    UNIT_ROTIQ,
    UNIT_ROTIQ_SQL,
    JABATAN_ROTIQ,
    JABATAN_KASIR,
    JABATAN_DRIVER,
    JABATAN_PRODUKSI,
    kategoriShift,
    isShiftRotiQ,
    tipeJadwalSql,
    UNIT_AKUNTING,
    JABATAN_AKUNTING,
    NM_UNIT2_BSM,
    NM_UNIT_ROTIQ,
    isRotiQMobile,
    isAkunting,
    bisaPilihUnit,
    syaratUnitPilihan,
    bisaSemuaUnit,
    syaratKoordinat,
    klausaSemuaUnit
};