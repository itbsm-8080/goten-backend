const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

const NOMERATOR = 'POD';

// Cari nama database cabang + nama karyawan dari NIK
// kar_nik -> tkaryawan.kar_kd_unit -> tunit.kd_unit -> tunit.dbase
function getDbase(kar_nik, callback) {
    if (!kar_nik) {
        callback(null, 'kar_nik diperlukan');
        return;
    }

    pool.getConnection(function (err, connection) {
        if (err) {
            callback(null, 'Database error');
            return;
        }
        connection.query(
            `SELECT u.dbase, k.kar_nama, k.kar_namasingkat FROM tkaryawan k INNER JOIN tunit u ON k.kar_kd_unit = u.kd_unit WHERE k.kar_nik = ?`,
            [kar_nik],
            function (error, results) {
                connection.release();
                if (error) {
                    callback(null, 'Query error');
                    return;
                }
                if (!results.length || !results[0].dbase) {
                    callback(null, 'Cabang/unit tidak ditemukan');
                    return;
                }
                callback({ dbase: results[0].dbase, kar_nama: results[0].kar_nama || '', kar_namasingkat: results[0].kar_namasingkat || '' }, null);
            }
        );
    });
}

// Amankan nama database dari SQL injection
function sanitizeDbase(dbase) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(dbase)) return null;
    return dbase;
}

// Ambil kode cabang dari database cabang (tcabang)
function getCbgKode(dbase, callback) {
    pool.getConnection(function (err, connection) {
        if (err) {
            callback(null, 'Database error');
            return;
        }
        connection.query(
            `SELECT cbg_kode FROM \`${dbase}\`.tcabang WHERE cbg_aktif = 1 LIMIT 1`,
            function (error, results) {
                connection.release();
                if (error) {
                    callback(null, 'Query error');
                    return;
                }
                if (!results.length || !results[0].cbg_kode) {
                    callback(null, 'Kode cabang tidak ditemukan');
                    return;
                }
                callback(results[0].cbg_kode, null);
            }
        );
    });
}

// Generate nomor POD: {cbg_kode}-POD.{yymm}.{0001}
function getNextPodNomor(dbase, cbgKode, tanggal, callback) {
    const parts = (tanggal || '').split('-');
    const yy = parts.length > 0 && parts[0] ? String(parts[0]).substring(2) : '';
    const mm = parts.length > 1 ? parts[1] : '';
    const prefix = `${cbgKode}-${NOMERATOR}.${yy}${mm}.`;

    pool.getConnection(function (err, connection) {
        if (err) {
            callback(null);
            return;
        }
        connection.query(
            `SELECT MAX(RIGHT(pod_nomor, 4)) AS max_no FROM \`${dbase}\`.tpod_hdr WHERE pod_nomor LIKE ?`,
            [prefix + '%'],
            function (error, results) {
                connection.release();
                if (error) {
                    callback(null);
                    return;
                }

                const maxNo = results[0]?.max_no;
                let nextNo;
                if (!maxNo) {
                    nextNo = prefix + '0001';
                } else {
                    nextNo = prefix + String(parseInt(maxNo) + 1).padStart(4, '0');
                }
                callback(nextNo);
            }
        );
    });
}

