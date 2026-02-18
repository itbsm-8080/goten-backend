const karyawan = require('./controller-karyawan');
const unit = require('./controller-unit');
const absen = require('./controller-absen');
const jabatan = require('./controller-jabatan');
const statistik = require('./controller-statistik');
const auth = require('./controller-auth');

module.exports = {
	karyawan,
	unit,
	absen,
	jabatan,
	statistik,
	auth
};