/**
 * Интеллектуальный сборщик и верификатор базы дорожных камер РФ (Antiradar).
 * Запускается по расписанию в GitHub Actions (раз в неделю):
 * 1. Читает эталонную базу 37 900+ проверенных комплексов (Стрелка/SpeedCam).
 * 2. Опрашивает реестры на наличие НОВЫХ комплексов на дорогах.
 * 3. Строгая дедупликация (35 метров): исключает задвоение полос и встречки.
 * 4. Защита от мусора: никаких слепых "60 км/ч" без подтвержденного знака!
 * 5. Упаковывает в GZIP level 9 и обновляет статус.
 */

const fs = require('fs');
const zlib = require('zlib');
const https = require('https');

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Antiradar-Bot/2.0' }, timeout: timeoutMs }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.on('error', reject);
    });
}

async function main() {
    console.log("=== Старт интеллектуального обновления базы камер РФ ===");

    const gzPath = './cameras_russia_live.json.gz';
    if (!fs.existsSync(gzPath)) {
        throw new Error("Файл cameras_russia_live.json.gz не найден в репозитории!");
    }

    const compressed = fs.readFileSync(gzPath);
    const rawJson = zlib.gunzipSync(compressed).toString('utf8');
    const existingCameras = JSON.parse(rawJson);

    console.log(`Эталонная база загружена: ${existingCameras.length} камер.`);

    // Построение пространственной сетки для быстрой проверки радиуса 35 м
    const bucketSize = 0.02; // ~2 км
    const grid = new Map();
    let maxId = 0;

    function getBucketKey(lat, lon) {
        return Math.floor(lat / bucketSize) + ':' + Math.floor(lon / bucketSize);
    }
    function addToGrid(c) {
        const k = getBucketKey(c.lat, c.lon);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(c);
        if (c.id > maxId && c.id < 9000000) maxId = c.id;
    }
    function hasNearbyCamera(lat, lon, radiusM) {
        const delta = (radiusM / 111000) + (bucketSize * 0.5);
        const minLatB = Math.floor((lat - delta) / bucketSize);
        const maxLatB = Math.floor((lat + delta) / bucketSize);
        const minLonB = Math.floor((lon - delta) / bucketSize);
        const maxLonB = Math.floor((lon + delta) / bucketSize);

        for (let la = minLatB; la <= maxLatB; la++) {
            for (let lo = minLonB; lo <= maxLonB; lo++) {
                const list = grid.get(la + ':' + lo);
                if (list) {
                    for (const it of list) {
                        if (calculateDistance(lat, lon, it.lat, it.lon) <= radiusM) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    for (const cam of existingCameras) {
        addToGrid(cam);
    }

    let addedCount = 0;
    let rejectedNoSpeed = 0;
    let rejectedDuplicate = 0;

    const overpassEndpoints = [
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass-api.de/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter"
    ];

    const overpassQuery = encodeURIComponent('[out:json][timeout:25];area["ISO3166-1"="RU"][admin_level=2]->.a;(node["highway"="speed_camera"](area.a););out body;');

    console.log("Опрос реестров на наличие новых сертифицированных комплексов...");
    for (const ep of overpassEndpoints) {
        try {
            const url = `${ep}?data=${overpassQuery}`;
            console.log(`Запрос к ${ep}...`);
            const data = await fetchJson(url, 25000);
            if (data && data.elements && Array.isArray(data.elements)) {
                for (const el of data.elements) {
                    if (el.lat && el.lon) {
                        // 1. Проверяем наличие знака скорости
                        const speedTag = parseInt(el.tags?.maxspeed, 10);
                        if (!speedTag || isNaN(speedTag) || speedTag < 20 || speedTag > 130) {
                            rejectedNoSpeed++;
                            continue;
                        }

                        // 2. Проверяем расстояние 35м (исключаем дубли)
                        if (hasNearbyCamera(el.lat, el.lon, 35.0)) {
                            rejectedDuplicate++;
                            continue;
                        }

                        maxId++;
                        const dir = parseInt(el.tags?.direction, 10) || 0;
                        const newCam = {
                            id: maxId,
                            lat: parseFloat(el.lat.toFixed(6)),
                            lon: parseFloat(el.lon.toFixed(6)),
                            type: 1,
                            dir: dir,
                            dirType: dir === 0 ? 0 : 1,
                            angle: 16,
                            dist: speedTag >= 80 ? 700 : 500,
                            revDist: 150,
                            limit: speedTag
                        };

                        existingCameras.push(newCam);
                        addToGrid(newCam);
                        addedCount++;
                    }
                }
                console.log(`Успешно обработано! Добавлено: ${addedCount} (отсеяно дублей: ${rejectedDuplicate}, отсеяно без знака: ${rejectedNoSpeed})`);
                break;
            }
        } catch (e) {
            console.log(`Зеркало ${ep} недоступно (${e.message}), пробуем следующее...`);
        }
    }

    if (existingCameras.length < 35000) {
        throw new Error(`Ошибка безопасности: размер базы (${existingCameras.length}) меньше допустимого!`);
    }

    existingCameras.sort((a, b) => a.id - b.id);

    const newJson = JSON.stringify(existingCameras);
    const newGz = zlib.gzipSync(Buffer.from(newJson, 'utf8'), { level: 9 });
    fs.writeFileSync(gzPath, newGz);

    const now = new Date();
    const mskTime = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' MSK';

    const readme = `# 📡 База дорожных камер РФ (для Антирадара)

![Auto-Update](https://github.com/mff404/antiradar-cameras/actions/workflows/update_cameras.yml/badge.svg)
![Камер в базе](https://img.shields.io/badge/Камер_в_базе-${existingCameras.length}-brightgreen)
![Статус](https://img.shields.io/badge/Обновление-Каждое_воскресенье_03:00_UTC-blue)

Актуальный реестр камер контроля скорости и комплексов фотовидеофиксации для мобильного приложения **Антирадар РЭБ**.

## 📊 Текущее состояние
- **Всего комплексов в базе:** **${existingCameras.length}**
- **Последнее обновление:** **${mskTime}**
- **Размер архива:** **${(newGz.length / 1024).toFixed(1)} КБ** (в распакованном виде ~${(newJson.length / 1024 / 1024).toFixed(2)} МБ)
- **Зона покрытия:** Вся территория Российской Федерации (все 89 регионов).

## 🚀 CDN для приложения
- **Основной канал (Cloudflare CDN):**  
  \`https://cdn.jsdelivr.net/gh/mff404/antiradar-cameras@main/cameras_russia_live.json.gz\`
- **Резервный канал:**  
  \`https://raw.githubusercontent.com/mff404/antiradar-cameras/main/cameras_russia_live.json.gz\`
`;

    fs.writeFileSync('./README.md', readme, 'utf8');

    const statusObj = {
        updatedAt: mskTime,
        totalCameras: existingCameras.length,
        addedInLastRun: addedCount,
        archiveSizeKb: Math.round(newGz.length / 1024)
    };
    fs.writeFileSync('./status.json', JSON.stringify(statusObj, null, 2), 'utf8');

    console.log(`=== Готово! Итого в базе: ${existingCameras.length} камер. Добавлено: ${addedCount}. Время: ${mskTime} ===`);
}

main().catch(err => {
    console.error("Критическая ошибка сборщика:", err);
    process.exit(1);
});
