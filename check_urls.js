const fs = require('fs');
const http = require('http');
const https = require('https');

const dataFile = 'tokyo_shops_full.js';

// Read file
let rawContent = fs.readFileSync(dataFile, 'utf8');
const match = rawContent.match(/const\s+FULL_TOKYO_SHOPS\s*=\s*(\[[\s\S]*?\])\s*;/);
if (!match) {
    console.error("Could not parse shops data.");
    process.exit(1);
}

let shops;
try {
    shops = eval(match[1]); // Using eval because JSON.parse might fail if it's not strict JSON
} catch (e) {
    console.error("Eval failed:", e);
    process.exit(1);
}

const PARKING_KEYWORDS = [
    'domainking', 'onamae.com', 'sedo.com', 'hugedomains', 'is for sale', 'お名前.com', 
    'domain is registered', 'expired', 'valuecommerce', 'conoha', 'muumuu-domain', 'xserver', 'star-domain'
];

async function checkUrl(urlStr) {
    return new Promise((resolve) => {
        try {
            const url = new URL(urlStr);
            const client = url.protocol === 'https:' ? https : http;
            
            const req = client.get(urlStr, {
                timeout: 3000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml'
                }
            }, (res) => {
                const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
                if (isRedirect) {
                    const loc = res.headers.location.toLowerCase();
                    if (PARKING_KEYWORDS.some(k => loc.includes(k))) {
                        return resolve({ ok: false, reason: 'Redirected to parked/domain site: ' + loc });
                    }
                    return resolve({ ok: true, reason: 'Redirected to ' + loc });
                }

                if (res.statusCode >= 400 && res.statusCode !== 403) { // 403 sometimes is just WAF blocking bots
                    return resolve({ ok: false, reason: 'HTTP ' + res.statusCode });
                }

                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                    if (data.length > 50000) {
                        res.destroy(); // stop downloading large pages
                        return resolve({ ok: true });
                    }
                });

                res.on('end', () => {
                    const lowerData = data.toLowerCase();
                    const badKeyword = PARKING_KEYWORDS.find(k => lowerData.includes(k));
                    if (badKeyword) {
                        return resolve({ ok: false, reason: 'Parked domain keyword found: ' + badKeyword });
                    }
                    resolve({ ok: true });
                });
            });

            req.on('error', (err) => {
                resolve({ ok: false, reason: err.message });
            });
            
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, reason: 'Timeout' });
            });
        } catch (e) {
            resolve({ ok: false, reason: 'Invalid URL format' });
        }
    });
}

async function main() {
    let badCount = 0;
    
    console.log(`Checking ${shops.length} shops...`);
    
    const CONCURRENCY = 20;
    for (let i = 0; i < shops.length; i += CONCURRENCY) {
        const batch = shops.slice(i, i + CONCURRENCY);
        
        const promises = batch.map(async (shop) => {
            if (shop.website) {
                const result = await checkUrl(shop.website);
                if (!result.ok) {
                    console.log(`[BAD] ${shop.name} (${shop.website}): ${result.reason}`);
                    shop.website = null;
                    return true; // was bad
                }
            }
            return false;
        });
        
        const results = await Promise.all(promises);
        badCount += results.filter(r => r).length;
        
        if (i % 100 === 0 && i > 0) {
            console.log(`Processed ${i}/${shops.length}...`);
        }
    }

    if (badCount > 0) {
        console.log(`\nFound and removed ${badCount} bad URLs.`);
        
        const newContent = 'const FULL_TOKYO_SHOPS = ' + JSON.stringify(shops, null, 4) + ';\n';
        fs.writeFileSync(dataFile, newContent, 'utf8');
        console.log('Saved updated tokyo_shops_full.js');
    } else {
        console.log('\nNo bad URLs found!');
    }
}

main();
