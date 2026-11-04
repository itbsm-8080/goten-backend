// Siapa yang boleh memilih lokasi absen di luar unit asalnya.
//
// Dipakai controller-izin (daftar unit untuk picker) dan controller-absen
// (titik acuan validasi jarak). Daftarnya sengaja di satu tempat supaya kedua
// controller tidak berbeda diam-diam.

const UNIT_ROTIQ = ['19', '22', '23', '24', '25', '27', '28'];
const JABATAN_ROTIQ = ['45', '57', '47'];

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
            AND ${alias}.nm_unit LIKE '${NM_UNIT_ROTIQ}')
    )`;
}

module.exports = {
    UNIT_ROTIQ,
    JABATAN_ROTIQ,
    UNIT_AKUNTING,
    JABATAN_AKUNTING,
    NM_UNIT2_BSM,
    NM_UNIT_ROTIQ,
    isRotiQMobile,
    isAkunting,
    bisaPilihUnit,
    syaratUnitPilihan,
};
