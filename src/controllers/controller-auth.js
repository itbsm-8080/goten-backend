const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);

pool.on('error', (err) => {
    console.error(err);
});

module.exports = {
    // Generate OTP untuk login
    generateOTP(req, res) {
        let { kar_nik } = req.body;
        
        // Generate random 6 digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 60000); // 1 menit dari sekarang
        
        pool.getConnection(function(err, connection) {
            if (err) throw err;
            connection.query(
                `UPDATE tkaryawan SET one_time_password = ?, password_expires = ? WHERE kar_nik = ?`,
                [otp, expires, kar_nik],
                function(error, results) {
                    if (error) {
                        connection.release();
                        return res.send({ 
                            success: false, 
                            message: 'Gagal generate OTP' 
                        });
                    }
                    
                    if (results.affectedRows === 0) {
                        connection.release();
                        return res.send({ 
                            success: false, 
                            message: 'Karyawan tidak ditemukan' 
                        });
                    }
                    
                    res.send({ 
                        success: true, 
                        message: 'OTP berhasil digenerate',
                        otp: otp,
                        expires: expires
                    });
                    connection.release();
                }
            );
        });
    },

    // Verify OTP untuk login - PERMANENT SESSION
    verifyOTPLogin(req, res) {
        let { kar_nik, otp, browser_info } = req.body;
        
        pool.getConnection(function(err, connection) {
            if (err) throw err;
            
            connection.query(
                `SELECT kar_nik, kar_nama, kar_kd_unit, password, password_expires 
                 FROM tkaryawan 
                 WHERE kar_nik = ? AND kar_status_aktif = 1`,
                [kar_nik],
                function(error, results) {
                    if (error) {
                        connection.release();
                        return res.status(500).send({ 
                            success: false, 
                            message: 'Database error' 
                        });
                    }
                    
                    if (!results.length) {
                        connection.release();
                        return res.status(401).send({ 
                            success: false, 
                            message: 'Karyawan tidak ditemukan atau tidak aktif' 
                        });
                    }
                    
                    let user = results[0];
                    let now = new Date();
                    
                    // Validasi OTP
                    if (!user.password) {
                        connection.release();
                        return res.status(401).send({ 
                            success: false, 
                            message: 'OTP belum digenerate' 
                        });
                    }
                    
                    if (new Date(user.password_expires) < now) {
                        connection.release();
                        return res.status(401).send({ 
                            success: false, 
                            message: 'OTP sudah expired' 
                        });
                    }
                    
                    if (user.password !== otp) {
                        connection.release();
                        return res.status(401).send({ 
                            success: false, 
                            message: 'OTP tidak valid' 
                        });
                    }
                    
                    // OTP valid - clear OTP dan generate PERMANENT TOKEN
                    connection.query(
                        `UPDATE tkaryawan SET password = NULL, password_expires = NULL WHERE kar_nik = ?`,
                        [kar_nik],
                        function(updateError, updateResults) {
                            if (updateError) {
                                connection.release();
                                return res.status(500).send({ 
                                    success: false, 
                                    message: 'Gagal update OTP' 
                                });
                            }
                            
                            // GENERATE PERMANENT TOKEN (tanpa expiry)
                            const tokenData = {
                                kar_nik: user.kar_nik,
                                timestamp: Date.now()
                            };
                            
                            const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
                            
                            res.send({ 
                                success: true, 
                                message: 'Login berhasil',
                                token: token,
                                user: {
                                    kar_nik: user.kar_nik,
                                    kar_nama: user.kar_nama,
                                    kar_kd_unit: user.kar_kd_unit
                                },
                                browser_info: browser_info
                            });
                            connection.release();
                        }
                    );
                }
            );
        });
    },

    // Verify token - PERMANENT SESSION
    verifyToken(req, res) {
        let { token } = req.body;
        
        try {
            const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
            console.log(tokenData);
            // Token valid - get fresh user data
            pool.getConnection(function(err, connection) {
                if (err) throw err;
                
                connection.query(
                    `SELECT kar_nik, kar_nama, kar_kd_unit 
                     FROM tkaryawan 
                     WHERE kar_nik = ? AND kar_status_aktif = 1`,
                    [tokenData.kar_nik],
                    function(error, results) {
                        if (error || !results.length) {
                            connection.release();
                            return res.status(401).send({ 
                                success: false, 
                                message: 'User tidak ditemukan' 
                            });
                        }
                        
                        let user = results[0];
                        
                        res.send({ 
                            success: true, 
                            message: 'Token valid',
                            user: {
                                kar_nik: user.kar_nik,
                                kar_nama: user.kar_nama,
                                kar_kd_unit: user.kar_kd_unit
                            }
                        });
                        connection.release();
                    }
                );
            });
            
        } catch (error) {
            res.status(401).send({ 
                success: false, 
                message: 'Token tidak valid' 
            });
        }
    },

    // Logout endpoint
    logout(req, res) {
        res.send({ 
            success: true, 
            message: 'Logout berhasil' 
        });
    }
};