const config = require('../configs/database');
const mysql = require('mysql');
const { unitApprover, daftarPlaceholder } = require('../services/approval_unit');

const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

// Status lembur di tlemburtampung bisa kosong. PENDING = belum ACCEPT dan belum REJECT.
const FILTER_STATUS_LEMBUR = {
    PENDING: `(lem_status IS NULL OR UPPER(TRIM(lem_status)) NOT IN ('ACCEPT', 'REJECT'))`,
    ACCEPT: `UPPER(TRIM(lem_status)) = 'ACCEPT'`,
    REJECT: `UPPER(TRIM(lem_status)) = 'REJECT'`,
};

function filterStatusLembur(status) {
    if (!status || status === 'ALL') return null;
    return FILTER_STATUS_LEMBUR[status] || FILTER_STATUS_LEMBUR.PENDING;
}

// PENDING berarti belum ACCEPT dan belum REJECT, termasuk status kosong.
const FILTER_STATUS_IZIN = {
    PENDING: `(ij_status IS NULL OR UPPER(TRIM(ij_status)) NOT IN ('ACCEPT', 'REJECT'))`,
    ACCEPT: `UPPER(TRIM(ij_status)) = 'ACCEPT'`,
    REJECT: `UPPER(TRIM(ij_status)) = 'REJECT'`,
};

function filterStatusIzin(status) {
    if (!status || status === 'ALL') return null;
    return FILTER_STATUS_IZIN[status] || FILTER_STATUS_IZIN.PENDING;
}

