import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import translate from 'google-translate-api-x';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.resolve(__dirname, '../package.json');
const tauriConfJsonPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
const releaseHistoryPath = path.resolve(__dirname, '../release-history.json');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function run() {
    console.log(`현재 버전: ${currentVersion}`);
    const newVersionInput = await question('새로운 버전을 입력하세요 (엔터 시 현재 버전 유지): ');
    const newVersion = newVersionInput.trim() || currentVersion;

    const notesKo = await question('업데이트 내용(한글)을 입력하세요 (엔터 시 기본 문구 사용): ');
    rl.close();

    const finalNotesKo = notesKo.trim() || `MHZipy Version ${newVersion} Released!`;

    console.log('\n업데이트 내용을 다른 언어로 번역중...');
    let notesEn = finalNotesKo;
    let notesJa = finalNotesKo;

    try {
        const resEn = await translate(finalNotesKo, { to: 'en' });
        notesEn = resEn.text;
        
        const resJa = await translate(finalNotesKo, { to: 'ja' });
        notesJa = resJa.text;
        
        console.log('번역 완료 성공!');
        console.log(` - 영어 (EN): ${notesEn}`);
        console.log(` - 일어 (JA): ${notesJa}`);
    } catch (err) {
        console.error('구글 번역 API 호출 중 에러 발생:', err.message);
        console.log('원본 텍스트를 그대로 사용합니다.');
    }

    // 1. Update package.json
    if (newVersion !== currentVersion) {
        packageJson.version = newVersion;
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
        console.log(`✅ package.json 버전 업데이트: ${newVersion}`);
    }

    // 2. Update tauri.conf.json
    const tauriConfJson = JSON.parse(fs.readFileSync(tauriConfJsonPath, 'utf8'));
    if (tauriConfJson.version !== newVersion) {
        tauriConfJson.version = newVersion;
        fs.writeFileSync(tauriConfJsonPath, JSON.stringify(tauriConfJson, null, 2) + '\n');
        console.log(`✅ tauri.conf.json 버전 업데이트: ${newVersion}`);
    }

    // 3. Update release-history.json
    let history = [];
    if (fs.existsSync(releaseHistoryPath)) {
        history = JSON.parse(fs.readFileSync(releaseHistoryPath, 'utf8'));
    }

    const today = new Date().toISOString().split('T')[0];
    const newRelease = {
        version: newVersion,
        date: today,
        notes: {
            ko: [finalNotesKo],
            en: [notesEn],
            ja: [notesJa]
        }
    };

    history.unshift(newRelease); // Add to the top
    fs.writeFileSync(releaseHistoryPath, JSON.stringify(history, null, 2) + '\n');
    console.log(`✅ release-history.json 업데이트 완료`);
}

run();
