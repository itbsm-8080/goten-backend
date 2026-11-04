// Approver sebuah unit dibaca dari tunit.ut_kar_nik. Satu unit boleh memuat
// beberapa NIK dipisah koma, jadi spasi dibuang dulu sebelum FIND_IN_SET.
const SQL_UNIT_APPROVER = `
    SELECT kd_unit, nm_unit
    FROM tunit
    WHERE FIND_IN_SET(?, REPLACE(ut_kar_nik, ' ', ''))
    ORDER BY CAST(kd_unit AS UNSIGNED)`;

function unitApprover(connection, kar_nik, callback) {
    const nik = String(kar_nik ?? '').trim();
    if (!nik) {
        callback(null, []);
        return;
    }
    connection.query(SQL_UNIT_APPROVER, [nik], function (error, rows) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, rows);
    });
}

function daftarPlaceholder(jumlah) {
    return new Array(jumlah).fill('?').join(',');
}

module.exports = {
    unitApprover,
    daftarPlaceholder,
};
