const config = require('../configs/database');
const mysql = require('mysql');
const pool = mysql.createPool(config);
const http = require('http');

pool.on('error', (err) => {
  console.error(err);
});

const NOMERATOR = 'POD';

async function uploadFile(base64Data, filename) {
  const match = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
  if (!match) return null;

  const [, format, base64] = match;
  const buffer = Buffer.from(base64, 'base64');

  return new Promise((resolve) => {
    const boundary = '----formdata-' + Date.now();

    const headBuf = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="prefix"\r\n\r\n' +
      'POD\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
      'Content-Type: image/' + format + '\r\n\r\n',
      'utf8'
    );
    const tailBuf = Buffer.from('\r\n--' + boundary + '--', 'utf8');
    const data = Buffer.concat([headBuf, buffer, tailBuf]);

    const options = {
      hostname: '103.103.22.7',
      path: '/cutikaryawan/upload.php',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': data.length
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const resp = JSON.parse(body);
          resolve(resp.status === 'success' ? resp.filename : null);
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      resolve(null);
    });

    req.write(data);
    req.end();
  });
}

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
      `SELECT u.dbase, k.kar_nama FROM tkaryawan k INNER JOIN tunit u ON k.kar_kd_unit = u.kd_unit WHERE k.kar_nik = ?`,
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
        callback({ dbase: results[0].dbase, kar_nama: results[0].kar_nama || '' }, null);
      }
    );
  });
}

function sanitizeDbase(dbase) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(dbase)) return null;
  return dbase;
}

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

  cariDO(req, res) {
    let { kar_nik, start_date, keyword } = req.body;
    const minTanggal = '2026-08-01';

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

      let sql = `SELECT a.do_nomor Nomor, DATE_FORMAT(a.do_tanggal, '%Y-%m-%d') Tanggal, Cus_nama Customer, Cus_alamat Alamat, Cus_kode
                 FROM \`${dbase}\`.tdo_hdr a
                 INNER JOIN \`${dbase}\`.tcustomer ON a.do_cus_Kode = Cus_kode
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM \`${dbase}\`.tpod_hdr b
                     WHERE b.pod_do_nomor = a.do_nomor
                 )
                 AND a.do_tanggal >= ?`;
      let params = [minTanggal];

      if (keyword && keyword.trim() !== '') {
        sql += ` AND (a.do_nomor LIKE ? OR Cus_nama LIKE ?)`;
        const like = `%${keyword.trim()}%`;
        params.push(like, like);
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

  async tambahPOD(req, res) {
    let { kar_nik, pod_do_nomor, pod_tanggal, pod_foto, pod_cus_kode } = req.body;

    if (!pod_do_nomor || !pod_tanggal || !pod_foto || !pod_cus_kode) {
      res.send({ success: false, message: 'DO, tanggal, foto, dan customer wajib diisi' });
      return;
    }

    try {
      const info = await new Promise((resolve, reject) => {
        getDbase(kar_nik, (data, errorMsg) => {
          if (errorMsg) reject(errorMsg);
          else resolve(data);
        });
      });

      const dbase = sanitizeDbase(info.dbase);
      if (!dbase) {
        res.send({ success: false, message: 'Nama database tidak valid' });
        return;
      }

      const cbgKode = await new Promise((resolve, reject) => {
        getCbgKode(dbase, (data, errorMsg) => {
          if (errorMsg) reject(errorMsg);
          else resolve(data);
        });
      });

      const podNomor = await new Promise((resolve, reject) => {
        getNextPodNomor(dbase, cbgKode, pod_tanggal, (data) => resolve(data));
      });

      const filename = `POD_${podNomor.replace(/[.-]/g, '')}.png`;
      const uploadedFilename = await uploadFile(pod_foto, filename);

      if (!uploadedFilename) {
        res.send({ success: false, message: 'Gagal upload foto' });
        return;
      }

      pool.getConnection(function (err, connection) {
        if (err) throw err;
        connection.query(
          `SELECT pod_do_nomor FROM \`${dbase}\`.tpod_hdr WHERE pod_do_nomor = ?`,
          [pod_do_nomor],
          function (error, rows) {
            if (error) {
              connection.release();
              throw error;
            }
            if (rows.length > 0) {
              connection.release();
              res.send({ success: false, message: 'DO sudah pernah dibuatkan POD' });
              return;
            }

            connection.query(
              `INSERT INTO \`${dbase}\`.tpod_hdr 
               (pod_nomor, pod_do_nomor, pod_tanggal, pod_foto, pod_cus_kode, date_create, user_create) 
               VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
              [podNomor, pod_do_nomor, pod_tanggal, uploadedFilename, pod_cus_kode, info.kar_nama],
              function (err2, results) {
                connection.release();
                if (err2) throw err2;
                res.send({ success: true, message: 'POD disimpan!', pod_nomor: podNomor, pod_foto: uploadedFilename });
              }
            );
          }
        );
      });
    } catch (error) {
      console.error('tambahPOD error:', error);
      res.send({ success: false, message: error.message || 'Gagal menyimpan POD' });
    }
  },

  async editPOD(req, res) {
    let { kar_nik, pod_nomor, pod_tanggal, pod_foto } = req.body;

    if (!pod_nomor || !pod_tanggal) {
      res.send({ success: false, message: 'pod_nomor dan tanggal wajib diisi' });
      return;
    }

    try {
      const info = await new Promise((resolve, reject) => {
        getDbase(kar_nik, (data, errorMsg) => {
          if (errorMsg) reject(errorMsg);
          else resolve(data);
        });
      });

      const dbase = sanitizeDbase(info.dbase);
      if (!dbase) {
        res.send({ success: false, message: 'Nama database tidak valid' });
        return;
      }

      let foto = null;
      if (pod_foto) {
        const filename = `POD_${pod_nomor.replace(/[.-]/g, '')}.png`;
        foto = await uploadFile(pod_foto, filename);
        if (!foto) {
          res.send({ success: false, message: 'Gagal upload foto' });
          return;
        }
      }

      pool.getConnection(function (err, connection) {
        if (err) throw err;
        connection.query(
          `UPDATE \`${dbase}\`.tpod_hdr 
           SET pod_tanggal = ?, pod_foto = ?, date_modified = NOW(), user_modified = ?
           WHERE pod_nomor = ? AND DATE(pod_tanggal) = CURDATE()`,
          [pod_tanggal, foto || null, info.kar_nama, pod_nomor],
          function (error, results) {
            if (error) throw error;
            if (results.affectedRows === 0) {
              res.send({ success: false, message: 'Data hanya bisa diedit di hari yang sama' });
            } else {
              res.send({ success: true, message: 'POD diperbarui!', pod_foto: foto });
            }
          }
        );
        connection.release();
      });
    } catch (error) {
      console.error('editPOD error:', error);
      res.send({ success: false, message: error.message || 'Gagal update POD' });
    }
  },

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
