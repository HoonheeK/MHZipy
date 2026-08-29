import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

// archiver v5는 CommonJS 전용이므로 createRequire 사용
const require = createRequire(import.meta.url);
const archiver = require('archiver');

// archiver-zip-encryptable 포맷 등록 (ZipCrypto 암호화 지원)
archiver.registerFormat('zip-encryptable', require('archiver-zip-encryptable'));

// .env 파일에서 환경변수 로드
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ZIP_PASSWORD = 'marhsoft';

/**
 * exe 파일을 .abc 확장자로 이름을 바꿔 넣고, ZipCrypto 암호로 보호된 ZIP으로 압축하는 함수
 * @param {string} exePath - 원본 exe 파일 경로
 * @param {string} abcFileName - .abc 확장자로 저장할 파일명 (ZIP 내부에서 사용될 이름)
 * @param {string} zipPath - 생성할 ZIP 파일 전체 경로
 * @returns {Promise<void>}
 */
function createPasswordZip(exePath, abcFileName, zipPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip-encryptable', {
            zlib: { level: 9 },
            forceLocalTime: true,
            password: ZIP_PASSWORD // ZipCrypto (Standard Windows Compatibility)
        });

        output.on('close', () => {
            console.log(`✅ ZIP 파일 생성: ${path.basename(zipPath)} (${(archive.pointer() / 1024 / 1024).toFixed(1)} MB)`);
            resolve();
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);

        // exe 파일을 .abc 이름으로 변환하여 ZIP 내에 추가
        archive.file(exePath, { name: abcFileName });

        archive.finalize();
    });
}

async function run() {
    console.log("📦 빌드 후 릴리스 파일 생성 및 R2 업로드 자동화 스크립트 시작...");

    // 1. tauri.conf.json에서 앱 버전과 제품명 가져오기
    const tauriConfPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    const version = tauriConf.version;
    const productName = tauriConf.productName || "mhzipy";

    // 2. 설치 파일과 서명 파일 경로 (Tauri v2 NSIS 번들러 기본 경로)
    const installerFileName = `${productName}_${version}_x64-setup.exe`;
    const bundleDir = path.resolve(__dirname, '../src-tauri/target/release/bundle/nsis');
    const installerPath = path.join(bundleDir, installerFileName);
    const sigPath = `${installerPath}.sig`;

    // 포터블 exe 경로 (ZIP 변환용 대상)
    const releaseDir = path.resolve(__dirname, '../src-tauri/target/release');
    const portableExeName = `${productName}.exe`;
    const portableExePath = path.join(releaseDir, portableExeName);

    if (!fs.existsSync(installerPath) || !fs.existsSync(sigPath)) {
        console.error("❌ 설치파일 또는 서명파일을 찾을 수 없습니다:", installerPath);
        process.exit(1);
    }
    if (!fs.existsSync(portableExePath)) {
        console.error("❌ 포터블 exe를 찾을 수 없습니다:", portableExePath);
        process.exit(1);
    }

    // 3. 서명(Signature) 파일 읽기
    const signature = fs.readFileSync(sigPath, 'utf8').trim();

    // 4. 포터블 exe → .abc 변환 후 ZIP 생성 (ZipCrypto 암호화)
    const abcFileName = `${productName}.abc`;
    const zipFileName = `${productName}_${version}.zip`;
    const zipPath = path.join(releaseDir, zipFileName);

    console.log(`🔄 암호화된 ZIP 파일 생성 중: ${portableExeName} → ${abcFileName} (ZIP: ${zipFileName})`);
    await createPasswordZip(portableExePath, abcFileName, zipPath);

    // 5. 자동생성할 update.json 데이터 구성
    const updateJson = {
        version: version,
        notes: `Beta Version Released!`,
        pub_date: new Date().toISOString(),
        platforms: {
            "windows-x86_64": {
                signature: signature,
                // Tauri Updater가 exe 파일을 다운로드할 URL (설치 파일용도)
                url: `https://mhzipy-update.marh-sw.com/${installerFileName}`
            }
        },
        // 홈페이지 포터블 다운로드용 ZIP 정보
        download: {
            zip_url: `https://mhzipy-update.marh-sw.com/${zipFileName}`,
            zip_filename: zipFileName,
            inner_filename: abcFileName,
            password_hint: "The ZIP file is password-protected."
        }
    };

    // 로컬 홈페이지 프로젝트의 update.json 파일도 동기화
    const localUpdateJsonPath = path.resolve(__dirname, '../../../HOMEPAGE/marh-software/homepage-files/update.json');
    if (fs.existsSync(path.dirname(localUpdateJsonPath))) {
        fs.writeFileSync(localUpdateJsonPath, JSON.stringify(updateJson, null, 2));
        console.log("✅ 로컬 update.json 파일 동기화 완료");
    } else {
        console.warn("⚠️ 홈페이지 프로젝트 경로를 찾을 수 없어 로컬 update.json 동기화를 건너뜁니다:", path.dirname(localUpdateJsonPath));
    }

    // 6. Cloudflare R2 업로드
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;

    if (accountId && accessKeyId && secretAccessKey && bucketName) {
        const s3 = new S3Client({
            region: "auto",
            endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId, secretAccessKey }
        });

        try {
            // 설치파일 exe 업로드 (Tauri Updater 자동업데이트용)
            console.log(`📤 Cloudflare R2에 ${installerFileName} 업로드 중...`);
            const exeStream = fs.createReadStream(installerPath);
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: installerFileName,
                Body: exeStream,
                ContentType: 'application/x-msdownload'
            }));

            // ZIP 파일 업로드 (홈페이지 포터블 다운로드용)
            console.log(`📤 Cloudflare R2에 ${zipFileName} 업로드 중...`);
            const zipStream = fs.createReadStream(zipPath);
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: zipFileName,
                Body: zipStream,
                ContentType: 'application/zip'
            }));

            // update.json 업로드
            console.log(`📤 Cloudflare R2에 update.json 업로드 중...`);
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: 'update.json', // Updater가 참조하는 고정 파일명
                Body: JSON.stringify(updateJson, null, 2),
                ContentType: 'application/json'
            }));

            console.log(`🎉 모든 릴리스 파일이 성공적으로 업로드되었습니다! 버전: ${version}`);
        } catch (err) {
            console.error("❌ R2 업로드 중 오류 발생:", err);
        }
    } else {
        console.log("⚠️ R2 인증 정보가 설정되지 않아 업로드를 건너뜁니다.");
    }
}

run();
