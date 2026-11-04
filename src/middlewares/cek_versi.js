// Gate versi aplikasi mobile.
//
// Aplikasi Flutter mengirim X-App-Version-Code di setiap request. Kalau angkanya
// di bawah MIN_APP_VERSION_CODE, request ditolak 426 supaya versi lama tidak bisa
// dipakai. Aplikasi lama belum mengirim header itu, jadi dihitung versi 0.
//
// VERSION_GATE_MODE:
//   off   - semua lolos (default, aman saat deploy pertama)
//   log   - yang di bawah minimum dicatat, tetap lolos
//   block - yang di bawah minimum ditolak 426
//
// Web dan klien lain tidak terkena. Yang diperiksa hanya request dari aplikasi
// mobile, dikenali dari X-App-Platform atau User-Agent Dart.

function dariMobile(platform, ua) {
    const p = (platform || '').toLowerCase();
    if (p === 'android') return true;
    // Versi lama belum mengirim X-App-Platform, jadi UA yang membedakannya
    // dari browser web.
    return p === '' && (ua || '').toLowerCase().startsWith('dart');
}

// Keputusan murni, dipisah supaya bisa diuji tanpa express.
// Hasil: 'lewat' | 'catat' | 'tolak'
function keputusan({ mode, min, platform, ua, kode }) {
    if (mode !== 'log' && mode !== 'block') return 'lewat';
    if (!(min > 0)) return 'lewat';
    if (!dariMobile(platform, ua)) return 'lewat';
    if (kode >= min) return 'lewat';
    return mode === 'log' ? 'catat' : 'tolak';
}

module.exports = function cekVersi(req, res, next) {
    if (req.method === 'OPTIONS') return next();

    const mode = (process.env.VERSION_GATE_MODE || 'off').toLowerCase();
    const min = parseInt(process.env.MIN_APP_VERSION_CODE || '0', 10) || 0;
    const kode = parseInt(req.get('X-App-Version-Code') || '0', 10) || 0;
    const hasil = keputusan({
        mode,
        min,
        platform: req.get('X-App-Platform'),
        ua: req.get('User-Agent'),
        kode,
    });

    if (hasil === 'lewat') return next();
    if (hasil === 'catat') {
        console.log(`[versi] ${kode || 'tanpa header'} < ${min} ${req.method} ${req.originalUrl}`);
        return next();
    }

    return res.status(426).json({
        success: false,
        code: 'UPDATE_REQUIRED',
        message: 'Versi aplikasi ini sudah tidak didukung. Pasang versi terbaru untuk melanjutkan.',
        min_version: min,
        apk_url: process.env.APK_URL || '',
    });
};

module.exports._test = { dariMobile, keputusan };
