const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

const NOMERATOR = 'TIJ';
const NOMERATOR_TIJ = 'IJN';


function getMaxKode(tanggal, callback) {
    const d = new Date(tanggal);
    const yy = String(d.getFullYear()).substring(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const prefix = `${NOMERATOR}.${yy}${mm}.`;

    pool.getConnection(function (err, connection) {
        if (err) { callback(null); return; }
        connection.query(
            `SELECT MAX(RIGHT(ij_nomor, 4)) AS max_no FROM tijintampung WHERE ij_nomor LIKE ?`,
            [`${prefix}%`],
            function (error, results) {
                connection.release();
                if (error) { callback(null); return; }

                let maxNo = results[0]?.max_no;
                let nextNo;
                if (!maxNo) {
                    nextNo = `${prefix}0001`;
                } else {
                    nextNo = `${prefix}${String(parseInt(maxNo) + 1).padStart(4, '0')}`;
                }
                callback(nextNo);
            }
        );
    });
}

function getMaxKodeTijin(tanggal, callback) {
    const d = new Date(tanggal);
    const yy = String(d.getFullYear()).substring(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const prefix = `${NOMERATOR_TIJ}.${yy}${mm}.`;

    pool.getConnection(function (err, connection) {
        if (err) { callback(null); return; }
        connection.query(
            `SELECT MAX(RIGHT(ij_nomor, 4)) AS max_no FROM tijin WHERE ij_nomor LIKE ?`,
            [`${prefix}%`],
            function (error, results) {
                connection.release();
                if (error) { callback(null); return; }

                let maxNo = results[0]?.max_no;
                let nextNo;
                if (!maxNo) {
                    nextNo = `${prefix}0001`;
                } else {
                    nextNo = `${prefix}${String(parseInt(maxNo) + 1).padStart(4, '0')}`;
                }
                callback(nextNo);
            }
        );
    });
}

module.exports = {
    // Get list izin
    getIzinKaryawan(req, res) {
        let { kar_nik, start_date, end_date, status } = req.body;

        let sql = `SELECT * FROM tijintampung WHERE kar_nik = ?`;
        let params = [kar_nik];

        if (start_date) {
            sql += ` AND tanggal >= ?`;
            params.push(start_date);
        }
        if (end_date) {
            sql += ` AND tanggal <= ?`;
            params.push(end_date + ' 23:59:59');
        }
        if (status && status !== 'ALL') {
            sql += ` AND ij_status = ?`;
            params.push(status);
        }

        sql += ` ORDER BY tanggal DESC`;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(sql, params, function (error, results) {
                if (error) throw error;
                res.send({ success: true, message: 'Berhasil!', data: results });
            });
            connection.release();
        });
    },

    // Tambah izin (dengan penomoran)
    tambahIzin(req, res) {
        let { kar_nik, tanggal, alasan, keterangan, ij_foto } = req.body;

        getMaxKode(tanggal, (ij_nomor) => {
            if (!ij_nomor) {
                res.send({ success: false, message: 'Gagal generate nomor' });
                return;
            }

            pool.getConnection(function (err, connection) {
                if (err) throw err;
                connection.query(
                    `INSERT INTO tijintampung (ij_nomor, kar_nik, tanggal, alasan, keterangan, ij_foto, ij_status) 
                     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
                    [ij_nomor, kar_nik, tanggal, alasan, keterangan, ij_foto || null],
                    function (error, results) {
                        if (error) throw error;
                        res.send({ success: true, message: 'Izin diajukan!', ij_nomor: ij_nomor });
                    }
                );
                connection.release();
            });

            const https = require('https');

            function sendNotificationToApprovers(kd_unit, nama_karyawan, alasan) {
                // Cari approver di unit yang sama
                pool.getConnection(function (err, connection) {
                    if (err) return;
                    connection.query(
                        `SELECT tkaryawan.kar_nama FROM tuser 
             INNER JOIN tkaryawan ON tuser.kar_nik = tkaryawan.kar_nik 
             WHERE tuser.kd_unit = ?`,
                        [kd_unit],
                        function (error, approvers) {
                            connection.release();
                            if (error || !approvers.length) return;

                            // Kirim notifikasi OneSignal
                            // (Requires OneSignal App ID & API Key)
                            const onesignalData = JSON.stringify({
                                app_id: "e82ad139-8162-46bd-989f-82f42dfb474e",
                                headings: { en: "Izin Baru" },
                                contents: { en: `${nama_karyawan} mengajukan ${alasan}` },
                                included_segments: ["Active Users"],
                                // Kalau mau spesifik: include_player_ids: [playerId]
                            });

                            const options = {
                                hostname: 'onesignal.com',
                                path: '/api/v1/notifications',
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': 'Basic YOUR_REST_API_KEY'
                                }
                            };

                            const req = https.request(options, (res) => { });
                            req.write(onesignalData);
                            req.end();
                        }
                    );
                });
            }
        });
    },

    // Edit izin (hanya PENDING)
    editIzin(req, res) {
        let { ij_nomor, tanggal, alasan, keterangan, ij_foto } = req.body;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `UPDATE tijintampung SET tanggal = ?, alasan = ?, keterangan = ?, ij_foto = ? 
                 WHERE ij_nomor = ? AND ij_status = 'PENDING'`,
                [tanggal, alasan, keterangan, ij_foto || null, ij_nomor],
                function (error, results) {
                    if (error) throw error;
                    if (results.affectedRows === 0) {
                        res.send({ success: false, message: 'Hanya izin PENDING yang bisa diedit' });
                    } else {
                        res.send({ success: true, message: 'Izin diperbarui!' });
                    }
                }
            );
            connection.release();
        });
    },

    // Hapus izin (hanya PENDING)
    hapusIzin(req, res) {
        let { ij_nomor } = req.body;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `DELETE FROM tijintampung WHERE ij_nomor = ? AND ij_status = 'PENDING'`,
                [ij_nomor],
                function (error, results) {
                    if (error) throw error;
                    if (results.affectedRows === 0) {
                        res.send({ success: false, message: 'Hanya izin PENDING yang bisa dihapus' });
                    } else {
                        res.send({ success: true, message: 'Izin dihapus!' });
                    }
                }
            );
            connection.release();
        });
    },

    // Cek apakah karyawan punya role approval
    cekRoleApproval(req, res) {
        let { kar_nik } = req.body;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `SELECT kd_unit FROM tuser WHERE kar_nik = ?`,
                [kar_nik],
                function (error, results) {
                    connection.release();
                    if (error) {
                        res.send({ success: false, is_approver: false });
                    } else if (results.length > 0) {
                        // Kumpulkan semua kd_unit
                        const kdUnits = results.map(r => r.kd_unit.toString());
                        res.send({
                            success: true,
                            is_approver: true,
                            kd_units: kdUnits  // array, bukan string tunggal
                        });
                    } else {
                        res.send({ success: true, is_approver: false });
                    }
                }
            );
        });
    },

    // Get list izin untuk approval (berdasarkan kd_unit)
    getIzinApproval(req, res) {
        let { kd_units, start_date, end_date, status } = req.body;

        // kd_units bisa string "17,19,8" atau array ["17","19","8"]
        let unitsArray;
        if (typeof kd_units === 'string') {
            unitsArray = kd_units.split(',').map(u => u.trim());
        } else {
            unitsArray = kd_units;
        }

        if (!unitsArray || unitsArray.length === 0) {
            res.send({ success: false, message: 'Unit tidak ditemukan' });
            return;
        }

        console.log("Sini" + unitsArray);

        // Buat placeholder ? sebanyak unit
        const placeholders = unitsArray.map(() => '?').join(',');

        let sql = `SELECT tijintampung.*, tkaryawan.kar_nama, tkaryawan.kar_kd_unit, tunit.nm_unit 
               FROM tijintampung 
               INNER JOIN tkaryawan ON tijintampung.kar_nik = tkaryawan.kar_nik 
               LEFT JOIN tunit ON tkaryawan.kar_kd_unit = tunit.kd_unit 
               WHERE tkaryawan.kar_kd_unit IN (${placeholders})`;
        let params = [...unitsArray];

        if (start_date) {
            sql += ` AND date(tijintampung.tanggal) >= ?`;
            params.push(start_date);
        }
        if (end_date) {
            sql += ` AND date(tijintampung.tanggal) <= ?`;
            params.push(end_date);
        }
        if (status && status !== 'ALL') {
            sql += ` AND tijintampung.ij_status = ?`;
            params.push(status);
        }

        sql += ` ORDER BY tijintampung.tanggal DESC`;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(sql, params, function (error, results) {
                if (error) throw error;
                res.send({ success: true, message: 'Berhasil!', data: results });
            });
            connection.release();
        });
    },

    // ACCEPT / REJECT izin
    prosesIzin(req, res) {
        let { ij_nomor, ij_status } = req.body;

        if (ij_status !== 'ACCEPT' && ij_status !== 'REJECT') {
            res.send({ success: false, message: 'Status tidak valid' });
            return;
        }

        pool.getConnection(function (err, connection) {
            if (err) throw err;

            // Update status di tijintampung
            connection.query(
                `UPDATE tijintampung SET ij_status = ? WHERE ij_nomor = ?`,
                [ij_status, ij_nomor],
                function (error, results) {
                    if (error) {
                        connection.release();
                        res.send({ success: false, message: 'Gagal update status' });
                        return;
                    }

                    if (results.affectedRows === 0) {
                        connection.release();
                        res.send({ success: false, message: 'Data tidak ditemukan' });
                        return;
                    }

                    // Jika ACCEPT, insert ke tijin
                    if (ij_status === 'ACCEPT') {
                        // Ambil data dari tijintampung
                        connection.query(
                            `SELECT * FROM tijintampung WHERE ij_nomor = ?`,
                            [ij_nomor],
                            function (err2, rows) {
                                if (err2 || !rows.length) {
                                    connection.release();
                                    res.send({ success: true, message: 'Status diupdate (gagal insert ke tijin)' });
                                    return;
                                }

                                const data = rows[0];

                                // Generate nomor baru untuk tijin
                                getMaxKodeTijin(data.tanggal, (newNomor) => {
                                    if (!newNomor) {
                                        connection.release();
                                        res.send({ success: true, message: 'Status diupdate (gagal generate nomor)' });
                                        return;
                                    }

                                    // Insert ke tijin
                                    connection.query(
                                        `INSERT INTO tijin (ij_nomor, kar_nik, tanggal, alasan, keterangan, ij_foto, ij_shift) 
                                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                        [
                                            newNomor,
                                            data.kar_nik,
                                            data.tanggal,
                                            data.alasan,
                                            data.keterangan,
                                            data.ij_foto || null,
                                            data.ij_shift || 0
                                        ],
                                        function (err3, insertResult) {
                                            connection.release();
                                            if (err3) {
                                                console.error('Insert tijin error:', err3);
                                                res.send({ success: true, message: 'Status diupdate (gagal insert ke tijin)' });
                                            } else {
                                                res.send({
                                                    success: true,
                                                    message: 'Izin diterima & tersimpan di tijin',
                                                    ij_nomor_tijin: newNomor
                                                });
                                            }
                                        }
                                    );
                                });
                            }
                        );
                    } else {
                        // REJECT — cuma update status
                        connection.release();
                        res.send({ success: true, message: 'Izin ditolak' });
                    }
                }
            );
        });
    },

    getSisaCuti(req, res) {
        let { kar_nik } = req.body;

        if (!kar_nik) {
            res.send({ success: false, message: 'kar_nik diperlukan' });
            return;
        }

        const tahunIni = new Date().getFullYear();

        // Pakai single connection + parallel queries
        pool.getConnection(function (err, connection) {
            if (err) {
                console.error('Connection error:', err);
                res.send({ success: false, message: 'Database error' });
                return;
            }

            // Query 1: Cek tgl masuk
            connection.query(
                `SELECT kar_tgl_masuk FROM tkaryawan WHERE kar_nik = ? LIMIT 1`,
                [kar_nik],
                function (error, karyawan) {
                    if (error) {
                        connection.release();
                        console.error('Query karyawan error:', error);
                        res.send({ success: false, message: 'Query error' });
                        return;
                    }

                    if (!karyawan.length) {
                        connection.release();
                        res.send({ success: false, message: 'Karyawan tidak ditemukan' });
                        return;
                    }

                    const tglMasuk = karyawan[0].kar_tgl_masuk;

                    // Jika kar_tgl_masuk NULL, anggap belum 1 tahun
                    if (!tglMasuk) {
                        connection.release();
                        res.send({
                            success: true,
                            sisa_cuti: 0,
                            total_cuti: 0,
                            message: 'Data tgl masuk tidak ditemukan'
                        });
                        return;
                    }

                    const satuTahunLalu = new Date();
                    satuTahunLalu.setFullYear(satuTahunLalu.getFullYear() - 1);
                    const tglMasukDate = new Date(tglMasuk);

                    // Belum 1 tahun
                    if (tglMasukDate > satuTahunLalu) {
                        connection.release();
                        res.send({
                            success: true,
                            sisa_cuti: 0,
                            total_cuti: 0,
                            terpakai_libur: 0,
                            terpakai_izin: 0,
                            message: 'Belum 1 tahun kerja'
                        });
                        return;
                    }

                    // Query 2 & 3: Hitung potongan (parallel dengan counter)
                    let terpakaiLibur = 0;
                    let terpakaiIzin = 0;
                    let queriesDone = 0;

                    const checkDone = () => {
                        queriesDone++;
                        if (queriesDone === 2) {
                            connection.release();
                            const totalCuti = 12;
                            const sisa = totalCuti - terpakaiLibur - terpakaiIzin;
                            res.send({
                                success: true,
                                sisa_cuti: sisa > 0 ? sisa : 0,
                                total_cuti: totalCuti,
                                terpakai_libur: terpakaiLibur,
                                terpakai_izin: terpakaiIzin,
                                sudah_satu_tahun: true
                            });
                        }
                    };

                    // Query libur
                    connection.query(
                        `SELECT COUNT(*) as jml FROM tharilibur 
                     WHERE hl_ispotongcuti = 1 AND YEAR(hl_tanggal) = ?`,
                        [tahunIni],
                        function (errLibur, resultLibur) {
                            if (!errLibur && resultLibur.length) {
                                terpakaiLibur = resultLibur[0].jml || 0;
                            }
                            checkDone();
                        }
                    );

                    // Query izin
                    connection.query(
                        `SELECT COUNT(*) as jml FROM tijin 
                     WHERE kar_nik = ? 
                     AND alasan = 'Cuti Tahunan' 
                     AND YEAR(tanggal) = ?`,
                        [kar_nik, tahunIni],
                        function (errIzin, resultIzin) {
                            if (!errIzin && resultIzin.length) {
                                terpakaiIzin = resultIzin[0].jml || 0;
                            }
                            checkDone();
                        }
                    );
                }
            );
        });
    },
    cekRotiQMobile(req, res) {
        let { kar_nik } = req.body;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(
                `SELECT kar_kd_unit, kar_kd_jabat FROM tkaryawan WHERE kar_nik = ?`,
                [kar_nik],
                function (error, results) {
                    if (error || !results.length) {
                        connection.release();
                        res.send({ success: false, is_rotiq_mobile: false });
                        return;
                    }

                    const kdUnit = results[0].kar_kd_unit;
                    const kdJabat = results[0].kar_kd_jabat;

                    const allowedUnits = ['19', '22', '23', '24'];
                    const isRotiqMobile = allowedUnits.includes(kdUnit) && kdJabat == '45';

                    if (isRotiqMobile) {
                        // Ambil daftar unit RotiQ
                        connection.query(
                            `SELECT kd_unit, nm_unit, latitude, longitude FROM tunit 
                         WHERE nm_unit LIKE '%RotiQ%' ORDER BY nm_unit`,
                            function (err2, units) {
                                connection.release();
                                if (err2) {
                                    res.send({ success: false, is_rotiq_mobile: false });
                                } else {
                                    res.send({
                                        success: true,
                                        is_rotiq_mobile: true,
                                        units: units
                                    });
                                }
                            }
                        );
                    } else {
                        connection.release();
                        res.send({ success: true, is_rotiq_mobile: false });
                    }
                }
            );
        });
    },


    getLaporanIzin(req, res) {
        let { kar_nik, start_date, end_date } = req.body;

        let sql = `SELECT ij_nomor, tanggal, alasan, keterangan, ij_foto 
               FROM tijin 
               WHERE kar_nik = ?`;
        let params = [kar_nik];

        if (start_date) {
            sql += ` AND tanggal >= ?`;
            params.push(start_date);
        }
        if (end_date) {
            sql += ` AND tanggal <= ?`;
            params.push(end_date + ' 23:59:59');
        }

        sql += ` ORDER BY tanggal DESC`;

        pool.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query(sql, params, function (error, results) {
                if (error) throw error;
                res.send({
                    success: true,
                    message: 'Berhasil!',
                    data: results
                });
            });
            connection.release();
        });
    },
};