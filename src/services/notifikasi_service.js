const https = require('https');

const ONE_SIGNAL_APP_ID = "472991ff-7080-470c-bfe4-d4d9d0123b8c";
const ONE_SIGNAL_REST_API_KEY = "YOUR_REST_API_KEY";



function kirimNotifikasi({ headings, contents, includedSegments = ["Active Users"], data = {} }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            app_id: ONE_SIGNAL_APP_ID,
            headings: { en: headings },
            contents: { en: contents },
            included_segments: includedSegments,
            data: data, // additional data untuk navigation
        });

        const options = {
            hostname: 'onesignal.com',
            path: '/api/v1/notifications',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${ONE_SIGNAL_REST_API_KEY}`
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                console.log('OneSignal response:', body);
                resolve(JSON.parse(body));
            });
        });

        req.on('error', (e) => {
            console.error('OneSignal error:', e);
            reject(e);
        });

        req.write(payload);
        req.end();
    });
}

module.exports = { kirimNotifikasi };