module.exports = {
    // Get list Proof of Delivery (filter periode)
    getPOD(req, res) {
        let { kar_nik, start_date, end_date } = req.body;

        getDbase(kar_nik, (info, errorMsg) => {
            if (errorMsg) {
                res.send({ success: false, message: errorMsg });
                return;
            }

            const dbase = sanitizeDbase(info.dbase);
            if (!dbase) {
                res.send({ success: false, message: 'Nama database tidak valid' });
                return;
            }

            let sql = `SELECT a.*, DATE_FORMAT(a.pod_tanggal, '%Y-%m-%d') AS pod_tanggal, c.Cus_nama, c.Cus_alamat 
                       FROM \`${dbase}\`.tpod_hdr a
                       LEFT JOIN \`${dbase}\`.tcustomer c ON a.pod_cus_kode = c.Cus_kode
                       WHERE 1 = 1`;
            let params = [];

            if (start_date) {
                sql += ` AND a.pod_tanggal >= ?`;
                params.push(start_date);
            }
            if (end_date) {
                sql += ` AND a.pod_tanggal <= ?`;
                params.push(end_date + ' 23:59:59');
            }

            sql += ` ORDER BY a.pod_tanggal DESC, a.pod_nomor DESC`;

            pool.getConnection(function (err, connection) {
                if (err) throw err;
                connection.query(sql, params, function (error, results) {
                    if (error) throw error;
                    res.send({ success: true, message: 'Berhasil!', data: results });
                });
                connection.release();
            });
        });
    },

    // Cari DO yang belum dibuatkan POD (belum ada di tpod_hdr)
    cariDO(req, res) {
        let { kar_nik, start_date, keyword } = req.body;
        const minTanggal = '2026-08-10';

        getDbase(kar_nik, (info, errorMsg) => {
            if (errorMsg) {
                res.send({ success: false, message: errorMsg });
                return;
            }

            const dbase = sanitizeDbase(info.dbase);
            if (!dbase) {
                res.send({ success: false, message: 'Nama database tidak valid' });
                return;
            }

            let sql = `SELECT a.do_nomor Nomor, fp.FP_nomor Faktur, DATE_FORMAT(a.do_tanggal, '%Y-%m-%d') Tanggal, Cus_nama Customer, Cus_alamat Alamat, Cus_kode, a.do_driver
                       FROM \`${dbase}\`.tdo_hdr a
                       INNER JOIN \`${dbase}\`.tcustomer ON a.do_cus_Kode = Cus_kode
                       LEFT JOIN \`${dbase}\`.tfp_hdr fp ON a.do_nomor = fp.FP_DO_nomor
                       WHERE NOT EXISTS (
                            SELECT 1
                            FROM \`${dbase}\`.tpod_hdr b
                            WHERE b.pod_do_nomor = a.do_nomor
                        )
                        AND NOT EXISTS(
                            SELECT 1
                            FROM \`${dbase}\`.tfp_hdr f
                            INNER JOIN \`${dbase}\`.tretj_hdr t ON t.retj_fp_nomor = f.FP_nomor
                            WHERE f.FP_DO_nomor = a.do_nomor
                        )
                       AND a.do_tanggal >= ?
                       AND a.do_tanggal >= '2026-08-10'
                        AND COALESCE(a.do_driver, '') NOT IN (
                            'EKSPEDISI',
                            'SALES',
                            (SELECT kar_namasingkat FROM hrd.tkaryawan WHERE kar_nik = ?)
                        ) `;
            let params = [minTanggal, kar_nik];

            if (keyword && keyword.trim() !== '') {
                sql += ` AND (a.do_nomor LIKE ? OR Cus_nama LIKE ? OR fp.FP_nomor LIKE ?)`;
                const like = `%${keyword.trim()}%`;
                params.push(like, like, like);
            }

            sql += ` ORDER BY a.do_tanggal DESC, a.do_nomor DESC`;

            pool.getConnection(function (err, connection) {
                if (err) throw err;
                connection.query(sql, params, function (error, results) {
                    if (error) throw error;
                    res.send({ success: true, message: 'Berhasil!', data: results });
                });
                connection.release();
            });
        });
    },

    // Daftar DO yang belum dibuatkan POD/FP (filter "Belum")
    getListBelum(req, res) {
        let { kar_nik } = req.body;
        const minTanggal = '2026-08-10';

        if (!kar_nik) {
            res.send({ success: false, message: 'kar_nik diperlukan' });
            return;
        }

        getDbase(kar_nik, (info, errorMsg) => {
            if (errorMsg) {
                res.send({ success: false, message: errorMsg });
                return;
            }

            const dbase = sanitizeDbase(info.dbase);
            if (!dbase) {
                res.send({ success: false, message: 'Nama database tidak valid' });
                return;
            }

            let sql = `SELECT a.do_nomor, fp.FP_nomor faktur, DATE_FORMAT(a.do_tanggal, '%Y-%m-%d') AS do_tanggal, a.do_cus_Kode, a.do_driver, c.Cus_nama, c.Cus_alamat
                       FROM \`${dbase}\`.tdo_hdr a
                       INNER JOIN tkaryawan k ON k.kar_namasingkat = a.do_driver
                       LEFT JOIN \`${dbase}\`.tcustomer c ON a.do_cus_Kode = c.Cus_kode
                       LEFT JOIN \`${dbase}\`.tfp_hdr fp ON a.do_nomor = fp.FP_DO_nomor
                       WHERE NOT EXISTS (
                            SELECT 1
                            FROM \`${dbase}\`.tpod_hdr b
                            WHERE b.pod_do_nomor = a.do_nomor
                        )
                        AND NOT EXISTS (
                            SELECT 1
                            FROM \`${dbase}\`.tfp_hdr f
                            INNER JOIN \`${dbase}\`.tretj_hdr t ON t.retj_fp_nomor = f.FP_nomor
                            WHERE f.FP_DO_nomor = a.do_nomor
                        )
                        AND a.do_tanggal >= ?
                        AND k.kar_nik = ?
                       ORDER BY a.do_tanggal DESC, a.do_nomor DESC`;

            pool.getConnection(function (err, connection) {
                if (err) throw err;
                connection.query(sql, [minTanggal, kar_nik], function (error, results) {
                    if (error) throw error;
                    res.send({ success: true, message: 'Berhasil!', data: results });
                });
                connection.release();
            });
        });
    },

    // Tambah POD (nomor di-generate otomatis)
    tambahPOD(req, res) {
        let { kar_nik, pod_do_nomor, pod_tanggal, pod_foto, pod_cus_kode } = req.body;

        if (!pod_do_nomor || !pod_tanggal || !pod_foto || !pod_cus_kode) {
            res.send({ success: false, message: 'DO, tanggal, foto, dan customer wajib diisi' });
            return;
        }

        getDbase(kar_nik, (info, errorMsg) => {
            if (errorMsg) {
                res.send({ success: false, message: errorMsg });
                return;
            }

            const dbase = sanitizeDbase(info.dbase);
            if (!dbase) {
                res.send({ success: false, message: 'Nama database tidak valid' });
                return;
            }

            getCbgKode(dbase, (cbgKode, cbgError) => {
                if (cbgError) {
                    res.send({ success: false, message: cbgError });
                    return;
                }

                getNextPodNomor(dbase, cbgKode, pod_tanggal, (podNomor) => {
                    if (!podNomor) {
                        res.send({ success: false, message: 'Gagal generate nomor POD' });
                        return;
                    }

                    // Cek apakah DO sudah pernah dibuatkan POD (duplikat)
                    pool.getConnection(function (err, connection) {
                        if (err) throw err;
                        connection.query(
                            `SELECT pod_do_nomor FROM \`${dbase}\`.tpod_hdr WHERE pod_do_nomor = ?`,
                            [pod_do_nomor],
                            function (error, rows) {
                                if (error) throw error;
                                if (rows.length > 0) {
                                    connection.release();
                                    res.send({ success: false, message: 'DO sudah pernah dibuatkan POD' });
                                    return;
                                }

                                connection.query(
                                    `INSERT INTO \`${dbase}\`.tpod_hdr 
                                     (pod_nomor, pod_do_nomor, pod_tanggal, pod_foto, pod_cus_kode, date_create, user_create) 
                                     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
                                    [podNomor, pod_do_nomor, pod_tanggal, pod_foto, pod_cus_kode, info.kar_namasingkat],
                                    function (err2, results) {
                                        if (err2) throw err2;
                                        connection.query(
                                            `UPDATE \`${dbase}\`.tdo_hdr SET do_driver = ? WHERE do_nomor = ?`,
                                            [info.kar_namasingkat, pod_do_nomor],
                                            function (err3, updResults) {
                                                connection.release();
                                                if (err3) throw err3;
                                                res.send({ success: true, message: 'POD disimpan!', pod_nomor: podNomor });
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    });
                });
            });
        });
    },

    // Edit POD (hanya di hari yang sama)
    editPOD(req, res) {
        let { kar_nik, pod_nomor, pod_tanggal, pod_foto } = req.body;

        if (!pod_nomor || !pod_tanggal) {
            res.send({ success: false, message: 'pod_nomor dan tanggal wajib diisi' });
            return;
        }

        getDbase(kar_nik, (info, errorMsg) => {
            if (errorMsg) {
                res.send({ success: false, message: errorMsg });
                return;
            }

            const dbase = sanitizeDbase(info.dbase);
            if (!dbase) {
                res.send({ success: false, message: 'Nama database tidak valid' });
                return;
            }

            pool.getConnection(function (err, connection) {
                if (err) throw err;
                connection.query(
                    `UPDATE \`${dbase}\`.tpod_hdr 
                     SET pod_tanggal = ?, pod_foto = ?, date_modified = NOW(), user_modified = ?
                     WHERE pod_nomor = ? AND DATE(pod_tanggal) = CURDATE()`,
                    [pod_tanggal, pod_foto || null, info.kar_namasingkat, pod_nomor],
                    function (error, results) {
                        if (error) throw error;
                        if (results.affectedRows === 0) {
                            res.send({ success: false, message: 'Data hanya bisa diedit di hari yang sama' });
                        } else {
                            res.send({ success: true, message: 'POD diperbarui!' });
                        }
                    }
                );
                connection.release();
            });
        });
    },

    // Hapus POD (hanya di hari yang sama)
    hapusPOD(req, res) {
        let { kar_nik, pod_nomor } = req.body;

        if (!pod_nomor) {
            res.send({ success: false, message: 'pod_nomor diperlukan' });
            return;
        }

        getDbase(kar_nik, (info, errorMsg) => {
            if (errorMsg) {
                res.send({ success: false, message: errorMsg });
                return;
            }

            const dbase = sanitizeDbase(info.dbase);
            if (!dbase) {
                res.send({ success: false, message: 'Nama database tidak valid' });
                return;
            }

            pool.getConnection(function (err, connection) {
                if (err) throw err;
                connection.query(
                    `DELETE FROM \`${dbase}\`.tpod_hdr WHERE pod_nomor = ? AND DATE(pod_tanggal) = CURDATE()`,
                    [pod_nomor],
                    function (error, results) {
                        if (error) throw error;
                        if (results.affectedRows === 0) {
                            res.send({ success: false, message: 'Data hanya bisa dihapus di hari yang sama' });
                        } else {
                            res.send({ success: true, message: 'POD dihapus!' });
                        }
                    }
                );
                connection.release();
            });
        });
    },
};
