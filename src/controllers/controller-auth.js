const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

module.exports = {
    // Login web: kar_nik + password (plaintext). Web mewajibkan device_id & sesi tunggal.
    login(req, res) {
        let { kar_nik, password, device_id } = req.body;
        const client_type = req.body.client_type || 'web';

        if (!kar_nik || password === undefined) {
            return res.status(400).send({ success: false, message: 'kar_nik dan password wajib', code: 'bad_request' });
        }

        pool.getConnection(function (err, connection) {
            if (err) {
                console.error(err);
                return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
            }

            connection.query(
                `SELECT kar_nik, kar_nama, kar_kd_unit, kar_kd_jabat, password
                 FROM tkaryawan
                 WHERE kar_nik = ? AND kar_status_aktif = 1`,
                [kar_nik],
                function (error, results) {
                    if (error) {
                        console.error(error);
                        connection.release();
                        return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
                    }

                    if (!results.length || results[0].password !== password) {
                        connection.release();
                        return res.status(401).send({ success: false, message: 'NIK atau password salah', code: 'invalid_credentials' });
                    }

                    const user = results[0];
                    const token = Buffer.from(JSON.stringify({
                        kar_nik: user.kar_nik,
                        timestamp: Date.now(),
                        web: true,
                        r: Math.random().toString(16).slice(2, 10)
                    })).toString('base64');

                    const finishLogin = () => {
                        res.send({
                            success: true,
                            message: 'Login berhasil',
                            token,
                            user: {
                                kar_nik: user.kar_nik,
                                kar_nama: user.kar_nama,
                                kar_kd_unit: user.kar_kd_unit,
                                kar_kd_jabat: user.kar_kd_jabat
                            }
                        });
                        connection.release();
                    };

                    if (client_type !== 'web') {
                        return finishLogin();
                    }

                    if (!device_id) {
                        connection.release();
                        return res.status(400).send({ success: false, message: 'device_id wajib', code: 'bad_request' });
                    }

                    // 1 perangkat = 1 akun: device sudah terikat akun lain -> tolak
                    connection.query(
                        `SELECT kar_nik FROM tdevice_binding WHERE device_id = ?`,
                        [device_id],
                        function (err, bindRows) {
                            if (err) {
                                console.error(err);
                                connection.release();
                                return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
                            }

                            if (bindRows.length && bindRows[0].kar_nik !== user.kar_nik) {
                                connection.release();
                                return res.status(403).send({
                                    success: false,
                                    message: 'Perangkat ini sudah terikat akun lain. Keluar dari akun tersebut terlebih dahulu.',
                                    code: 'device_bound'
                                });
                            }

                            // Ikat device ke akun, simpan sesi aktif tunggal
                            connection.query(
                                `INSERT INTO tdevice_binding (device_id, kar_nik) VALUES (?, ?)
                                 ON DUPLICATE KEY UPDATE kar_nik = VALUES(kar_nik)`,
                                [device_id, user.kar_nik],
                                function (err) {
                                    if (err) {
                                        console.error(err);
                                        connection.release();
                                        return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
                                    }
                                    connection.query(
                                        `UPDATE tkaryawan SET web_session_token = ?, web_session_device = ? WHERE kar_nik = ?`,
                                        [token, device_id, user.kar_nik],
                                        function (err) {
                                            if (err) {
                                                console.error(err);
                                                connection.release();
                                                return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
                                            }
                                            finishLogin();
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        });
    },

    // Verify token - sesi aktif tunggal untuk token web
    verifyToken(req, res) {
        let { token } = req.body;
        const device_id = req.body.device_id;

        if (!token) {
            return res.status(401).send({ success: false, message: 'Token tidak valid', code: 'invalid_token' });
        }

        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        } catch (error) {
            return res.status(401).send({ success: false, message: 'Token tidak valid', code: 'invalid_token' });
        }

        pool.getConnection(function (err, connection) {
            if (err) {
                console.error(err);
                return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
            }

            connection.query(
                `SELECT kar_nik, kar_nama, kar_kd_unit, kar_kd_jabat, web_session_token, web_session_device
                 FROM tkaryawan
                 WHERE kar_nik = ? AND kar_status_aktif = 1`,
                [tokenData.kar_nik],
                function (error, results) {
                    if (error) {
                        console.error(error);
                        connection.release();
                        return res.status(500).send({ success: false, message: 'Database error', code: 'error' });
                    }

                    if (!results.length) {
                        connection.release();
                        return res.status(401).send({ success: false, message: 'User tidak ditemukan', code: 'invalid_token' });
                    }

                    let user = results[0];

                    // Token web: harus cocok dengan sesi aktif tersimpan
                    if (tokenData.web) {
                        if (!user.web_session_token || user.web_session_token !== token) {
                            connection.release();
                            return res.status(401).send({
                                success: false,
                                message: 'Sesi aktif di perangkat lain, silakan login ulang',
                                code: 'session_replaced'
                            });
                        }
                        if (device_id && user.web_session_device !== device_id) {
                            connection.release();
                            return res.status(401).send({
                                success: false,
                                message: 'Sesi aktif di perangkat lain, silakan login ulang',
                                code: 'session_replaced'
                            });
                        }
                    }

                    res.send({
                        success: true,
                        message: 'Token valid',
                        user: {
                            kar_nik: user.kar_nik,
                            kar_nama: user.kar_nama,
                            kar_kd_unit: user.kar_kd_unit,
                            kar_kd_jabat: user.kar_kd_jabat
                        }
                    });
                    connection.release();
                }
            );
        });
    },

    // Logout web: kosongkan sesi aktif
    logout(req, res) {
        let { token } = req.body;

        if (!token) {
            return res.send({ success: true, message: 'Logout berhasil', code: 'ok' });
        }

        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        } catch (error) {
            return res.send({ success: true, message: 'Logout berhasil', code: 'ok' });
        }

        if (!tokenData.web || !tokenData.kar_nik) {
            return res.send({ success: true, message: 'Logout berhasil', code: 'ok' });
        }

        pool.getConnection(function (err, connection) {
            if (err) {
                console.error(err);
                return res.send({ success: true, message: 'Logout berhasil', code: 'ok' });
            }

            connection.query(
                `UPDATE tkaryawan SET web_session_token = NULL, web_session_device = NULL WHERE kar_nik = ? AND web_session_token = ?`,
                [tokenData.kar_nik, token],
                function (error) {
                    if (error) console.error(error);
                    connection.release();
                    res.send({ success: true, message: 'Logout berhasil', code: 'ok' });
                }
            );
        });
    },
};