module.exports = {
    filterStatusIzin,

    // Role approver: unit yang punya kar_nik ini di tunit.ut_kar_nik.
    // Sekaligus jumlah pengajuan PENDING untuk badge tiap menu.
    cekRole(req, res) {
        const kar_nik = req.body.kar_nik;

        pool.getConnection(function (err, connection) {
            if (err) {
                res.send({ success: false, is_approver: false, message: 'Database error' });
                return;
            }

            unitApprover(connection, kar_nik, function (error, units) {
                if (error || units.length === 0) {
                    connection.release();
                    res.send({ success: true, is_approver: false });
                    return;
                }

                const kdUnits = units.map((u) => String(u.kd_unit));
                const inUnits = daftarPlaceholder(kdUnits.length);

                connection.query(
                    `SELECT COUNT(*) AS jml
                     FROM tijintampung
                     INNER JOIN tkaryawan ON tijintampung.kar_nik = tkaryawan.kar_nik
                     WHERE tkaryawan.kar_kd_unit IN (${inUnits})
                       AND ${FILTER_STATUS_IZIN.PENDING}`,
                    kdUnits,
                    function (errIzin, rowsIzin) {
                        if (errIzin) {
                            connection.release();
                            res.send({ success: false, is_approver: false, message: 'Query error' });
                            return;
                        }

                        connection.query(
                            `SELECT COUNT(*) AS jml
                             FROM tlemburtampung
                             INNER JOIN tkaryawan ON tlemburtampung.lem_kar_nik = tkaryawan.kar_nik
                             WHERE tkaryawan.kar_kd_unit IN (${inUnits})
                               AND ${FILTER_STATUS_LEMBUR.PENDING}`,
                            kdUnits,
                            function (errLembur, rowsLembur) {
                                connection.release();
                                if (errLembur) {
                                    res.send({ success: false, is_approver: false, message: 'Query error' });
                                    return;
                                }
                                res.send({
                                    success: true,
                                    is_approver: true,
                                    kd_units: kdUnits,
                                    units,
                                    pending: {
                                        izin: rowsIzin[0]?.jml ?? 0,
                                        lembur: rowsLembur[0]?.jml ?? 0,
                                    },
                                });
                            }
                        );
                    }
                );
            });
        });
    },

    // Daftar pengajuan lembur untuk unit yang dipegang approver.
    getLemburApproval(req, res) {
        let { kd_units, start_date, end_date, status } = req.body;

        const unitsArray = typeof kd_units === 'string'
            ? kd_units.split(',').map((u) => u.trim()).filter(Boolean)
            : Array.isArray(kd_units)
                ? kd_units.map((u) => String(u).trim()).filter(Boolean)
                : [];

        if (unitsArray.length === 0) {
            res.send({ success: false, message: 'Unit tidak ditemukan' });
            return;
        }

        const inUnits = daftarPlaceholder(unitsArray.length);
        let sql = `SELECT tlemburtampung.*, tkaryawan.kar_nama, tkaryawan.kar_kd_unit, tunit.nm_unit
                   FROM tlemburtampung
                   INNER JOIN tkaryawan ON tlemburtampung.lem_kar_nik = tkaryawan.kar_nik
                   LEFT JOIN tunit ON tkaryawan.kar_kd_unit = tunit.kd_unit
                   WHERE tkaryawan.kar_kd_unit IN (${inUnits})`;
        const params = [...unitsArray];

        if (start_date) {
            sql += ` AND tlemburtampung.lem_tanggal >= ?`;
            params.push(start_date);
        }
        if (end_date) {
            sql += ` AND tlemburtampung.lem_tanggal <= ?`;
            params.push(end_date);
        }

        const filterStatus = filterStatusLembur(status);
        if (filterStatus) {
            sql += ` AND ${filterStatus}`;
        }

        sql += ` ORDER BY tlemburtampung.lem_tanggal DESC, tlemburtampung.lem_jammulai DESC`;

        pool.getConnection(function (err, connection) {
            if (err) {
                res.send({ success: false, message: 'Database error' });
                return;
            }
            connection.query(sql, params, function (error, results) {
                connection.release();
                if (error) {
                    res.send({ success: false, message: 'Query error' });
                    return;
                }
                res.send({ success: true, message: 'Berhasil!', data: results });
            });
        });
    },

    // ACCEPT / REJECT lembur. Hanya mengubah lem_status, tlembur tidak disentuh.
    prosesLembur(req, res) {
        const { lem_nomor, lem_status, kar_nik } = req.body;

        if (lem_status !== 'ACCEPT' && lem_status !== 'REJECT') {
            res.send({ success: false, message: 'Status tidak valid' });
            return;
        }

        pool.getConnection(function (err, connection) {
            if (err) {
                res.send({ success: false, message: 'Database error' });
                return;
            }

            connection.query(
                `SELECT tkaryawan.kar_kd_unit
                 FROM tlemburtampung
                 INNER JOIN tkaryawan ON tlemburtampung.lem_kar_nik = tkaryawan.kar_nik
                 WHERE tlemburtampung.lem_nomor = ?
                 LIMIT 1`,
                [lem_nomor],
                function (errCari, rows) {
                    if (errCari || !rows.length) {
                        connection.release();
                        res.send({ success: false, message: 'Data lembur tidak ditemukan' });
                        return;
                    }

                    const kdUnitPengaju = String(rows[0].kar_kd_unit ?? '');

                    const updateStatus = () => {
                        connection.query(
                            `UPDATE tlemburtampung SET lem_status = ? WHERE lem_nomor = ?`,
                            [lem_status, lem_nomor],
                            function (errUpdate, result) {
                                connection.release();
                                if (errUpdate) {
                                    res.send({ success: false, message: 'Gagal update status' });
                                    return;
                                }
                                if (result.affectedRows === 0) {
                                    res.send({ success: false, message: 'Status tidak berubah' });
                                    return;
                                }
                                res.send({
                                    success: true,
                                    message: lem_status === 'ACCEPT' ? 'Lembur diterima' : 'Lembur ditolak',
                                });
                            }
                        );
                    };

                    // kar_nik approver opsional: build lama yang belum mengirimnya tetap jalan.
                    if (!kar_nik) {
                        updateStatus();
                        return;
                    }

                    unitApprover(connection, kar_nik, function (errUnit, units) {
                        const berwenang = !errUnit
                            && units.some((u) => String(u.kd_unit) === kdUnitPengaju);
                        if (!berwenang) {
                            connection.release();
                            res.send({ success: false, message: 'Anda tidak berwenang menyetujui unit ini' });
                            return;
                        }
                        updateStatus();
                    });
                }
            );
        });
    },
};
