const karyawan = require('./controller-karyawan');
const unit = require('./controller-unit');
const absen = require('./controller-absen');
const jabatan = require('./controller-jabatan');
const statistik = require('./controller-statistik');
const auth = require('./controller-auth');
const izin = require('./controller-izin');
const pod = require('./controller-pod');

module.exports = {
	karyawan,
	unit,
	absen,
	jabatan,
	statistik,
	auth,
	izin,
	pod
};